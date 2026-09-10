/**
 * Guards the shape of the published plugin entry.
 *
 * Two host facts drive every assertion here, both learned the hard way:
 *
 * 1. opencode's loader walks EVERY export of a plugin module, requires each to
 *    be a function, and calls each one with the plugin input. Helpers exported
 *    beside the plugin are therefore invoked as plugins: they throw, opencode
 *    logs "failed to load plugin", and no export after the throw ever runs. The
 *    gatekeeper only armed before this because ESM namespace keys are sorted
 *    alphabetically and `OmniPlugin` happened to sort first.
 *
 * 2. A host may run plugins under Node rather than bun — the opencode desktop
 *    app runs its server in an Electron Node sidecar. Node refuses to strip
 *    TypeScript types for files under `node_modules`, so a `.ts` entry point is
 *    unloadable once installed from git or npm ("Stripping types is currently
 *    unsupported for files under node_modules"). The published entry must be
 *    plain JavaScript.
 */

import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const REPO = resolve(import.meta.dir, "..")
const PKG = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
	main: string
	scripts?: Record<string, string>
}

test("package main is plain JavaScript, not TypeScript", () => {
	// A .ts entry cannot be loaded by a host that runs plugins under Node once
	// the package sits in node_modules.
	expect(PKG.main.endsWith(".js")).toBe(true)
	expect(existsSync(join(REPO, PKG.main))).toBe(true)
})

test("entry module exports the plugin and nothing else", async () => {
	const mod = (await import(join(REPO, PKG.main))) as Record<string, unknown>
	// Anything else here gets called as a plugin by opencode's loader.
	expect(Object.keys(mod)).toEqual(["OmniPlugin"])
	expect(typeof mod.OmniPlugin).toBe("function")
})

test("the TypeScript source entry also exports the plugin alone", async () => {
	const mod = (await import(join(REPO, ".opencode/src/entry.ts"))) as Record<string, unknown>
	expect(Object.keys(mod)).toEqual(["OmniPlugin"])
})

test("the committed bundle matches the current source", () => {
	// The bundle is committed so a git install needs no build step; this keeps
	// it honest when the source moves on.
	const out = join(mkdtempSync(join(tmpdir(), "omni-build-")), "omni.js")
	execFileSync(
		"bun",
		["build", ".opencode/src/entry.ts", "--target=node", "--format=esm", "--outfile", out],
		{ cwd: REPO, stdio: "pipe" },
	)
	expect(readFileSync(out, "utf8")).toBe(readFileSync(join(REPO, PKG.main), "utf8"))
})
