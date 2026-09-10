import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { applyRegistration, buildRegistration, OmniPlugin } from "../.opencode/plugins/omni.ts"

const ROOT = resolve(import.meta.dir, "..")

test("buildRegistration reads the four agents and gives them opencode roles", () => {
	const reg = buildRegistration(ROOT)
	expect(reg.skillsPath).toBe(resolve(ROOT, "skills"))
	expect(Object.keys(reg.agents).sort()).toEqual(["omnislash", "omnislash-implementer", "omnislash-planner", "omnislash-reviewer"])
	expect(reg.agents["omnislash"].mode).toBe("primary")
	expect(reg.agents["omnislash"].permission).toMatchObject({ bash: "allow", edit: "allow", write: "allow", task: "allow" })
	expect(reg.agents["omnislash"].prompt).toContain("You are the omnislash orchestrator.")
	expect(reg.agents["omnislash"].prompt).not.toContain("name: orchestrator")
	expect(reg.agents["omnislash-planner"].mode).toBe("subagent")
	expect(reg.agents["omnislash-reviewer"].temperature).toBe(0.1)
	expect(reg.agents["omnislash-planner"].description).toContain("omnislash planner")
})

// opencode's `tools` map is a per-tool override on a default-enabled set, so an
// allow-only map restricts nothing. The denials are the whole point.
test("each role's tools map denies what that role must not do", () => {
	const reg = buildRegistration(ROOT)
	const planner = reg.agents["omnislash-planner"].tools!
	expect(planner.edit).toBe(false)
	expect(planner.task).toBe(false)
	expect(planner.webfetch).toBe(false)
	expect(planner.read).toBe(true)
	expect(planner.bash).toBe(true)
	expect(planner.write).toBe(true)

	const reviewer = reg.agents["omnislash-reviewer"].tools!
	expect(reviewer.write).toBe(false)
	expect(reviewer.edit).toBe(false)
	expect(reviewer.task).toBe(false)
	expect(reviewer.webfetch).toBe(false)
	expect(reviewer.read).toBe(true)
	expect(reviewer.bash).toBe(true)

	const implementer = reg.agents["omnislash-implementer"].tools!
	expect(implementer.task).toBe(false)
	expect(implementer.webfetch).toBe(false)
	expect(implementer.read).toBe(true)
	expect(implementer.bash).toBe(true)
	expect(implementer.write).toBe(true)
	expect(implementer.edit).toBe(true)
})

test("the implementer carries its permission block; the planner and reviewer have none", () => {
	const reg = buildRegistration(ROOT)
	expect(reg.agents["omnislash-implementer"].permission).toEqual({ bash: "allow", edit: "allow", write: "allow" })
	expect(reg.agents["omnislash-planner"].permission).toBeUndefined()
	expect(reg.agents["omnislash-reviewer"].permission).toBeUndefined()
})

test("buildRegistration turns commands/*.md into command templates bound to the omnislash agent", () => {
	const reg = buildRegistration(ROOT)
	expect(Object.keys(reg.commands).sort()).toEqual(["omnislash:cast", "omnislash:gg", "omnislash:reconnect", "omnislash:scoreboard"])
	expect(reg.commands["omnislash:cast"].agent).toBe("omnislash")
	expect(reg.commands["omnislash:cast"].template).toContain("$ARGUMENTS")
	expect(reg.commands["omnislash:cast"].template).not.toContain("argument-hint")
	expect(reg.commands["omnislash:scoreboard"].description).toContain("Scoreboard")
})

test("applyRegistration fills an empty config", () => {
	const config: Record<string, any> = {}
	const warnings: string[] = []
	applyRegistration(config, buildRegistration(ROOT), (m) => warnings.push(m))
	expect(config.skills.paths).toEqual([resolve(ROOT, "skills")])
	expect(Object.keys(config.agent).sort()).toEqual(["omnislash", "omnislash-implementer", "omnislash-planner", "omnislash-reviewer"])
	expect(Object.keys(config.command).sort()).toEqual(["omnislash:cast", "omnislash:gg", "omnislash:reconnect", "omnislash:scoreboard"])
	expect(warnings).toEqual([])
})

test("applyRegistration leaves a user's own entries alone and warns", () => {
	const mine = { prompt: "mine", mode: "subagent" }
	const config: Record<string, any> = {
		skills: { paths: [resolve(ROOT, "skills")] },
		agent: { "omnislash-planner": mine },
		command: { "omnislash:scoreboard": { template: "mine" } },
	}
	const warnings: string[] = []
	applyRegistration(config, buildRegistration(ROOT), (m) => warnings.push(m))
	expect(config.agent["omnislash-planner"]).toBe(mine)
	expect(config.command["omnislash:scoreboard"]).toEqual({ template: "mine" })
	expect(config.skills.paths).toEqual([resolve(ROOT, "skills")])
	expect(warnings.length).toBe(2)
	expect(warnings[0]).toContain("omnislash-planner")
})

// The gatekeeper is the reason this plugin exists; registration is a bonus. A
// broken checkout must cost the config, never the enforcement.
test("a failed registration is caught, logged, and leaves the config untouched", async () => {
	expect(() => buildRegistration("/nonexistent")).toThrow()

	const messages: string[] = []
	const client = {
		app: { log: async ({ body }: any) => void messages.push(String(body?.message)) },
		session: { get: async () => ({ data: {} }), prompt: async () => ({}) },
	}
	const previous = process.env.OMNI_PLUGIN_ROOT
	process.env.OMNI_PLUGIN_ROOT = "/nonexistent"
	try {
		const hooks = await (OmniPlugin as any)({ client, directory: ROOT })
		const config: Record<string, any> = {}
		await hooks.config(config)
		expect(config).toEqual({})
		expect(messages.some((m) => m.includes("registration failed"))).toBe(true)
	} finally {
		if (previous === undefined) delete process.env.OMNI_PLUGIN_ROOT
		else process.env.OMNI_PLUGIN_ROOT = previous
	}
})
