import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { applyRegistration, buildRegistration } from "../.opencode/plugins/omni.ts"

const ROOT = resolve(import.meta.dir, "..")

test("buildRegistration reads the four agents and gives them opencode roles", () => {
	const reg = buildRegistration(ROOT)
	expect(reg.skillsPath).toBe(resolve(ROOT, "skills"))
	expect(Object.keys(reg.agents).sort()).toEqual(["omni", "omni-implementer", "omni-planner", "omni-reviewer"])
	expect(reg.agents["omni"].mode).toBe("primary")
	expect(reg.agents["omni"].permission).toMatchObject({ bash: "allow", edit: "allow", write: "allow", task: "allow" })
	expect(reg.agents["omni"].prompt).toContain("You are the omni pipeline orchestrator.")
	expect(reg.agents["omni"].prompt).not.toContain("name: orchestrator")
	expect(reg.agents["omni-planner"].mode).toBe("subagent")
	expect(reg.agents["omni-planner"].tools).toEqual({ read: true, grep: true, glob: true, list: true, bash: true, write: true })
	expect(reg.agents["omni-reviewer"].tools).toEqual({ read: true, grep: true, glob: true, list: true, bash: true })
	expect(reg.agents["omni-reviewer"].temperature).toBe(0.1)
	expect(reg.agents["omni-planner"].description).toContain("omni pipeline planner")
})

test("buildRegistration turns commands/*.md into command templates bound to the omni agent", () => {
	const reg = buildRegistration(ROOT)
	expect(Object.keys(reg.commands).sort()).toEqual(["omni", "omni-abort", "omni-resume", "omni-status"])
	expect(reg.commands["omni"].agent).toBe("omni")
	expect(reg.commands["omni"].template).toContain("$ARGUMENTS")
	expect(reg.commands["omni"].template).not.toContain("argument-hint")
	expect(reg.commands["omni-status"].description).toContain("Scoreboard")
})

test("applyRegistration fills an empty config", () => {
	const config: Record<string, any> = {}
	const warnings: string[] = []
	applyRegistration(config, buildRegistration(ROOT), (m) => warnings.push(m))
	expect(config.skills.paths).toEqual([resolve(ROOT, "skills")])
	expect(Object.keys(config.agent).sort()).toEqual(["omni", "omni-implementer", "omni-planner", "omni-reviewer"])
	expect(Object.keys(config.command).sort()).toEqual(["omni", "omni-abort", "omni-resume", "omni-status"])
	expect(warnings).toEqual([])
})

test("applyRegistration leaves a user's own entries alone and warns", () => {
	const mine = { prompt: "mine", mode: "subagent" }
	const config: Record<string, any> = {
		skills: { paths: [resolve(ROOT, "skills")] },
		agent: { "omni-planner": mine },
		command: { "omni-status": { template: "mine" } },
	}
	const warnings: string[] = []
	applyRegistration(config, buildRegistration(ROOT), (m) => warnings.push(m))
	expect(config.agent["omni-planner"]).toBe(mine)
	expect(config.command["omni-status"]).toEqual({ template: "mine" })
	expect(config.skills.paths).toEqual([resolve(ROOT, "skills")])
	expect(warnings.length).toBe(2)
	expect(warnings[0]).toContain("omni-planner")
})
