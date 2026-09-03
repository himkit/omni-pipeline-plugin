#!/usr/bin/env node
// omni-pipeline installer. Wires the omni plugin into Claude Code, codex and
// opencode. Zero dependencies on purpose: this runs via `npx` before anything
// is installed, so it may only use what Node ships with.
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { realpathSync } from "node:fs"

const execFileAsync = promisify(execFile)
const REPO = "https://github.com/himkit/omni-pipeline-plugin.git"
const MARKETPLACE = "omni-pipeline-plugin"
const PLUGIN = "omni"

export function omniHome() {
  return process.env.OMNI_HOME || path.join(os.homedir(), ".omni-pipeline")
}

export function srcDir() {
  return path.join(omniHome(), "src")
}

// `which`, without spawning: PATH lookup is all we need and it cannot fail.
async function onPath(bin) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean)
  for (const d of dirs) {
    try {
      await fs.access(path.join(d, bin), fs.constants.X_OK)
      return true
    } catch {}
  }
  return false
}

async function dirExists(p) {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

export const HOSTS = [
  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    configDir: path.join(os.homedir(), ".claude"),
    detect: () => onPath("claude"),
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    configDir: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    detect: () => onPath("codex"),
  },
  {
    id: "opencode",
    label: "opencode",
    bin: "opencode",
    configDir: process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode"),
    detect: () => onPath("opencode"),
  },
]

export function parseArgs(argv) {
  const out = { hosts: null, yes: false, ref: null, uninstall: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--uninstall") out.uninstall = true
    else if (a === "--yes" || a === "-y") out.yes = true
    else if (a === "--hosts") out.hosts = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean)
    else if (a.startsWith("--hosts=")) out.hosts = a.slice(8).split(",").map((s) => s.trim()).filter(Boolean)
    else if (a === "--ref") out.ref = argv[++i] || null
    else if (a.startsWith("--ref=")) out.ref = a.slice(6)
    else if (a === "--help" || a === "-h") {
      usage()
      process.exit(0)
    } else {
      console.error(`unknown option: ${a}`)
      usage()
      process.exit(2)
    }
  }
  return out
}

function usage() {
  console.log(`
  omni-pipeline installer

  Usage:
    npx omni-pipeline [options]

  Options:
    --hosts a,b     install into these hosts only (claude, codex, opencode)
    --yes, -y       skip the picker, use every detected host
    --ref <ref>     git ref to check out (default: the repo's default branch)
    --uninstall     remove host wiring; leaves ${omniHome()} untouched
    --help, -h      this text
`)
}

// Never throws. Callers decide what a failure means.
export async function run(bin, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, opts)
    return { ok: true, out: (stdout || "") + (stderr || "") }
  } catch (err) {
    return { ok: false, out: String(err?.stdout || "") + String(err?.stderr || err?.message || "") }
  }
}

export async function ensureCheckout(ref) {
  const src = srcDir()
  await fs.mkdir(omniHome(), { recursive: true })
  if (await dirExists(path.join(src, ".git"))) {
    console.log(`  updating ${src}`)
    await run("git", ["-C", src, "fetch", "--quiet", "origin"])
    if (ref) {
      const co = await run("git", ["-C", src, "checkout", "--quiet", ref])
      if (!co.ok) {
        console.error(`  git checkout ${ref} failed in ${src}:\n${co.out}`)
        console.error(`  refusing to wire hosts to whatever ref is checked out there.`)
        process.exit(1)
      }
    }
    const pull = await run("git", ["-C", src, "pull", "--ff-only", "--quiet"])
    if (!pull.ok) console.log(`  (pull skipped: local changes or detached ref)`)
  } else {
    console.log(`  cloning into ${src}`)
    const args = ["clone", "--quiet"]
    if (ref) args.push("--branch", ref)
    args.push(REPO, src)
    const clone = await run("git", args)
    if (!clone.ok) {
      console.error(`  git clone failed:\n${clone.out}`)
      process.exit(1)
    }
  }
  return src
}

