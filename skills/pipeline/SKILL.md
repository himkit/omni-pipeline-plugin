---
name: pipeline
description: Autonomous feature pipeline — brainstorm an idea into a locked spec, then run plan → implement (TDD) → review loop → deliver on a feature branch with zero human touch. Use when the user invokes /omni, says "triển", "omnislash", "auto pipeline", "build this feature end to end", or wants a spec-first fully automated feature delivery. Also loaded by /omni-resume to continue an interrupted run.
---

# omni pipeline

You are the **orchestrator**. You never write feature code yourself — you run the
state machine, spawn subagents (creep waves) per phase, verify their output, and
keep `state.json` truthful. A Stop hook (the gatekeeper) blocks this session from
stopping while a run is mid-pipeline, so the only legitimate exits are:
`done`, `blocked` (with a written reason), or `aborted` (via /omni-abort).

**Host differences.** Subagents are named `omni:planner` / `omni:implementer` /
`omni:reviewer` in Claude Code and `omni-planner` / `omni-implementer` /
`omni-reviewer` in opencode — spawn whichever exists in this session. The
enforcer differs too: Claude Code blocks the stop from a Stop hook, opencode
re-prompts the session from the `omni-gatekeeper` plugin on `session.idle`.
Both feed you `next_action`, both trip the same safety valve, and everything
below applies unchanged.

**The human touches the pipeline exactly twice: approving the spec, and answering
run-config questions. After that, zero questions until `done` or `blocked`.**

## Run directory (outside the repo)

`~/.omni-pipeline/runs/<run-id>/` where **`run-id = <YYYY-MM-DD>-<repo-basename>-<feature-slug>`**
(the repo basename is in the id so two repos building a same-named feature on
the same day never collide). Contains:

- `state.json` — single source of truth (schema below)
- `spec.md` — locked spec
- `plan.md` — written by the planner agent
- `report.md` — written at deliver time

### state.json schema

```json
{
  "run_id": "2026-08-28-shop-api-dark-mode",
  "feature_slug": "dark-mode",
  "session_id": null,
  "prev_owners": [],
  "phase": "planning",
  "repo": "/abs/path/to/repo",
  "workdir": "/abs/path/to/worktree-or-repo",
  "branch": "omni/dark-mode",
  "base_branch": "main",
  "test_command": "npm test",
  "max_review_iters": 5,
  "task_index": 0,
  "task_total": 0,
  "review_iter": 0,
  "next_action": "spawn planner agent to produce plan.md",
  "blocked_reason": null,
  "takeover_requested": null,
  "takeover_cwd": null,
  "updated_at": "2026-08-28T10:00:00+0700"
}
```

`branch` is always `omni/<feature_slug>` — never the full run-id. The
gatekeeper owns its own bookkeeping fields (`session_id`, `prev_owners`,
`revoked_notified`, `adopt_offers`, `resume_cwd`, `gk_blocks`,
`gk_fingerprint`, `stop_blocks`) — **never write or reset any of them.** It maintains the safety-valve counter itself, keyed to real progress
(`phase`/`task_index`/`review_iter`), precisely so a session that keeps
rewriting state on idle turns cannot disarm it.

Phases: `brainstorm → planning → implementing → reviewing → delivering → done | blocked | aborted`.

**State discipline — non-negotiable:**
- Update `state.json` after EVERY phase transition, task completion, and review
  iteration. Always set `next_action` to the concrete next step (the gatekeeper
  feeds it back to you if the session drifts). Writing state is not progress —
  only `phase`, `task_index` and `review_iter` moving forward is.
- **You never write `session_id`.** You cannot read your own session id; the
  gatekeeper can, so it is the only writer. Create the run with
  `session_id: null` and keep going — the gatekeeper binds you at the next turn
  boundary. To take over an existing run, raise the flag (see Resume protocol);
  never edit `session_id` by hand, in either direction.
- The gatekeeper only arms once `phase` reaches `planning`. Brainstorm is free.

## Spawning subagents — foreground, one at a time

**Always spawn in the foreground.** In Claude Code that means
`run_in_background: false` on the Agent tool; in opencode the native `task`
tool is already synchronous — await it, never fire-and-forget. Your very next
step always depends on the agent's result (run the tests, check the tree,
update `task_index`, spawn the next task), so nothing useful can happen while
it runs.

