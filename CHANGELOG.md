# Changelog

## 0.4.0

Run state moved out of Claude Code's directory. omni now keeps everything under
`~/.omni-pipeline/` — `runs/` for state, `worktrees/` for the isolated
checkouts it creates — and resolves all of it from a single `OMNI_HOME`
environment variable. `OMNI_RUNS_DIR` is gone; it only ever relocated `runs`,
so a test using it still shared the real worktrees directory.

There is no migration code. If you have runs under the old path, move them once:

    mkdir -p ~/.omni-pipeline && mv ~/.claude/omni-plugins/runs ~/.omni-pipeline/runs

Installation is now one command for every host:

    npx github:himkit/omni-pipeline-plugin

It clones to `~/.omni-pipeline/src` and wires Claude Code, codex and opencode
against that single checkout, so one re-run updates all three. codex is
supported for the first time — it reads the plugin's existing
`.claude-plugin/marketplace.json` directly, but ignores a plugin's own
`hooks/hooks.json`, so the installer registers the gatekeeper in
`~/.codex/hooks.json` (backed up first, and fenced so `--uninstall` removes
exactly what it added).

`.opencode-plugin/install.sh` is gone. It symlinked from wherever you happened
to clone the repo, which the `~/.omni-pipeline/src` checkout replaces.

Session ids are namespaced by host. The hooks read `OMNI_HOST` (`claude` when
unset) to decide their prefix, and the codex hook command sets
`OMNI_HOST=codex`, so a run started in codex is not resumable from Claude Code
and vice versa — the two hosts share `runs/` without sharing ownership.

`--uninstall` removes host wiring only. It never touches `~/.omni-pipeline/runs`.
It also works when a host's binary is no longer on `PATH`, so removing the CLI
first does not strand its symlinks.

Cursor is not supported. It has no CLI, no plugin system and no subagents — and
the pipeline's review loop is only meaningful because the reviewer runs in a
fresh context that cannot see the implementer's reasoning.

## 0.3.0

A omni run whose session died could not be picked up by another session. It
stayed bound to the dead one forever, and the only way out was a human editing
`state.json` by hand.

### What was going wrong

`session_id` was written once and compared exactly: a session that was not the
bound one was skipped, dead owner or not. `/omni-resume` worked around this by
telling the model to null the field itself, wait for the gatekeeper's offer, and
copy an id out of a hook message — two turns, and a dead end if the model did not
follow through, because the offer was never repeated.

Worse, a session that took over had nothing to reconcile against. `state.json`
recorded what the dead session *meant* to do. If an implementer had committed a
task and the orchestrator died before recording it, the next session redid work
that was already on the branch.

### Fixes

**Ownership is granted by the gatekeeper, never written by the model.** The model
cannot read its own session id; the hook can. Claiming a run — whether you just
created it or are taking over a dead one — means writing `takeover_requested`
(epoch seconds) and `takeover_cwd`, and the gatekeeper binds you at the next turn
boundary if the request is under five minutes old and the directory matches. One
mechanism, no case where the model touches `session_id`. Handovers are always
human-triggered; nothing auto-adopts.

**Session ids are host-qualified** (`claude-<id>`, `opencode-<id>`), so the two
hosts sharing one runs directory never contend for a run. Unprefixed ids from
older runs still work.

**A session that loses ownership is told once**, by name, to stop and spawn
nothing — closing the window where a human resumes a session that was actually
still alive, and two orchestrators write to one worktree.

**Git is the truth on resume.** Task commits now carry the task number in the
scope (`feat(omni-task-3): ...`), so a resuming session reads progress out of
`git log` instead of trusting `state.json`, stashes a dirty worktree rather than
discarding it, and re-runs the full suite before advancing.

**A session-start notice** names any unfinished run for the directory you just
opened, so a stranded run no longer waits on somebody remembering it. opencode
has no session-start event, so its plugin keeps the existing idle-time nudge and
does not carry this notice.

**The plugin has tests now.** `tests/` drives both hooks the way
Claude Code does — JSON on stdin, JSON on stdout — against a temp runs directory
via the new `OMNI_RUNS_DIR` seam, so nothing in a test run can touch a real run.
Stdlib `unittest` for the Python hooks, `bun test` for the opencode helpers; no
new dependency either way.

### Deliberately not done

Automatic adoption based on a lease, heartbeat, or pid check. No hook fires in a
session while a foreground subagent runs, so a session waiting twenty minutes on
an implementer is indistinguishable from a dead one. Guessing wrong puts two
orchestrators on one worktree; being stuck costs one command.

Handover across hosts, and rescuing a run whose session died mid-brainstorm,
are both still out of scope.

