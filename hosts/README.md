# Hosts

omnislash ships one host-neutral body — `skills/`, `agents/`, `commands/`,
`hooks/*.py` — and a thin adapter per host that the host's own plugin
mechanism installs. `hosts/registry.json` is the source of truth; this table
is checked against it by `tests/test_registry.py`.

## Support matrix

| Host | Tier | Enforcer | Subagents | Commands | Verified |
|---|---|---|---|---|---|
| Claude Code | full | Stop hook blocks the stop | `omnislash:planner` etc. | `/omnislash:cast`, `/omnislash:scoreboard`, `/omnislash:reconnect`, `/omnislash:gg` | not yet — 2026-09-09 hook probe passed (`claude -p --plugin-dir`, fake run: registry-driven gatekeeper blocked the stop once); no end-to-end run recorded |
| Codex | full | Stop hook blocks the stop | `agents/<role>.md` as the `spawn_agent` prompt | none — ask for the `cast` skill with the intent | not yet — `codex plugin add` installs it and ships `hooks/hooks-codex.json`; the Stop hook has not been seen firing in a logged-in Codex session |
| Hermes Agent | full | plugin continues the agent at the `pre_verify` gate | `agents/<role>.md` as the `delegate_task` prompt | none — ask for the `cast` skill with the intent, or `skill_view("omnislash:cast")` | not yet — 2026-09-11 adapter written against Hermes v0.21.1 (`hermes plugins doctor` clean, gatekeeper bridged through `pre_verify`); no end-to-end run recorded |
| opencode | full | plugin re-prompts on `session.idle` | `omnislash-planner` etc. | `/omnislash:cast`, `/omnislash:scoreboard`, `/omnislash:reconnect`, `/omnislash:gg` | not yet — 2026-09-09 registration verified in an isolated HOME (agents, commands, skills path, permissions); idle nudge not observed |
| everything else | skills-only | none — the skill self-checks state each turn | inline, sequential | ask for the `cast` skill with the intent | — |

## Install

**Claude Code**

```text
/plugin marketplace add himkit/omni-pipeline-plugin
/plugin install omnislash@omni-pipeline-plugin
```

**Codex**

```bash
codex plugin marketplace add himkit/omni-pipeline-plugin
codex plugin add omnislash@omni-pipeline-plugin
```

Subagents need `multi_agent = true` under `[features]` in `~/.codex/config.toml`.
Without it the orchestrator does every role inline.

**Hermes Agent**

```bash
hermes plugins install himkit/omni-pipeline-plugin
```

Hermes has no Stop hook. The adapter bridges the same `hooks/gatekeeper.py`
onto `pre_verify`, the one hook whose return value keeps the agent going, and
onto `pre_llm_call` for the session-start reminder. Two limits follow from that:

- `pre_verify` fires only on a turn where the agent edited code, so a turn that
  only spawned an agent or read files is not gated. The skill's own state
  re-read is what continues the run there.
- consecutive continues inside one turn are capped by `agent.max_verify_nudges`
  (default 3). The gatekeeper's 15-block safety valve is the intended bound, so
  raise the cap:

```bash
hermes config set agent.max_verify_nudges 20
```

Skills load namespaced: `skill_view("omnislash:cast")`, or ask for the `cast`
skill with the intent.

**opencode** — add to `opencode.json` (global or project) and restart:

```json
{ "plugin": ["omni-pipeline@git+https://github.com/himkit/omni-pipeline-plugin.git"] }
```

Pin with `#v1.0.0`. The plugin registers the `omnislash` primary agent, the three
`omnislash-*` subagents, the four `/omnislash:*` commands and the `cast` skill from
its own checkout; nothing is written into `~/.config/opencode`. An agent or
command you already define with the same name wins, and the plugin logs a
warning at load. Verify with `opencode debug agent omnislash`.

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
  `scoreboard` and `reconnect` from a full-tier host see the run.

## Host-specific flags the prompts do not mention

| Host | Flag | Why |
|---|---|---|
| Claude Code | `run_in_background: false` on `Agent` | a background spawn ends the turn and the Stop hook re-blocks every turn |
| Codex | `spawn_agent {fork_turns: "none"}` | children get a clean context, not this transcript |
| Hermes Agent | `delegate_task {role: "leaf"}` | the child is one role, not another orchestrator; `delegate_task` is synchronous, so the turn already ends after it returns |
| opencode | `task` is synchronous | await it; `omnislash-implementer` must go through `task`, never a read-only delegation tool |

## Ownership

Every host prefixes the session ids it writes (`prefix` in the registry) and
the gatekeepers refuse a takeover across that boundary. A run is resumable only
from the host that started it.

## Adding a host

See `docs/porting-a-host.md`.
