/**
 * omni — opencode plugin: registers the pipeline and enforces it on idle.
 *
 * Claude Code blocks a session from stopping. opencode has no equivalent, so
 * this plugin listens for `session.idle` and re-prompts the session instead:
 * the run keeps moving after the model goes quiet, which is the same outcome
 * by a different mechanism.
 *
 * Design rules (unchanged from hooks/gatekeeper.py):
 * - FAIL-OPEN: any error, missing file, or bad JSON leaves the session alone.
 *   A broken gatekeeper must never trap a session.
 * - Ownership handshake: never adopt a session on its own. For an unbound run
 *   (session_id null) whose repo/workdir, any target's repo/workdir, or
 *   resume_cwd (written by /omni-resume) contains this session's directory,
 *   nudge ONCE with an offer naming this session's id; the orchestrator binds
 *   by writing that id into state.json itself. A session that ignores the
 *   offer is never nudged by that run again (tracked in adopt_offers).
 * - Safety valve, gatekeeper-enforced: the nudge counter (`gk_blocks`) and the
 *   progress signature it is keyed to (`gk_fingerprint`) are owned and written
 *   by this plugin alone, never read back from what the orchestrator wrote. The
 *   counter resets only when `phase`/`task_index`/`review_iter` actually
 *   advance, so a model that rewrites state on an idle turn cannot disarm the
 *   valve. MAX_CONSECUTIVE_BLOCKS nudges without real progress force-mark the
 *   run blocked and let the session rest. `stop_blocks` is a display mirror for
 *   /omni-status: written here, never trusted here.
 *
 * State lives in ~/.omni-pipeline/runs/, shared with Claude Code, so
 * /omni-status and /omni-resume see the same runs from either host.
 */

import * as fs from "node:fs/promises"
import { readFileSync, readdirSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode-ai/plugin"

const RUNNING_PHASES = new Set(["planning", "implementing", "reviewing", "delivering"])
const MAX_CONSECUTIVE_BLOCKS = 15
const OMNI_HOME = process.env.OMNI_HOME || path.join(os.homedir(), ".omni-pipeline")
const RUNS_DIR = path.join(OMNI_HOME, "runs")
// This plugin only ever runs inside opencode, so which host it is is fixed;
// the prefix that host writes is not — hosts/registry.json declares it. The
// known set is not fixed either: Claude Code, Codex (via its plugin hook
// manifest) and opencode all share the runs dir, and an id whose prefix is
// missing here would be attributed to whoever read it — letting one host take
// over another's run.
const FALLBACK_HOSTS = ["claude", "codex", "opencode"]
const REGISTRY_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../hosts/registry.json",
)

/** Hosts and their session-id prefixes from hosts/registry.json; the builtin
 *  three with `<id>-` prefixes if it is unreadable. OMNI_REGISTRY overrides the
 *  path, as it does on the Python side.
 *
 *  The prefix is the registry's to declare — a host whose product name differs
 *  from its registry key says so there — and `<id>-` is only the fallback.
 *
 *  FAIL-OPEN like everything else here: a broken registry must not disarm the
 *  gatekeeper, and it must not let one host adopt another's run either — the
 *  fallback is exactly the set that was hard-coded before the registry. */
export function loadRegistry(registryPath?: string): {
	hosts: string[]
	prefixes: string[]
	prefixOf: (host: string) => string
} {
	let hosts: string[] = []
	let declared: Record<string, string> = {}
	try {
		const file = registryPath || process.env.OMNI_REGISTRY || REGISTRY_PATH
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
				if (!id) continue
				hosts.push(id)
				const prefix = (entry as { prefix?: unknown } | null)?.prefix
				if (typeof prefix === "string" && prefix) declared[id] = prefix
			}
		}
	} catch {
		// fall through
	}
	if (!hosts.length) {
		hosts = [...FALLBACK_HOSTS]
		declared = {}
	}
	const prefixOf = (host: string): string => declared[host] || `${host}-`
	const prefixes: string[] = []
	for (const host of hosts) {
		const prefix = prefixOf(host)
		if (!prefixes.includes(prefix)) prefixes.push(prefix)
	}
	return { hosts, prefixes, prefixOf }
}

/** Host ids only — the shape the gatekeeper's callers used before prefixes
 *  came out of the registry. */
export function loadKnownHosts(registryPath?: string): string[] {
	return loadRegistry(registryPath).hosts
}