### Known limitations

- **A refused claim is silent.** If the flag has expired, names the wrong
  directory, or points at a run owned by the other host, the gatekeeper says
  nothing and the session simply stops. The resuming model can believe it is
  driving a run that nobody is enforcing. Check `/omni-status` after a resume
  that goes quiet.
- **The two hosts resolve paths differently.** The Python claim resolves
  symlinks (`realpath`); the opencode one does not (`path.resolve`), so that
  helper can stay pure and testable. A run under a symlinked path — `/tmp` on
  macOS, for instance — can therefore be claimable from one host and not the
  other. omni's own worktrees live under `~/.claude/omni-plugins/worktrees/`
  and are unaffected.
- **The session-start notice cannot be silenced.** A run you have abandoned but
  not aborted will be announced every time you open a session in its directory.
  `/omni-abort` is the off switch.
- **Nothing enforces the commit convention.** Reconciliation trusts implementers
  to write `(omni-task-N)`. One commit without it and a resuming session falls
  back to `state.json` — the fallback is recorded in `report.md`, but the run
  does not fail.

## 0.2.0

Fixes a loop where a run mid-pipeline would spam the session with gatekeeper
messages instead of quietly waiting for the agent it had just spawned.

### What was going wrong

The orchestrator spawned an implementer in the **background**. A background
spawn ends the turn immediately, so the session went quiet while the agent was
still working. The gatekeeper saw a mid-pipeline run and blocked the stop —
correctly, by its own rules, because from the outside "waiting for an agent"
and "gave up halfway" look identical. The orchestrator had nothing to do but
say so and end its turn again, which the gatekeeper blocked again.

Each round of that burned a full context round-trip, and every block repeated
`next_action` verbatim — *"spawn implementer for task 10"* — for a task that was
already running. A model that took that literally would end up with two
implementers committing to the same worktree.

The safety valve that was supposed to catch this never fired. It counted
consecutive blocks in `stop_blocks`, but the skill told the orchestrator to
reset `stop_blocks` to `0` on every state write — including the idle writes
happening during the loop. The counter never climbed.

### Fixes

**Subagents are now spawned in the foreground.** The turn ends only after the
agent returns, so the gatekeeper never sees an idle session that is actually
busy. Nothing is lost: the pipeline is sequential, and the orchestrator's next
step always depends on the result it is waiting for. The skill also now states
the rule directly — one agent in flight at a time, and a `next_action` you have
already started is a stale nudge, not an instruction to spawn again.

**The safety valve counts for itself.** The gatekeeper keeps its own counter in
`gk_blocks`, keyed to a progress signature in `gk_fingerprint` built from
`phase`, `task_index` and `review_iter`. The counter resets only when one of
those actually advances — writing state is no longer mistaken for progress. The
orchestrator is told to leave both fields alone, and the gatekeeper never reads
back what it wrote there.

`stop_blocks` still appears in `state.json` so `/omni-status` keeps showing
something familiar, but it is now a display mirror: written by the gatekeeper,
never trusted by it. Instructions to reset it are gone from the skill and from
both `/omni-resume` commands.

Both hosts get the same behaviour — `hooks/gatekeeper.py` for Claude Code and
`.opencode-plugin/plugins/omni-gatekeeper.ts` for opencode.

### Also in this release: fewer worthless tests

A pipeline run could spend whole tasks writing tests that could never fail for
a reason anyone cares about — accessors on a data-holding type, constructor
field assignment, enum values, framework-provided serialization, a mock
asserting it returned what it was told to return.

The planner no longer gives a data-holding type (model, DTO, entity, enum,
1-to-1 mapper with no logic) a task of its own; it folds them into the task
that consumes them. "Test first" now explicitly targets a behavior boundary —
a service, use case, handler or public API — and if you cannot say how the test
fails before the implementation exists, the task is scoped wrong and gets
merged, not given a weaker test.

The reviewer gained a matching finding type, **test noise**, which names the
test to delete and the behavior-level test that covers it instead. It is always
**minor**: delivery never blocks on a test that only needs deleting. The
implementer may delete a test only when a review finding names it — never on
its own initiative.

### Upgrading

Nothing to do. Runs already in flight pick up the new fields the next time the
gatekeeper fires; a run with no `gk_fingerprint` yet simply starts its count
from one.

## 0.1.0

Initial release. `/omni` brainstorms an idea into a locked spec, then runs
plan → implement (TDD) → review → deliver on an `omni/<feature>` branch, with a
Stop-hook gatekeeper keeping the run alive. Companion commands `/omni-status`,
`/omni-resume`, `/omni-abort`. Ports to opencode under `.opencode-plugin/`.
