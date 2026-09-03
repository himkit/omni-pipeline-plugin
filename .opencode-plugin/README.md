# omni on opencode

The omni pipeline was written for Claude Code. This directory is the opencode
port: same skill, same run directory, same state machine — different host
wiring. Claude Code and opencode share `~/.omni-pipeline/runs/`, so a run
started in one is visible to `/omni-status` in the other.

## Install

```bash
npx github:himkit/omni-pipeline-plugin --hosts opencode
```

The installer clones to `~/.omni-pipeline/src` and symlinks from there into
`~/.config/opencode` (honouring `$OPENCODE_CONFIG_DIR`):

| Source | Destination |
|---|---|
| `agents/omni.md` | `agents/` — the primary orchestrator |
| `agents/omni-{planner,implementer,reviewer}.md` | `agents/` — the subagents |
| `commands/omni*.md` | `commands/` — `/omni`, `/omni-status`, `/omni-resume`, `/omni-abort` |
| `plugins/omni-gatekeeper.ts` | `plugins/` — the enforcer |
| `../skills/pipeline/` | `skills/pipeline/` — the shared skill, unmodified |

`--uninstall` removes the symlinks it created. It leaves
`~/.codex/hooks.json.omni-backup`, the directories it made under the config
dir, and — by design — `~/.omni-pipeline/src` and your run state.

Installing refuses to clobber a real file that is already at a destination: it
reports every conflict and links nothing.

Restart opencode afterwards, then `/omni <feature idea>`.

## What differs from Claude Code

**Agent names.** Claude Code namespaces plugin agents (`omni:planner`);
opencode has one flat namespace, so they are `omni-planner`,
`omni-implementer`, `omni-reviewer`. `reviewer` alone would collide with a
common agent name. The skill names both spellings and tells the orchestrator to
use whichever exists.

**The gatekeeper.** Claude Code's Stop hook returns `{"decision": "block"}` and
the session is not allowed to stop. opencode has no such hook, so
`plugins/omni-gatekeeper.ts` listens for `session.idle` and re-prompts the
session instead. The session does stop and then gets woken; the run still
cannot stall silently, which is the property that matters. Everything else —
fail-open on any error, the one-shot binding offer for an unbound run, the
15-nudge safety valve that force-blocks a run making no progress — is a
straight port of `hooks/gatekeeper.py`. The valve counts nudges itself, in
`gk_blocks`/`gk_fingerprint`, resetting only when `phase`, `task_index` or
`review_iter` actually advance; the orchestrator never writes those fields, so
it cannot disarm the valve by rewriting state on an idle turn.

Only root sessions are nudged: subagent sessions go idle constantly and would
otherwise be mistaken for the orchestrator.

**Permissions.** The pipeline is zero-touch after spec approval, so a
permission prompt mid-run is a stall. `agents/omni.md` therefore allows `bash`,
`edit`, `write`, and `task` for itself, plus `external_directory` under
`~/.omni-pipeline/` where the run directory and the worktrees live. This
is scoped to the `omni` agent — your other agents keep whatever your
`opencode.json` says.

`omni-implementer` writes code, so it must be spawned with the native `task`
tool. A read-only delegation tool (`delegate` from the background-agents
plugin, for example) cannot run it. Spawns are synchronous by design: the
orchestrator awaits each agent instead of going idle while one runs, otherwise
the gatekeeper nudges it every turn to start work already in flight.

## Verify an install

```bash
opencode debug agent omni
```

```bash
opencode debug skill | grep -c 'skills/pipeline/SKILL.md'
```

The gatekeeper logs `armed — watching <runs dir>` at DEBUG when it loads:

```bash
opencode serve --print-logs --log-level DEBUG
```
