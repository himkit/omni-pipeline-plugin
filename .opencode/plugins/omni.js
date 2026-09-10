// .opencode/src/omni.ts
import * as fs from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
var RUNNING_PHASES = new Set(["planning", "implementing", "reviewing", "delivering"]);
var MAX_CONSECUTIVE_BLOCKS = 15;
var OMNI_HOME = process.env.OMNI_HOME || path.join(os.homedir(), ".omni-pipeline");
var RUNS_DIR = path.join(OMNI_HOME, "runs");
var FALLBACK_HOSTS = ["claude", "codex", "opencode"];
var REGISTRY_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../hosts/registry.json");
function loadRegistry(registryPath) {
  let hosts = [];
  let declared = {};
  try {
    const file = registryPath || process.env.OMNI_REGISTRY || REGISTRY_PATH;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [id, entry] of Object.entries(parsed)) {
        if (!id)
          continue;
        hosts.push(id);
        const prefix = entry?.prefix;
        if (typeof prefix === "string" && prefix)
          declared[id] = prefix;
      }
    }
  } catch {}
  if (!hosts.length) {
    hosts = [...FALLBACK_HOSTS];
    declared = {};
  }
  const prefixOf = (host) => declared[host] || `${host}-`;
  const prefixes = [];
  for (const host of hosts) {
    const prefix = prefixOf(host);
    if (!prefixes.includes(prefix))
      prefixes.push(prefix);
  }
  return { hosts, prefixes, prefixOf };
}
var REGISTRY = loadRegistry();
var HOST_PREFIX = REGISTRY.prefixOf("opencode");
var KNOWN_PREFIXES = REGISTRY.prefixes;
var TAKEOVER_TTL_SEC = 300;
async function readState(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}
async function writeState(file, state) {
  try {
    state.updated_at = new Date().toISOString();
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}
`, "utf8");
    await fs.rename(tmp, file);
  } catch {}
}
async function inside(cwd, base) {
  if (!cwd || !base)
    return false;
  try {
    const a = await fs.realpath(cwd);
    const b = await fs.realpath(base);
    return a === b || a.startsWith(b.replace(/\/+$/, "") + path.sep);
  } catch {
    return false;
  }
}
function runDirs(state) {
  const dirs = [state.workdir, state.repo];
  if (Array.isArray(state.targets)) {
    for (const target of state.targets) {
      if (target && typeof target === "object") {
        dirs.push(target.workdir, target.repo);
      }
    }
  }
  const out = [];
  for (const d of dirs) {
    if (typeof d === "string" && d && !out.includes(d))
      out.push(d);
  }
  return out;
}
function qualify(sid) {
  if (!sid)
    return sid;
  return KNOWN_PREFIXES.some((p) => sid.startsWith(p)) ? sid : HOST_PREFIX + sid;
}
function ownerPrefix(bound) {
  for (const p of KNOWN_PREFIXES)
    if (bound.startsWith(p))
      return p;
  return HOST_PREFIX;
}
function sameOwner(bound, sid) {
  if (!bound)
    return false;
  if (ownerPrefix(bound) !== HOST_PREFIX)
    return false;
  return bound === qualify(sid) || bound === sid;
}
function takeoverClaim(state, cwd, now) {
  const requested = Number(state.takeover_requested);
  if (!Number.isFinite(requested) || requested <= 0)
    return false;
  if (now - requested > TAKEOVER_TTL_SEC)
    return false;
  const bases = state.takeover_cwd ? [state.takeover_cwd] : runDirs(state);
  return bases.some((base) => {
    if (!base || !cwd)
      return false;
    const a = path.resolve(cwd);
    const b = path.resolve(base);
    return a === b || a.startsWith(b.replace(/\/+$/, "") + path.sep);
  });
}
function grantClaim(state, cwd, now, me) {
  const bound = state.session_id ?? null;
  if (!takeoverClaim(state, cwd, now))
    return false;
  if (bound !== null && ownerPrefix(bound) !== HOST_PREFIX)
    return false;
  if (bound && bound !== me) {
    state.prev_owners = (state.prev_owners ?? []).filter((o) => o !== bound).concat(bound);
  }
  if (state.prev_owners?.length)
    state.prev_owners = state.prev_owners.filter((o) => o !== me);
  if (state.revoked_notified?.length)
    state.revoked_notified = state.revoked_notified.filter((o) => o !== me);
  state.session_id = me;
  delete state.takeover_requested;
  delete state.takeover_cwd;
  delete state.adopt_offers;
  delete state.resume_cwd;
  return true;
}
function fingerprint(state) {
  return `${state.phase}|${state.task_index ?? 0}|${state.review_iter ?? 0}`;
}
function counter(state) {
  const n = Number(state.gk_blocks);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
var PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function pluginRoot() {
  return process.env.OMNI_PLUGIN_ROOT || PLUGIN_ROOT;
}
var ROLES = {
  orchestrator: {
    agent: "omnislash",
    mode: "primary",
    permission: {
      bash: "allow",
      edit: "allow",
      write: "allow",
      read: "allow",
      task: "allow",
      webfetch: "ask",
      external_directory: { "*": "ask", "~/.omni-pipeline/*": "allow", "~/.omni-pipeline/**": "allow" }
    }
  },
  planner: {
    agent: "omnislash-planner",
    mode: "subagent",
    tools: { read: true, grep: true, glob: true, list: true, bash: true, write: true, edit: false, task: false, webfetch: false }
  },
  implementer: {
    agent: "omnislash-implementer",
    mode: "subagent",
    tools: { read: true, grep: true, glob: true, list: true, bash: true, write: true, edit: true, task: false, webfetch: false },
    permission: { bash: "allow", edit: "allow", write: "allow" }
  },
  reviewer: {
    agent: "omnislash-reviewer",
    mode: "subagent",
    temperature: 0.1,
    tools: { read: true, grep: true, glob: true, list: true, bash: true, write: false, edit: false, task: false, webfetch: false }
  }
};
var CAST_DESCRIPTION = "Start an omnislash run — brainstorm the idea into a locked spec, then autonomous plan → implement (TDD) → review loop → deliver on a feature branch";
var CAST_TEMPLATE = [
  "Invoke the `cast` skill and follow it exactly, starting at Phase 0 (brainstorm) with this feature idea:",
  "",
  "$ARGUMENTS",
  "",
  "If no idea was given, ask for one before doing anything else.",
  "",
  "Reminders that override any competing habit:",
  "- Brainstorm is interactive; everything after spec approval + run-config is zero-touch — do not ask the human anything past that point.",
  "- The plugin re-prompts this session while the run is mid-pipeline. The only exits are done, blocked (with a written reason), or /omnislash:gg."
].join(`
`);
function splitFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m)
    return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0)
      meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2].trim() };
}
function buildRegistration(root = pluginRoot()) {
  const agents = {};
  for (const [role, cfg] of Object.entries(ROLES)) {
    const { meta, body } = splitFrontmatter(readFileSync(path.join(root, "agents", `${role}.md`), "utf8"));
    const entry = { prompt: body, mode: cfg.mode, description: meta.description };
    if (cfg.tools)
      entry.tools = cfg.tools;
    if (cfg.temperature !== undefined)
      entry.temperature = cfg.temperature;
    if (cfg.permission)
      entry.permission = cfg.permission;
    agents[cfg.agent] = entry;
  }
  const commands = {};
  for (const file of readdirSync(path.join(root, "commands")).filter((f) => f.endsWith(".md")).sort()) {
    const { meta, body } = splitFrontmatter(readFileSync(path.join(root, "commands", file), "utf8"));
    commands[`omnislash:${file.slice(0, -3)}`] = { template: body, description: meta.description, agent: "omnislash" };
  }
  commands["omnislash:cast"] = { template: CAST_TEMPLATE, description: CAST_DESCRIPTION, agent: "omnislash" };
  return { skillsPath: path.join(root, "skills"), agents, commands };
}
function applyRegistration(config, reg, warn) {
  config.skills = config.skills || {};
  config.skills.paths = config.skills.paths || [];
  if (!config.skills.paths.includes(reg.skillsPath))
    config.skills.paths.push(reg.skillsPath);
  config.agent = config.agent || {};
  for (const [name, entry] of Object.entries(reg.agents)) {
    if (name in config.agent) {
      warn(`agent "${name}" is already defined in your config; omnislash's definition was skipped`);
      continue;
    }
    config.agent[name] = entry;
  }
  config.command = config.command || {};
  for (const [name, entry] of Object.entries(reg.commands)) {
    if (name in config.command) {
      warn(`command "${name}" is already defined in your config; omnislash's definition was skipped`);
      continue;
    }
    config.command[name] = entry;
  }
}
var OmniPlugin = async ({ client, directory }) => {
  const processing = new Set;
  const log = async (message, level = "info") => {
    try {
      await client.app.log({ body: { service: "omnislash", level, message } });
    } catch {}
  };
  const nudge = (sessionID, text) => {
    client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } }).catch((err) => log(`nudge failed: ${String(err)}`, "warn"));
  };
  const isRootSession = async (sessionID) => {
    try {
      const session = await client.session.get({ path: { id: sessionID } });
      return !session.data?.parentID;
    } catch {
      return false;
    }
  };
  const handleIdle = async (sessionID) => {
    if (!sessionID)
      return;
    if (!await isRootSession(sessionID))
      return;
    let slugs;
    try {
      slugs = (await fs.readdir(RUNS_DIR)).sort();
    } catch {
      return;
    }
    const me = qualify(sessionID);
    const now = Math.floor(Date.now() / 1000);
    const enforceable = [];
    for (const slug of slugs) {
      const statePath = path.join(RUNS_DIR, slug, "state.json");
      const state = await readState(statePath);
      if (!state)
        continue;
      const phase = state.phase ?? "";
      if (!RUNNING_PHASES.has(phase) && phase !== "blocked")
        continue;
      if (grantClaim(state, directory, now, me))
        await writeState(statePath, state);
      if (RUNNING_PHASES.has(phase))
        enforceable.push({ slug, statePath, state });
    }
    for (const { slug, statePath, state } of enforceable) {
      const owner = state.session_id ?? null;
      if (!sameOwner(owner, sessionID) && (state.prev_owners ?? []).includes(me)) {
        const told = state.revoked_notified ?? [];
        if (told.includes(me))
          continue;
        state.revoked_notified = told.concat(me);
        await writeState(statePath, state);
        nudge(sessionID, `[omni gatekeeper] Run '${slug}' now belongs to session ${state.session_id}. ` + `You no longer own it: spawn nothing, write nothing under ${runDirs(state).join(", ") || state.workdir}. ` + `Tell the user it moved, then rest — you will not be nudged again.`);
        return;
      }
      if (owner === null) {
        const offers = state.adopt_offers ?? [];
        if (offers.includes(me) || offers.includes(sessionID))
          continue;
        const bases = [...runDirs(state), state.resume_cwd];
        let matches = false;
        for (const base of bases) {
          if (await inside(directory, base)) {
            matches = true;
            break;
          }
        }
        if (!matches)
          continue;
        offers.push(me);
        state.adopt_offers = offers;
        await writeState(statePath, state);
        nudge(sessionID, `[omni gatekeeper] Unbound run '${slug}' (phase=${state.phase}) is in this ` + `session's directory. If you are its orchestrator, claim it: add ` + `"takeover_requested" (\`date +%s\`) and "takeover_cwd" (\`pwd\`) to ` + `${statePath}, then rest — this plugin writes the session id itself and ` + `comes back with your next action ` + `(${state.next_action || "read state.json and plan.md in the run dir"}). ` + `If this is not your pipeline, ignore this; it will not nudge you twice.`);
        return;
      }
      if (!sameOwner(owner, sessionID))
        continue;
      delete state.adopt_offers;
      delete state.resume_cwd;
      const fp = fingerprint(state);
      const blocks = state.gk_fingerprint !== fp ? 1 : counter(state) + 1;
      state.gk_fingerprint = fp;
      state.gk_blocks = blocks;
      state.stop_blocks = blocks;
      if (blocks > MAX_CONSECUTIVE_BLOCKS) {
        state.phase = "blocked";
        state.blocked_reason = `gatekeeper safety valve: ${MAX_CONSECUTIVE_BLOCKS} consecutive nudges with no ` + `progress past ${fp} (phase|task_index|review_iter)`;
        await writeState(statePath, state);
        await log(`run '${slug}' auto-blocked by safety valve. Inspect ${statePath} and resume with /omnislash:reconnect.`, "warn");
        return;
      }
      await writeState(statePath, state);
      nudge(sessionID, `[omni gatekeeper] Run '${slug}' is mid-pipeline: phase=${state.phase}, ` + `task ${state.task_index ?? 0}/${state.task_total ?? "?"}, ` + `review iter ${state.review_iter ?? 0}. Next action: ` + `${state.next_action || "read plan.md and state.json in the run dir, continue from there"}. ` + `Do NOT stop — continue the pipeline now, following the cast skill. If that ` + `next action is already in flight (an agent you spawned has not returned yet), do ` + `NOT spawn it again — spawn subagents in the foreground so the turn ends only ` + `after they return. If you are ` + `genuinely blocked on something only a human can decide, set "phase": "blocked" with ` + `a blocked_reason in ${statePath}, explain it to the user, and then you may rest.`);
      return;
    }
  };
  await log(`armed — watching ${RUNS_DIR}`, "debug");
  return {
    config: async (config) => {
      try {
        applyRegistration(config, buildRegistration(), (m) => void log(m, "warn"));
      } catch (err) {
        await log(`registration failed: ${String(err)}`, "warn");
      }
    },
    event: async ({ event }) => {
      try {
        if (event.type === "session.idle") {
          const sessionID = event.properties.sessionID;
          if (!sessionID || processing.has(sessionID))
            return;
          processing.add(sessionID);
          try {
            await handleIdle(sessionID);
          } finally {
            processing.delete(sessionID);
          }
        }
      } catch (err) {
        await log(`event handler error: ${String(err)}`, "warn");
      }
    }
  };
};
export {
  OmniPlugin
};
