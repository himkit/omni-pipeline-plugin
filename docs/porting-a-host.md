# Porting omnislash to a new host

One PR per host. The PR carries a real session transcript: `/omnislash:cast` (or the
skill by intent) on a scratch repo through `planning`, with the gatekeeper
visibly feeding `next_action` back at least once.

## 1. Capability checklist

Find out, empirically, what the host can do. Read a working third-party plugin
for it before trusting docs.

| Capability | Needed for | If absent |
|---|---|---|
| Runs a shell command when the session tries to stop, reads JSON back, honours `decision: block` | `enforcer: stop-hook` | try an in-process plugin with an idle event → `idle-plugin`; else `none` |
| Session-start hook or context injection | the "unfinished run here" reminder | drop it; not required |
| Spawns subagents with a custom prompt | `subagents: inline-prompt`; with shipped role files → `namespaced` or `flat` | `none` — the skill does roles inline |
| Loads slash commands from files or config | `commands: markdown` / `config` | `skills-only` — the skill's entry-point table covers it |
| Discovers `skills/*/SKILL.md` | everything | the host cannot be a full-tier host |

If the first row is `none` and there is no subagent support either, stop: the
host is skills-only and already works through `npx skills add`. Add nothing.

## 2. Registry entry

Add the host to `hosts/registry.json` with every field (see the existing
three). `prefix` must be unique and end with `-`. `verified` is the date of
your transcript.

## 3. Adapter

Copy the closest reference:

- **Shell-hook host** (runs `hooks/*.py` on Stop): copy `.codex-plugin/` and
  `hooks/hooks-codex.json`. The hook command must set `OMNI_HOST=<id>` and
  reference whatever plugin-root variable the host exports. Never write into
  the user's config directory; the manifest is the only thing you ship.
- **In-process plugin host** (JS/TS lifecycle callbacks): copy
  `.opencode/plugins/omni.ts`. Keep the pure helpers and `buildRegistration`;
  change only the host API calls and the `ROLES` table.
- **Manifest-only host** that consumes a Claude-compatible plugin (Factory
  Droid, Copilot CLI): often no files at all — verify, then add the registry
  entry and the README row.

The adapter directory must exist; `tests/test_registry.py` checks it.

## 4. Docs

Add a row and an install block to `hosts/README.md`, and the host's flags to
its flags table. Do **not** add the host's name to `skills/`, `agents/` or
`commands/` — `tests/test_prompt_neutrality.py` fails the build if you do.

## 5. Acceptance

Clean session on the new host, scratch repo, `/omnislash:cast add a --version flag`
(or the skill by intent). Approve the spec, answer the setup questions, and
show: `state.json` written with `session_id` prefixed by your `prefix`, the
gatekeeper's first `next_action` message, the planner spawned or done inline.
Paste the transcript into the PR and set `verified`.
