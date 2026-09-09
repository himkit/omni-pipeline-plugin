# Hosts

omni ships one host-neutral body — `skills/`, `agents/`, `commands/`,
`hooks/*.py` — and a thin adapter per host that the host's own plugin
mechanism installs. `hosts/registry.json` is the source of truth; this table
is checked against it by `tests/test_registry.py`.

## Support matrix

| Host | Tier | Enforcer | Subagents | Commands | Verified |
|---|---|---|---|---|---|
| Claude Code | full | Stop hook blocks the stop | `omni:planner` etc. | `/omni`, `/omni-status`, `/omni-resume`, `/omni-abort` | 2026-09-09 |
| Codex | full | Stop hook blocks the stop | `agents/<role>.md` as the `spawn_agent` prompt | none — ask for the `pipeline` skill with the intent | not yet |
| opencode | full | plugin re-prompts on `session.idle` | `omni-planner` etc. | `/omni`, `/omni-status`, `/omni-resume`, `/omni-abort` | not yet |
| everything else | skills-only | none — the skill self-checks state each turn | inline, sequential | ask for the `pipeline` skill with the intent | — |

## Install

**Claude Code**

```text
/plugin marketplace add himkit/omni-pipeline-plugin
/plugin install omni@omni-pipeline-plugin
```

**Codex**

```bash
codex plugin marketplace add himkit/omni-pipeline-plugin
codex plugin add omni@omni-pipeline-plugin
```

Subagents need `multi_agent = true` under `[features]` in `~/.codex/config.toml`.
Without it the orchestrator does every role inline.

**opencode** — add to `opencode.json` (global or project) and restart:

```json
{ "plugin": ["omni-pipeline@git+https://github.com/himkit/omni-pipeline-plugin.git"] }
```

Pin with `#v1.0.0`. The plugin registers the `omni` primary agent, the three
`omni-*` subagents, the four `/omni*` commands and the `pipeline` skill from
its own checkout; nothing is written into `~/.config/opencode`. An agent or
command you already define with the same name wins, and the plugin logs a
warning at load. Verify with `opencode debug agent omni`.

**Any other host** — install the skill only:

```bash
npx skills add himkit/omni-pipeline-plugin
```

## What each tier gets

- **full** — the gatekeeper feeds `next_action` back whenever the session
  drifts and trips the 15-nudge safety valve; subagents run each role in a
  clean context; commands are one keystroke away.
- **skills-only** — no gatekeeper: the skill re-reads `state.json` at the
  start of every turn and continues from `next_action`, but a session that
  simply ends is not woken. No subagents: the orchestrator does each role
  inline, sequentially, in one context. Run state is the same, so
  `omni-status` and `omni-resume` from a full-tier host see the run.

## Host-specific flags the prompts do not mention

| Host | Flag | Why |
|---|---|---|
| Claude Code | `run_in_background: false` on `Agent` | a background spawn ends the turn and the Stop hook re-blocks every turn |
| Codex | `spawn_agent {fork_turns: "none"}` | children get a clean context, not this transcript |
| opencode | `task` is synchronous | await it; `omni-implementer` must go through `task`, never a read-only delegation tool |

## Ownership

Every host prefixes the session ids it writes (`prefix` in the registry) and
the gatekeepers refuse a takeover across that boundary. A run is resumable only
from the host that started it.

## Adding a host

See `docs/porting-a-host.md`.