const REGISTRY = loadRegistry()
// This plugin only ever runs inside opencode, so its own prefix is the one the
// registry declares for that host (`opencode-` when the registry is unreadable).
const HOST_PREFIX = REGISTRY.prefixOf("opencode")
const KNOWN_PREFIXES = REGISTRY.prefixes
const TAKEOVER_TTL_SEC = 300

type RunTarget = {
	name?: string
	repo?: string
	workdir?: string
	isolation?: string // "worktree" | "in-place"
	branch?: string
	base_branch?: string
	test_command?: string
}

type RunState = {
	phase?: string
	session_id?: string | null
	prev_owners?: string[]
	revoked_notified?: string[]
	takeover_requested?: number | string | null
	takeover_cwd?: string | null
	adopt_offers?: string[]
	resume_cwd?: string
	workdir?: string
	repo?: string
	targets?: RunTarget[]
	next_action?: string | null
	blocked_reason?: string | null
	stop_blocks?: number
	gk_blocks?: number
	gk_fingerprint?: string
	task_index?: number
	task_total?: number | string
	review_iter?: number
	updated_at?: string
}

async function readState(file: string): Promise<RunState | null> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8")) as RunState
	} catch {
		return null
	}
}

async function writeState(file: string, state: RunState): Promise<void> {
	try {
		state.updated_at = new Date().toISOString()
		const tmp = `${file}.tmp`
		await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8")
		await fs.rename(tmp, file)
	} catch {
		// fail-open
	}
}

/** True if cwd is base or under it, symlink-safe (/tmp vs /private/tmp). */
async function inside(cwd: string, base?: string): Promise<boolean> {
	if (!cwd || !base) return false
	try {
		const a = await fs.realpath(cwd)
		const b = await fs.realpath(base)
		return a === b || a.startsWith(b.replace(/\/+$/, "") + path.sep)
	} catch {
		return false
	}
}

/** Every directory a run lives in: the primary workdir/repo pair, then each
 *  target's workdir and repo. Ordered, deduplicated, non-string entries
 *  dropped. A malformed `targets` contributes nothing — fail-open. */
export function runDirs(state: RunState): string[] {
	const dirs: unknown[] = [state.workdir, state.repo]
	if (Array.isArray(state.targets)) {
		for (const target of state.targets) {
			if (target && typeof target === "object") {
				dirs.push(target.workdir, target.repo)
			}
		}
	}
	const out: string[] = []
	for (const d of dirs) {
		if (typeof d === "string" && d && !out.includes(d)) out.push(d)
	}
	return out
}

/** This host's session id, namespaced so two hosts sharing the runs dir can
 *  never be mistaken for each other. */
export function qualify(sid: string): string {
	if (!sid) return sid
	return KNOWN_PREFIXES.some((p) => sid.startsWith(p)) ? sid : HOST_PREFIX + sid
}

/** Which host wrote `bound`. An id with no known prefix predates prefixing, so
 *  it belongs to whoever is reading it. */
export function ownerPrefix(bound: string): string {
	for (const p of KNOWN_PREFIXES) if (bound.startsWith(p)) return p
	return HOST_PREFIX
}

/** True if `bound` names this very session, prefixed or legacy. */
export function sameOwner(bound: string | null | undefined, sid: string): boolean {
	if (!bound) return false
	if (ownerPrefix(bound) !== HOST_PREFIX) return false
	return bound === qualify(sid) || bound === sid
}

/** True if a fresh, directory-matched /omni-resume request should hand this
 *  session the run.
 *
 *  Never a liveness guess: nothing here asks whether the old owner is alive,
 *  because no event fires while a subagent runs and a busy session is
 *  indistinguishable from a dead one. A human asked for this handover.
 *
 *  Synchronous containment on purpose — this stays pure so it can be tested. */
export function takeoverClaim(state: RunState, cwd: string, now: number): boolean {
	const requested = Number(state.takeover_requested)
	if (!Number.isFinite(requested) || requested <= 0) return false
	if (now - requested > TAKEOVER_TTL_SEC) return false
	const bases = state.takeover_cwd ? [state.takeover_cwd] : runDirs(state)
	return bases.some((base) => {
		if (!base || !cwd) return false
		const a = path.resolve(cwd)
		const b = path.resolve(base)
		return a === b || a.startsWith(b.replace(/\/+$/, "") + path.sep)
	})
}

/** Hand `me` the run if a fresh, directory-matched request asks for it.
 *
 *  Mutates `state`; returns true when ownership actually moved. Taking a run
 *  back also clears this session out of the revocation bookkeeping, so a later
 *  handover away from it is announced again instead of being swallowed. */