const ESC = "\x1b"
const GREEN = `${ESC}[32m`
export const DIM = `${ESC}[2m`
const CYAN = `${ESC}[36m`
export const RESET = `${ESC}[0m`

export function shortPath(p) {
  const h = os.homedir()
  return p.startsWith(h) ? `~${p.slice(h.length)}` : p
}

function draw(rows, cursor, selected, first, verb = "install into") {
  if (!first) process.stdout.write(`${ESC}[${rows.length + 4}A`)
  process.stdout.write(`${ESC}[0J`)
  process.stdout.write(`  Select coding agents to ${verb}:\n\n`)
  rows.forEach((r, i) => {
    const here = i === cursor ? `${CYAN}❯${RESET}` : " "
    if (!r.present) {
      process.stdout.write(`  ${here} ${DIM}✗  ${r.label.padEnd(14)} not installed${RESET}\n`)
      return
    }
    const box = selected.has(r.id) ? `${GREEN}◉${RESET}` : "◯"
    process.stdout.write(`  ${here} ${box}  ${r.label.padEnd(14)} ${DIM}${r.bin.padEnd(9)} ${shortPath(r.configDir)}${RESET}\n`)
  })
  process.stdout.write(`\n  ${DIM}↑↓ move · space toggle · a all · enter confirm · ctrl-c cancel${RESET}\n`)
}

export async function pickHosts(detected, args) {
  if (args.hosts) {
    const known = new Set(HOSTS.map((h) => h.id))
    const bad = args.hosts.filter((h) => !known.has(h))
    if (bad.length) {
      console.error(`  unknown host(s): ${bad.join(", ")}`)
      process.exit(2)
    }
    return args.hosts
  }
  if (args.yes || !process.stdin.isTTY || !process.stdout.isTTY) return detected

  // Uninstalling a host whose binary is gone still has to clear its files, so
  // during --uninstall every host is selectable regardless of detection.
  const verb = args.uninstall ? "uninstall from" : "install into"
  const rows = HOSTS.map((h) => ({ ...h, present: args.uninstall || detected.includes(h.id) }))
  const selected = new Set(detected)
  let cursor = rows.findIndex((r) => r.present)
  if (cursor < 0) cursor = 0

  return await new Promise((resolve) => {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding("utf8")
    draw(rows, cursor, selected, true, verb)

    const done = (result) => {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.removeListener("data", onKey)
      process.stdout.write("\n")
      resolve(result)
    }

    const onKey = (key) => {
      if (key === "\x03") { // ctrl-c
        done([])
        console.log("  cancelled.")
        process.exit(130)
      } else if (key === "\r" || key === "\n") {
        done([...selected])
        return
      } else if (key === " ") {
        const r = rows[cursor]
        if (r.present) selected.has(r.id) ? selected.delete(r.id) : selected.add(r.id)
      } else if (key === "a" || key === "A") {
        const all = rows.filter((r) => r.present)
        if (all.every((r) => selected.has(r.id))) selected.clear()
        else all.forEach((r) => selected.add(r.id))
      } else if (key === `${ESC}[A` || key === "k") {
        cursor = (cursor - 1 + rows.length) % rows.length
      } else if (key === `${ESC}[B` || key === "j") {
        cursor = (cursor + 1) % rows.length
      } else {
        return
      }
      draw(rows, cursor, selected, false, verb)
    }

    process.stdin.on("data", onKey)
  })
}

const OPENCODE_AGENTS = ["omni.md", "omni-planner.md", "omni-implementer.md", "omni-reviewer.md"]
const OPENCODE_COMMANDS = ["omni.md", "omni-status.md", "omni-resume.md", "omni-abort.md"]

