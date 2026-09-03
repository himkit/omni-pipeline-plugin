import { expect, test } from "bun:test"
import {
	grantClaim,
	ownerPrefix,
	qualify,
	sameOwner,
	takeoverClaim,
} from "../.opencode-plugin/plugins/omni-gatekeeper.ts"

test("qualify namespaces a bare id and leaves a qualified one alone", () => {
	expect(qualify("s1")).toBe("opencode-s1")
	expect(qualify("opencode-s1")).toBe("opencode-s1")
	expect(qualify("claude-s1")).toBe("claude-s1")
})

test("ownerPrefix attributes an unprefixed id to this host", () => {
	expect(ownerPrefix("claude-s1")).toBe("claude-")
	expect(ownerPrefix("opencode-s1")).toBe("opencode-")
	expect(ownerPrefix("bare-uuid-with-dashes")).toBe("opencode-")
})

test("sameOwner accepts qualified and legacy ids, rejects the other host", () => {
	expect(sameOwner("opencode-s1", "s1")).toBe(true)
	expect(sameOwner("s1", "s1")).toBe(true)
	expect(sameOwner("claude-s1", "s1")).toBe(false)
	expect(sameOwner(null, "s1")).toBe(false)
})

test("takeoverClaim honours a fresh, directory-matched request only", () => {
	const now = 1_800_000_000
	const fresh = { takeover_requested: now - 10, takeover_cwd: "/repo" }
	expect(takeoverClaim(fresh, "/repo", now)).toBe(true)
	expect(takeoverClaim(fresh, "/elsewhere", now)).toBe(false)
	expect(takeoverClaim({ ...fresh, takeover_requested: now - 400 }, "/repo", now)).toBe(false)
	expect(takeoverClaim({ takeover_requested: "junk" }, "/repo", now)).toBe(false)
	expect(takeoverClaim({}, "/repo", now)).toBe(false)
})

test("grantClaim moves ownership and records the previous owner", () => {
	const now = 1_800_000_000
	const state: Record<string, unknown> = {
		session_id: "opencode-dead",
		takeover_requested: now - 10,
		takeover_cwd: "/repo",
		adopt_offers: ["opencode-x"],
	}
	expect(grantClaim(state, "/repo", now, "opencode-alive")).toBe(true)
	expect(state.session_id).toBe("opencode-alive")
	expect(state.prev_owners).toEqual(["opencode-dead"])
	expect(state.takeover_requested).toBeUndefined()
	expect(state.takeover_cwd).toBeUndefined()
	expect(state.adopt_offers).toBeUndefined()
})

test("grantClaim refuses a run owned by the other host", () => {
	const now = 1_800_000_000
	const state: Record<string, unknown> = {
		session_id: "claude-dead",
		takeover_requested: now - 10,
		takeover_cwd: "/repo",
	}
	expect(grantClaim(state, "/repo", now, "opencode-alive")).toBe(false)
	expect(state.session_id).toBe("claude-dead")
})

test("taking a run back clears stale revocation bookkeeping", () => {
	const now = 1_800_000_000
	const state: Record<string, unknown> = {
		session_id: "opencode-b",
		prev_owners: ["opencode-a"],
		revoked_notified: ["opencode-a"],
		takeover_requested: now - 10,
		takeover_cwd: "/repo",
	}
	expect(grantClaim(state, "/repo", now, "opencode-a")).toBe(true)
	expect(state.prev_owners).toEqual(["opencode-b"])
	expect(state.revoked_notified).toEqual([])
})

test("a codex-owned id is attributed to codex, not to this host", () => {
	expect(ownerPrefix("codex-s1")).toBe("codex-")
	expect(qualify("codex-s1")).toBe("codex-s1")
	expect(sameOwner("codex-s1", "s1")).toBe(false)
})

test("grantClaim refuses a run owned by codex", () => {
	const now = 1_800_000_000
	const state: Record<string, unknown> = {
		session_id: "codex-dead",
		takeover_requested: now - 10,
		takeover_cwd: "/repo",
	}
	expect(grantClaim(state, "/repo", now, "opencode-alive")).toBe(false)
	expect(state.session_id).toBe("codex-dead")
})
