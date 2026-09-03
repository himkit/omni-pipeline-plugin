import { expect, test } from "bun:test"
// @ts-expect-error — install.mjs is plain JS on purpose (it runs under bare npx).
import { checkoutComplaint } from "../install.mjs"

const clean = { ref: null, dirty: "", detached: false, upstream: "origin/main", ahead: 0, behind: 0 }

test("a clean checkout tracking its upstream is not complained about", () => {
	expect(checkoutComplaint(clean)).toBeNull()
})

test("uncommitted changes are named, with the files listed", () => {
	const c = checkoutComplaint({ ...clean, dirty: " M install.mjs\n?? scratch.txt" })
	expect(c).toContain("uncommitted changes")
	expect(c).toContain("install.mjs")
})

// The failure that shipped: the checkout sat on a branch whose remote had been
// deleted, so `pull --ff-only` failed, the installer shrugged and wired every
// host to months-old code.
test("a branch with no upstream is a hard failure, not a shrug", () => {
	const c = checkoutComplaint({ ...clean, upstream: null })
	expect(c).toBeTruthy()
	expect(c).toContain("no upstream")
})

test("a detached HEAD with no ref asked for is a hard failure", () => {
	const c = checkoutComplaint({ ...clean, detached: true, upstream: null })
	expect(c).toBeTruthy()
	expect(c).toContain("detached")
})

test("commits behind the upstream are refused — that is stale code", () => {
	const c = checkoutComplaint({ ...clean, behind: 3 })
	expect(c).toContain("3 commit(s) behind")
})

test("local commits ahead of the upstream are refused", () => {
	const c = checkoutComplaint({ ...clean, ahead: 2 })
	expect(c).toContain("2 commit(s) ahead")
})

test("an explicitly requested ref may be detached and upstreamless", () => {
	expect(checkoutComplaint({ ...clean, ref: "v0.4.0", detached: true, upstream: null })).toBeNull()
})

test("an explicitly requested ref is still refused when the tree is dirty", () => {
	const c = checkoutComplaint({ ...clean, ref: "v0.4.0", detached: true, upstream: null, dirty: " M hooks/gatekeeper.py" })
	expect(c).toContain("uncommitted changes")
})

test("every complaint says where the checkout is and how to reset it", () => {
	for (const facts of [
		{ ...clean, upstream: null },
		{ ...clean, behind: 1 },
		{ ...clean, dirty: " M install.mjs" },
	]) {
		const c = checkoutComplaint(facts) as string
		expect(c).toContain("git -C")
		expect(c).toContain("Nothing was wired")
	}
})

// --- --dry-run -------------------------------------------------------------

// @ts-expect-error — install.mjs is plain JS on purpose.
import { dryRunPlan, parseArgs } from "../install.mjs"

test("--dry-run parses, and is off unless asked for", () => {
	expect(parseArgs(["--dry-run"]).dryRun).toBe(true)
	expect(parseArgs([]).dryRun).toBe(false)
	expect(parseArgs(["--dry-run", "--hosts", "claude"]).hosts).toEqual(["claude"])
})

const src = "/home/u/.omni-pipeline/src"

test("the install plan names every host's real target, and writes nothing", () => {
	const lines = dryRunPlan({ chosen: ["claude", "codex", "opencode"], src, uninstall: false, exists: true }).join("\n")
	expect(lines).toContain("claude plugin marketplace add")
	expect(lines).toContain("hooks.json")
	expect(lines).toContain("OMNI_HOST=codex")
	expect(lines).toContain("omni-gatekeeper.ts")
	expect(lines).toContain("skills/pipeline")
	expect(lines).toContain("nothing was written")
})

test("the plan says update when the checkout exists and clone when it does not", () => {
	expect(dryRunPlan({ chosen: ["claude"], src, uninstall: false, exists: true }).join("\n")).toContain("would update")
	expect(dryRunPlan({ chosen: ["claude"], src, uninstall: false, exists: false }).join("\n")).toContain("would clone")
})

test("a host that was not chosen is absent from the plan", () => {
	const lines = dryRunPlan({ chosen: ["claude"], src, uninstall: false, exists: true }).join("\n")
	expect(lines).not.toContain("OMNI_HOST=codex")
	expect(lines).not.toContain("omni-gatekeeper.ts")
})

test("the uninstall plan describes removals, not installs", () => {
	const lines = dryRunPlan({ chosen: ["codex", "opencode"], src, uninstall: true, exists: true }).join("\n")
	expect(lines).toContain("would remove")
	expect(lines).not.toContain("marketplace add")
	expect(lines).toContain("nothing was written")
})