A background spawn ends your turn the instant the agent starts. The gatekeeper
then sees a mid-pipeline run and blocks the stop, you have nothing to do but
wait, and the block repeats every turn — burning a full context round-trip each
time while telling you to start work that is already running.

**One agent in flight at a time.** Never spawn a second agent for a task that
has not returned. Two implementers on one worktree means interleaved edits,
conflicting commits, and a dirty tree that fails your own verification. If a
gatekeeper message names a `next_action` you have already started, it is a
stale nudge — do not act on it twice.

## Phase 0 — brainstorm (interactive, human in the loop)

Input: the user's feature idea (from `/omni <idea>`).

1. Explore the target repo first: structure, conventions, existing flows the
   feature touches, how tests are run. The **current working directory** is the
   target repo unless the user names another.
2. Ask clarifying questions **one at a time** — open questions that dig into
   purpose, constraints, edge cases, and success criteria. Multiple choice when
   the options are enumerable. Stop asking when a competent engineer could
   implement without guessing.
3. Draft `spec.md` with exactly these sections:
   - **Goal** — one paragraph, what exists when this is done
   - **Non-goals** — what is explicitly out of scope
   - **Functional requirements** — numbered, testable statements
   - **Edge cases & error handling**
   - **Testing strategy** — what kinds of tests prove each requirement
   - **Acceptance criteria** — the checklist the reviewer will verify against
4. Present the spec, revise until the user approves. **This approval is a hard
   gate — never proceed without an explicit yes.**