export function opencodeLinks(src, dest) {
  const links = []
  for (const f of OPENCODE_AGENTS)
    links.push({ from: path.join(src, ".opencode-plugin", "agents", f), to: path.join(dest, "agents", f) })
  for (const f of OPENCODE_COMMANDS)
    links.push({ from: path.join(src, ".opencode-plugin", "commands", f), to: path.join(dest, "commands", f) })
  links.push({
    from: path.join(src, ".opencode-plugin", "plugins", "omni-gatekeeper.ts"),
    to: path.join(dest, "plugins", "omni-gatekeeper.ts"),
  })
  // Skill discovery is directory-based: <skills>/<name>/SKILL.md, and <name>
  // must equal the frontmatter name. So link the directory, not the file.
  links.push({ from: path.join(src, "skills", "pipeline"), to: path.join(dest, "skills", "pipeline") })
  return links
}

async function isSymlink(p) {
  try {
    return (await fs.lstat(p)).isSymbolicLink()
  } catch {
    return false
  }
}

async function exists(p) {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}

export async function installOpencode(src) {
  const dest = HOSTS.find((h) => h.id === "opencode").configDir
  const links = opencodeLinks(src, dest)

  // Pre-flight over the whole link set: a conflict found halfway through would
  // otherwise leave a partial install behind.
  const conflicts = []
  for (const { to } of links)
    if ((await exists(to)) && !(await isSymlink(to))) conflicts.push(to)
  if (conflicts.length) {
    console.error(`  refusing to overwrite ${conflicts.length} real file(s); nothing was linked:`)
    for (const c of conflicts) console.error(`    ${c}`)
    console.error(`    move them aside and re-run.`)
    return false
  }

  for (const d of ["agents", "commands", "plugins", "skills"])
    await fs.mkdir(path.join(dest, d), { recursive: true })
  for (const { from, to } of links) {
    await fs.rm(to, { force: true })
    await fs.symlink(from, to)
  }
  console.log(`  opencode  linked into ${shortPath(dest)}`)
  return true
}

export async function installClaude(src) {
  const add = await run("claude", ["plugin", "marketplace", "add", src])
  if (!add.ok) {
    if (!/already/i.test(add.out)) {
      console.error(`  claude marketplace add failed:\n${add.out}`)
      return false
    }
    console.log(`  claude    note: ${add.out.trim().split("\n")[0]}`)
  }
  const inst = await run("claude", ["plugin", "install", `${PLUGIN}@${MARKETPLACE}`])
  if (!inst.ok) {
    if (!/already/i.test(inst.out)) {
      console.error(`  claude plugin install failed:\n${inst.out}`)
      return false
    }
    console.log(`  claude    note: ${inst.out.trim().split("\n")[0]}`)
  }
  console.log(`  claude    installed ${PLUGIN}@${MARKETPLACE}`)
  return true
}

const OMNI_FENCE = "omni-pipeline"

export function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