export function grantClaim(state: RunState, cwd: string, now: number, me: string): boolean {
	const bound = state.session_id ?? null
	if (!takeoverClaim(state, cwd, now)) return false
	if (bound !== null && ownerPrefix(bound) !== HOST_PREFIX) return false
	if (bound && bound !== me) {
		state.prev_owners = (state.prev_owners ?? []).filter((o) => o !== bound).concat(bound)
	}
	if (state.prev_owners?.length) state.prev_owners = state.prev_owners.filter((o) => o !== me)
	if (state.revoked_notified?.length)
		state.revoked_notified = state.revoked_notified.filter((o) => o !== me)
	state.session_id = me
	delete state.takeover_requested
	delete state.takeover_cwd
	delete state.adopt_offers
	delete state.resume_cwd
	return true
}

/** Signature of real pipeline progress. Changes only when the orchestrator moves
 *  the state machine forward, which is what makes the nudge counter meaningful
 *  without trusting the model. */
function fingerprint(state: RunState): string {
	return `${state.phase}|${state.task_index ?? 0}|${state.review_iter ?? 0}`
}

function counter(state: RunState): number {
	const n = Number(state.gk_blocks)
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

/** Where the host-neutral body (`agents/`, `commands/`, `skills/`) lives.
 *  OMNI_PLUGIN_ROOT overrides it the way OMNI_REGISTRY overrides the registry
 *  path: the fail-open wrapper around registration is only testable if the
 *  root can be made unreadable. */
function pluginRoot(): string {
	return process.env.OMNI_PLUGIN_ROOT || PLUGIN_ROOT
}

type AgentConfigLike = {
	description?: string
	prompt: string
	mode: "primary" | "subagent"
	temperature?: number
	tools?: Record<string, boolean>
	permission?: Record<string, unknown>
}
type CommandLike = { template: string; description?: string; agent?: string }
type ConfigLike = {
	skills?: { paths?: string[] }
	agent?: Record<string, unknown>
	command?: Record<string, unknown>
}

/** The only opencode-specific facts about each role. Bodies come from agents/. */
const ROLES: Record<string, { agent: string; mode: "primary" | "subagent"; tools?: Record<string, boolean>; temperature?: number; permission?: Record<string, unknown> }> = {
	orchestrator: {
		agent: "omni",
		mode: "primary",
		permission: {
			bash: "allow",
			edit: "allow",
			write: "allow",
			read: "allow",
			task: "allow",
			webfetch: "ask",
			// The run directory and worktrees live outside the project, and the
			// pipeline is zero-touch — an external_directory prompt there would
			// stall the run.
			external_directory: { "*": "ask", "~/.omni-pipeline/*": "allow", "~/.omni-pipeline/**": "allow" },
		},
	},
	// `tools` is a per-tool override on a default-enabled set, so the `false`
	// entries are what actually restrict a role — an allow-only map restricts
	// nothing. Keep the denials: the planner and the reviewer must not spawn
	// subagents or reach the network, and the reviewer must not write at all.
	planner: {
		agent: "omni-planner",
		mode: "subagent",
		tools: { read: true, grep: true, glob: true, list: true, bash: true, write: true, edit: false, task: false, webfetch: false },
	},
	implementer: {
		agent: "omni-implementer",
		mode: "subagent",
		tools: { read: true, grep: true, glob: true, list: true, bash: true, write: true, edit: true, task: false, webfetch: false },
		// The implementer is the only role that changes the tree, and the run is
		// zero-touch: a permission prompt mid-TDD would stall it.
		permission: { bash: "allow", edit: "allow", write: "allow" },
	},
	reviewer: {
		agent: "omni-reviewer",
		mode: "subagent",
		temperature: 0.1,
		tools: { read: true, grep: true, glob: true, list: true, bash: true, write: false, edit: false, task: false, webfetch: false },
	},
}

function splitFrontmatter(text: string): { meta: Record<string, string>; body: string } {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
	if (!m) return { meta: {}, body: text.trim() }
	const meta: Record<string, string> = {}
	for (const line of m[1].split(/\r?\n/)) {
		const i = line.indexOf(":")
		if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
	}
	return { meta, body: m[2].trim() }
}

export function buildRegistration(root: string = pluginRoot()) {
	const agents: Record<string, AgentConfigLike> = {}
	for (const [role, cfg] of Object.entries(ROLES)) {
		const { meta, body } = splitFrontmatter(readFileSync(path.join(root, "agents", `${role}.md`), "utf8"))
		const entry: AgentConfigLike = { prompt: body, mode: cfg.mode, description: meta.description }
		if (cfg.tools) entry.tools = cfg.tools
		if (cfg.temperature !== undefined) entry.temperature = cfg.temperature
		if (cfg.permission) entry.permission = cfg.permission
		agents[cfg.agent] = entry
	}
	const commands: Record<string, CommandLike> = {}
	for (const file of readdirSync(path.join(root, "commands")).filter((f) => f.endsWith(".md")).sort()) {
		const { meta, body } = splitFrontmatter(readFileSync(path.join(root, "commands", file), "utf8"))
		commands[file.slice(0, -3)] = { template: body, description: meta.description, agent: "omni" }
	}
	return { skillsPath: path.join(root, "skills"), agents, commands }
}

/** Mutates `config` in place. Existing user entries win and are reported. */
export function applyRegistration(
	config: ConfigLike,
	reg: ReturnType<typeof buildRegistration>,
	warn: (message: string) => void,
): void {
	config.skills = config.skills || {}
	config.skills.paths = config.skills.paths || []
	if (!config.skills.paths.includes(reg.skillsPath)) config.skills.paths.push(reg.skillsPath)
	config.agent = config.agent || {}
	for (const [name, entry] of Object.entries(reg.agents)) {
		if (name in config.agent) {
			warn(`agent "${name}" is already defined in your config; omni's definition was skipped`)
			continue
		}
		config.agent[name] = entry
	}
	config.command = config.command || {}
	for (const [name, entry] of Object.entries(reg.commands)) {
		if (name in config.command) {
			warn(`command "${name}" is already defined in your config; omni's definition was skipped`)
			continue
		}
		config.command[name] = entry
	}
}

export const OmniPlugin: Plugin = async ({ client, directory }) => {
	/** Sessions currently inside handleIdle — guards against re-entry only.
	 *  Deliberately NOT a "nudge outstanding" flag: opencode emits session.idle
	 *  for a nudge's own turn BEFORE the prompt call resolves, so keying off the
	 *  in-flight prompt would swallow the very event that keeps the run moving,
	 *  and the gatekeeper would nudge exactly once and then go silent. */
	const processing = new Set<string>()

	const log = async (message: string, level: "debug" | "info" | "warn" = "info") => {
		try {
			await client.app.log({ body: { service: "omni", level, message } })
		} catch {
			// fail-open
		}
	}

	/** Re-prompt the session. Fire-and-forget: awaiting would block the event loop
	 *  until the whole next turn finishes. */
	const nudge = (sessionID: string, text: string) => {
		void client.session
			.prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } })
			.catch((err: unknown) => log(`nudge failed: ${String(err)}`, "warn"))
	}

	/** Root sessions only — subagent sessions go idle constantly and must be ignored. */
	const isRootSession = async (sessionID: string): Promise<boolean> => {
		try {
			const session = await client.session.get({ path: { id: sessionID } })
			return !session.data?.parentID
		} catch {
			return false
		}
	}

	const handleIdle = async (sessionID: string): Promise<void> => {
		if (!sessionID) return
		if (!(await isRootSession(sessionID))) return

		let slugs: string[]
		try {
			slugs = (await fs.readdir(RUNS_DIR)).sort()
		} catch {
			return // no runs dir — nothing to enforce
		}

		const me = qualify(sessionID)
		const now = Math.floor(Date.now() / 1000)

		// Pass 1 — grant handovers on EVERY run before deciding anything. The
		// decision pass returns on the first run it acts on, so a claim on a run
		// further down the list would otherwise be starved by an unrelated one. A
		// `blocked` run is claimable too: that is the commonest thing /omni-resume
		// is pointed at, and ownership has to move before the phase can be restored.
		const enforceable: Array<{ slug: string; statePath: string; state: RunState }> = []
		for (const slug of slugs) {
			const statePath = path.join(RUNS_DIR, slug, "state.json")
			const state = await readState(statePath)
			if (!state) continue
			const phase = state.phase ?? ""
			if (!RUNNING_PHASES.has(phase) && phase !== "blocked") continue
			if (grantClaim(state, directory, now, me)) await writeState(statePath, state)
			if (RUNNING_PHASES.has(phase)) enforceable.push({ slug, statePath, state })
		}

		// Pass 2 — enforce. A blocked run never reaches here: it must never trap
		// a session, whoever owns it.
		for (const { slug, statePath, state } of enforceable) {
			const owner = state.session_id ?? null

			// Ownership moved while this session was mid-turn. Say so once — a
			// session that keeps spawning agents into a worktree it no longer
			// owns is the one failure this whole handover is meant to prevent.
			if (!sameOwner(owner, sessionID) && (state.prev_owners ?? []).includes(me)) {
				const told = state.revoked_notified ?? []
				if (told.includes(me)) continue
				state.revoked_notified = told.concat(me)
				await writeState(statePath, state)
				nudge(
					sessionID,
					`[omni gatekeeper] Run '${slug}' now belongs to session ${state.session_id}. ` +
						`You no longer own it: spawn nothing, write nothing under ${runDirs(state).join(", ") || state.workdir}. ` +
						`Tell the user it moved, then rest — you will not be nudged again.`,
				)
				return
			}

			if (owner === null) {
				const offers = state.adopt_offers ?? []
				if (offers.includes(me) || offers.includes(sessionID)) continue // offered before
				const bases = [...runDirs(state), state.resume_cwd]
				let matches = false
				for (const base of bases) {
					if (await inside(directory, base)) {
						matches = true
						break
					}
				}
				if (!matches) continue

				offers.push(me)
				state.adopt_offers = offers
				await writeState(statePath, state)
				nudge(
					sessionID,
					`[omni gatekeeper] Unbound run '${slug}' (phase=${state.phase}) is in this ` +
						`session's directory. If you are its orchestrator, claim it: add ` +
						`"takeover_requested" (\`date +%s\`) and "takeover_cwd" (\`pwd\`) to ` +
						`${statePath}, then rest — this plugin writes the session id itself and ` +
						`comes back with your next action ` +
						`(${state.next_action || "read state.json and plan.md in the run dir"}). ` +
						`If this is not your pipeline, ignore this; it will not nudge you twice.`,
				)
				return
			}

			if (!sameOwner(owner, sessionID)) continue

			// Bound to this session: handshake leftovers are no longer needed.
			delete state.adopt_offers
			delete state.resume_cwd

			// Gatekeeper-owned counter. Reset happens here, on observed progress —
			// never because the orchestrator zeroed a field.
			const fp = fingerprint(state)
			const blocks = state.gk_fingerprint !== fp ? 1 : counter(state) + 1
			state.gk_fingerprint = fp
			state.gk_blocks = blocks
			state.stop_blocks = blocks // display mirror for /omni-status

			if (blocks > MAX_CONSECUTIVE_BLOCKS) {
				state.phase = "blocked"
				state.blocked_reason =
					`gatekeeper safety valve: ${MAX_CONSECUTIVE_BLOCKS} consecutive nudges with no ` +
					`progress past ${fp} (phase|task_index|review_iter)`
				await writeState(statePath, state)
				await log(
					`run '${slug}' auto-blocked by safety valve. Inspect ${statePath} and resume with /omni-resume.`,
					"warn",
				)
				return
			}

			await writeState(statePath, state)
			nudge(
				sessionID,
				`[omni gatekeeper] Run '${slug}' is mid-pipeline: phase=${state.phase}, ` +
					`task ${state.task_index ?? 0}/${state.task_total ?? "?"}, ` +
					`review iter ${state.review_iter ?? 0}. Next action: ` +
					`${state.next_action || "read plan.md and state.json in the run dir, continue from there"}. ` +
					`Do NOT stop — continue the pipeline now, following the pipeline skill. If that ` +
					`next action is already in flight (an agent you spawned has not returned yet), do ` +
					`NOT spawn it again — spawn subagents in the foreground so the turn ends only ` +
					`after they return. If you are ` +
					`genuinely blocked on something only a human can decide, set "phase": "blocked" with ` +
					`a blocked_reason in ${statePath}, explain it to the user, and then you may rest.`,
			)
			return
		}
	}

	await log(`armed — watching ${RUNS_DIR}`, "debug")

	return {
		config: async (config) => {
			try {
				applyRegistration(config as ConfigLike, buildRegistration(), (m) => void log(m, "warn"))
			} catch (err) {
				await log(`registration failed: ${String(err)}`, "warn") // fail-open: the gatekeeper still arms
			}
		},
		event: async ({ event }) => {
			try {
				if (event.type === "session.idle") {
					const sessionID = (event.properties as { sessionID?: string }).sessionID
					if (!sessionID || processing.has(sessionID)) return
					processing.add(sessionID)
					try {
						await handleIdle(sessionID)
					} finally {
						processing.delete(sessionID)
					}
				}
			} catch (err) {
				await log(`event handler error: ${String(err)}`, "warn") // fail-open
			}
		},
	}
}