5. Ask the run-config questions (one message, all together — these are the last
   questions the human will get):
   - Isolation: **git worktree** (default — parallel-safe, main workspace
     untouched) or branch on the current workspace?
   - Test command (propose what you found in the repo; confirm)
   - Base branch (default: repo's default branch)
   - Max review iterations (default 5)
6. Set up: create the run dir (named by the run-id), write `spec.md` and
   `state.json` (`phase: "planning"`, `session_id: null`, `run_id` and
   `feature_slug` per the schema) — plus `takeover_requested` (the output of
   `date +%s`) and `takeover_cwd` (the output of `pwd`), which is how you claim
   the run you just created. Claiming and resuming use the one mechanism, so
   there is no case where you write `session_id` yourself. Create the branch
   `omni/<feature_slug>` (branches are repo-scoped, so no repo prefix needed) — via
   `git worktree add <path> -b omni/<feature_slug> <base>` in worktree mode
   (put the worktree under `~/.omni-pipeline/worktrees/<run-id>`), or plain
   `git checkout -b` in-place (refuse in-place if the tree is dirty — tell the
   user to stash or pick worktree mode).
7. Announce: "**Omnislash cast — pipeline tự chém đến deliver.** Theo dõi: /omni-status. Hủy:
   /omni-abort." Then **end your turn without spawning anything** — the
   gatekeeper binds the run to this session at that boundary and comes back
   telling you to start planning. From here, do not ask the human anything.

## Phase 1 — planning

Spawn the `omni:planner` agent (foreground). Prompt must include: absolute paths of
`spec.md`, the run dir, `workdir`, the test command, and the instruction to
write `plan.md` into the run dir.

Validate the returned `plan.md`: every task must have files, test-first steps,
a verify command, and done-criteria. If malformed or tasks are not independent
enough to implement sequentially without guessing, re-spawn the planner with
the specific defects named (max 2 retries, then `blocked`).

Update state: `task_total`, `phase: "implementing"`, `task_index: 0`.

## Phase 2 — implementing

For each task N in `plan.md`, spawn a fresh `omni:implementer` agent
(foreground — wait for it to return before doing anything else) with:
`workdir`, `spec.md` + `plan.md` paths, "implement ONLY task N", the test
command, and the commit rules below.

After EACH task, verify yourself in `workdir`:
1. Run the test command — must pass.
2. `git status --short` must be clean (implementer commits its own work).
3. If either fails: re-spawn the implementer with the failure output (max 2
   retries per task, then `blocked` with the evidence in `blocked_reason`).

Then update `task_index` and `next_action`. When all tasks are done:
`phase: "reviewing"`, `review_iter: 0`.

**Commit rules (enforce on every agent):** commits go only to `omni/<feature_slug>`;
a task commit's subject is `<type>(omni-task-N): <subject>` where N is the plan
task number and `<type>` is a real conventional-commit type (`feat`, `fix`,
`refactor`, `test`, `docs`, `chore`) — the task number lives in the scope so it
survives any repo's commitlint, and it is what lets a resuming session read
progress out of git instead of trusting `state.json`. Commits that fix review
findings keep a plain `fix: <finding>` subject — they are not tasks. **Never add
a Co-Authored-By trailer**; never push; never touch files outside `workdir`.

## Phase 3 — review loop

Each iteration:
1. Run the full test command in `workdir`. Failures → treat as blocking findings.
2. Spawn `omni:reviewer` (foreground) with: `spec.md` and `plan.md` paths, `workdir`,
   base branch (for `git diff <base>...HEAD`), and the required output format.
3. Parse the verdict:
   - **No blocking findings AND tests pass** → `phase: "delivering"`.
   - **Blocking findings** → increment `review_iter`. If `review_iter >
     max_review_iters` → `blocked` (reason: unresolved findings, list them).
     Otherwise spawn a `omni:implementer` with the findings as its task list
     (same TDD + commit rules), then loop back to step 1.
   - Minor findings: include them in the implementer's task list alongside
     blockings if any exist; if only minors remain, spawn one implementer to
     fix them all, re-run tests, then deliver — do not burn iterations on nits.
     (You never edit code yourself, minors included.)

## Phase 4 — delivering

1. Confirm: tests pass, working tree clean, all commits on `omni/<feature_slug>`.
2. Write `report.md` to the run dir: what was built (vs spec), task list with
   commit SHAs, final test output (real evidence, pasted), review history
   (iterations, findings, resolutions), any handovers (how many times
   `prev_owners` grew, and at which task each takeover resumed, plus a note if
   git could not confirm `task_index`), and how to merge.
3. In worktree mode, leave the worktree in place (the user may want to inspect);
   note its path in the report, plus the cleanup commands for after merge
   (`git worktree remove <path>`, `git branch -d omni/<feature_slug>`, remove
   the run dir).
4. Set `phase: "done"`, `next_action: null`. The gatekeeper disarms.
5. Announce: "**GG — throne down.** Branch `omni/<feature_slug>` sẵn sàng." plus a
   short summary, branch name, report path. **Never push, never open an MR** —
   the human decides that.

## Blocked protocol

Real blockers only: missing credentials, spec contradiction discovered
mid-build, environment breakage you cannot fix, retry budgets exhausted.
Set `phase: "blocked"`, write a `blocked_reason` a human can act on, set
`next_action` to what resume should do, tell the user what you need, stop.
NOT valid reasons to block: a hard bug (debug it), a failing test (fix it),
an ambiguous nit (pick the spec-consistent reading and note it in report.md).

## Resume protocol (/omni-resume)

1. Locate the run (arg run-id, else the single non-terminal run; if several, ask).
2. Read `state.json`, `spec.md`, `plan.md` to rebuild context.
3. If blocked: get the human answer for `blocked_reason` first.
4. **Reconcile against git.** `state.json` records what the dead session
   *intended*; git records what actually happened. In `workdir`:
   a. `git status --porcelain` — non-empty means an agent died mid-edit. Run
      `git stash push -u -m "omni takeover <date +%s>"`. Never `reset --hard`:
      the work may be worth reading before it is thrown away.
   b. `git log --format=%s <base_branch>..HEAD` and take the highest N across
      subjects matching `(omni-task-N)`. That N is the last task actually
      committed — set `task_index` to it, whatever `state.json` said.
   c. No subject matches (a run that predates the convention) → keep the
      existing `task_index` and record in `report.md` that git could not
      confirm it.
   d. Run the full test command. If it fails, the last task is not really
      done: do not advance past it — `next_action` is an implementer carrying
      the failure output, under the same retry budget as Phase 2.
   e. Set `next_action` from the reconciled `task_index`: the next task, or
      `spawn reviewer` when `task_index == task_total`.
5. Restore the working phase (blocked → the phase recorded in `next_action`)
   and write the reconciled `task_index` and `next_action`.
6. **Claim the run, then stop.** Write `takeover_requested` (the output of
   `date +%s`) and `takeover_cwd` (the output of `pwd`) — never `session_id`
   — and **end your turn immediately, spawning nothing.** The gatekeeper binds
   you at that turn boundary and blocks the stop with your `next_action`; from
   there it is zero-touch again.

   Claiming last and stopping is what keeps the 5-minute window honest: raise
   the flag before a long reconcile or a spawned agent and it expires before
   the gatekeeper ever sees it. If it does lapse, write it again and stop again
   — nothing is lost. A run owned by the other host cannot be claimed: say so
   and stop.