// Never truncates in place: a crash or ENOSPC mid-write would otherwise leave
// the user's hook config empty or half-written.
async function writeFileAtomic(file, content) {
  const tmp = `${file}.omni-tmp`
  try {
    await fs.writeFile(tmp, content, "utf8")
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

function shQuote(p) {
  return p.replace(/([\\"$`])/g, "\\$1")
}

export function codexHookCommand(src) {
  // OMNI_HOST tells the shared gatekeeper.py which host is running it, so a
  // codex session's id is namespaced `codex-` and never mistaken for a Claude
  // Code one. The value is a fixed literal, so it needs no quoting; the path
  // still does.
  return `OMNI_HOST=codex python3 "${shQuote(path.join(src, "hooks", "gatekeeper.py"))}"`
}

// Pure. `existing` is the parsed hooks.json or null. Returns the new content
// with exactly one omni entry under Stop — re-running replaces, never appends.
export function mergeCodexHooks(existing, command) {
  // `typeof [] === "object"`, so both guards need the array check too: a
  // non-object root or a non-object `hooks` is replaced, never spread.
  const doc = isPlainObject(existing) ? { ...existing } : {}
  const hooks = isPlainObject(doc.hooks) ? { ...doc.hooks } : {}
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop : []
  const foreign = stop.filter((g) => g?._source !== OMNI_FENCE)
  hooks.Stop = [
    ...foreign,
    {
      _source: OMNI_FENCE,
      hooks: [{ type: "command", command, timeout: 10 }],
    },
  ]
  doc.hooks = hooks
  return doc
}

export async function installCodexHook(src) {
  const dir = HOSTS.find((h) => h.id === "codex").configDir
  const file = path.join(dir, "hooks.json")
  await fs.mkdir(dir, { recursive: true })

  const giveUp = () => {
    console.error(`  omni's gatekeeper will not run on codex until this is fixed.`)
    return false
  }

  let raw = null
  try {
    raw = await fs.readFile(file, "utf8")
  } catch (err) {
    // A missing file is the normal case. Anything else (EACCES, EISDIR) is a
    // real failure and must not be reported as bad JSON.
    if (err?.code !== "ENOENT") {
      console.error(`  cannot read ${file}: ${err?.message || err}`)
      return giveUp()
    }
  }

  let existing = null
  if (raw !== null) {
    try {
      existing = JSON.parse(raw)
    } catch {
      // The file exists but does not parse. Refuse rather than destroy it.
      console.error(`  ${file} is not valid JSON — leaving it alone.`)
      return giveUp()
    }
    if (!isPlainObject(existing)) {
      console.error(`  ${file} is not a JSON object — leaving it alone.`)
      return giveUp()
    }

    const backup = `${file}.omni-backup`
    try {
      await fs.access(backup)
    } catch {
      try {
        await writeFileAtomic(backup, raw)
        console.log(`  codex     backed up hooks.json → ${path.basename(backup)}`)
      } catch (err) {
        console.error(`  cannot write ${backup}: ${err?.message || err}`)
        return giveUp()
      }
    }
  }

  const merged = mergeCodexHooks(existing, codexHookCommand(src))
  try {
    await writeFileAtomic(file, `${JSON.stringify(merged, null, 2)}\n`)
  } catch (err) {
    console.error(`  cannot write ${file}: ${err?.message || err}`)
    return giveUp()
  }
  console.log(`  codex     gatekeeper hook installed in ${shortPath(file)}`)
  return true
}

export async function installCodex(src) {
  const add = await run("codex", ["plugin", "marketplace", "add", src])
  if (!add.ok) {
    if (!/already/i.test(add.out)) {
      console.error(`  codex marketplace add failed:\n${add.out}`)
      return false
    }
    console.log(`  codex     note: ${add.out.trim().split("\n")[0]}`)
  }
  const inst = await run("codex", ["plugin", "add", `${PLUGIN}@${MARKETPLACE}`])
  if (!inst.ok) {
    if (!/already/i.test(inst.out)) {
      console.error(`  codex plugin add failed:\n${inst.out}`)
      return false
    }
    console.log(`  codex     note: ${inst.out.trim().split("\n")[0]}`)
  }
  console.log(`  codex     installed ${PLUGIN}@${MARKETPLACE}`)
  return await installCodexHook(src)
}

export async function uninstall(chosen) {
  const src = srcDir()
  let ok = true

  if (chosen.includes("opencode")) {
    const dest = HOSTS.find((h) => h.id === "opencode").configDir
    let n = 0
    for (const { to } of opencodeLinks(src, dest)) {
      if (await isSymlink(to)) {
        await fs.rm(to, { force: true })
        n++
      }
    }
    console.log(`  opencode  removed ${n} link(s) from ${shortPath(dest)}`)
  }

  for (const id of ["claude", "codex"]) {
    if (!chosen.includes(id)) continue
    const remove = id === "claude" ? ["plugin", "uninstall", `${PLUGIN}@${MARKETPLACE}`] : ["plugin", "remove", `${PLUGIN}@${MARKETPLACE}`]
    const uninst = await run(id, remove)
    const rmMarket = await run(id, ["plugin", "marketplace", "remove", MARKETPLACE])
    if (uninst.ok && rmMarket.ok) {
      console.log(`  ${id.padEnd(9)} removed ${PLUGIN}@${MARKETPLACE}`)
    } else {
      const out = (!uninst.ok ? uninst.out : rmMarket.out).trim().split("\n")[0]
      console.log(`  ${id.padEnd(9)} note: ${out}`)
    }
  }

  if (chosen.includes("codex")) {
    const file = path.join(HOSTS.find((h) => h.id === "codex").configDir, "hooks.json")
    let raw = null
    try {
      raw = await fs.readFile(file, "utf8")
    } catch (err) {
      // No file at all is the one benign case: nothing to undo.
      if (err?.code !== "ENOENT") {
        console.error(`  codex     cannot read ${shortPath(file)}: ${err?.message || err}`)
        console.error(`  codex     the gatekeeper hook is still registered there.`)
        ok = false
      }
    }
    if (raw !== null) {
      let doc = null
      try {
        doc = JSON.parse(raw)
      } catch {
        console.error(`  codex     ${shortPath(file)} is not valid JSON — leaving it alone.`)
        ok = false
      }
      if (isPlainObject(doc)) {
        const hooks = isPlainObject(doc.hooks) ? doc.hooks : {}
        const stop = Array.isArray(hooks.Stop) ? hooks.Stop : []
        const kept = stop.filter((g) => g?._source !== OMNI_FENCE)
        if (kept.length !== stop.length) {
          if (kept.length) hooks.Stop = kept
          else delete hooks.Stop
          doc.hooks = hooks
          try {
            await writeFileAtomic(file, `${JSON.stringify(doc, null, 2)}\n`)
            console.log(`  codex     removed the gatekeeper hook from ${shortPath(file)}`)
          } catch (err) {
            console.error(`  codex     cannot write ${shortPath(file)}: ${err?.message || err}`)
            console.error(`  codex     the gatekeeper hook is still registered there.`)
            ok = false
          }
        }
      } else if (doc !== null) {
        console.error(`  codex     ${shortPath(file)} is not a JSON object — leaving it alone.`)
        ok = false
      }
    }
  }

  console.log(`\n  run state kept at ${shortPath(omniHome())}`)
  console.log(`  ${DIM}rm -rf ${shortPath(omniHome())}${RESET} to remove it and the checkout.`)
  return ok
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  console.log("\n  omni-pipeline installer\n")
  const detected = []
  for (const h of HOSTS) if (await h.detect()) detected.push(h.id)
  // The detection gate is an install-time gate only: removing a host's binary
  // must not strand the files the installer put in its config dir.
  if (detected.length === 0 && !args.uninstall) {
    console.error("  no supported coding agent found on PATH (claude, codex, opencode).")
    process.exit(1)
  }
  const chosen = await pickHosts(detected, args)
  if (chosen.length === 0) {
    console.log("  nothing selected. done.")
    return
  }

  if (args.uninstall) {
    console.log("")
    if (!(await uninstall(chosen))) process.exitCode = 1
    return
  }

  console.log(`\n  selected: ${chosen.join(", ")}`)

  const src = await ensureCheckout(args.ref)
  console.log("")
  let ok = true
  if (chosen.includes("claude")) ok = (await installClaude(src)) && ok
  if (chosen.includes("codex")) ok = (await installCodex(src)) && ok
  if (chosen.includes("opencode")) ok = (await installOpencode(src)) && ok
  if (!ok) {
    console.error(`\n  one or more hosts were not wired up. see above.`)
    process.exitCode = 1
  }
}

// npx runs the bin through a symlink in node_modules/.bin, so argv[1] is that
// link and not this file. Comparing unresolved paths made the installer exit
// silently under `npx`, which is the documented way to run it.
function sameFile(a, b) {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return path.resolve(a) === path.resolve(b)
  }
}

if (process.argv[1] && sameFile(process.argv[1], fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
