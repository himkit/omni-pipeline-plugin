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

`~/.omni-pipeline/runs/<run-id>/` where **`run-id = <YYYY-MM-DD>-<primary-repo-basename>-<feature-slug>`**
(the primary repo basename is in the id so two repos building a same-named
feature on the same day never collide). Contains:

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
  "repo": "/abs/path/to/shop-api",
  "workdir": "/abs/path/to/shop-api",
  "branch": "omni/dark-mode",
  "base_branch": "main",
  "test_command": "npm test",
  "targets": [
    {
      "name": "shop-api",
      "repo": "/abs/path/to/shop-api",
      "workdir": "/abs/path/to/shop-api",
      "isolation": "in-place",
      "branch": "omni/dark-mode",
      "base_branch": "main",
      "test_command": "npm test"
    },
    {
      "name": "shop-web",
      "repo": "/abs/path/to/shop-web",
      "workdir": "/Users/me/.omni-pipeline/worktrees/2026-08-28-shop-api-dark-mode/shop-web",
      "isolation": "worktree",
      "branch": "omni/dark-mode",
      "base_branch": "develop",
      "test_command": "bun test"
    }
  ],
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

**Targets.** A run works on one or more repositories, each a *target* with its
own `repo`, `workdir`, `isolation` (`worktree` or `in-place`), `branch`,
`base_branch` and `test_command`. `name` is unique within the run and defaults
to the repo basename — when two repos share a basename, ask for a distinct
name in step 5 — and plan tasks and review findings refer to targets by it.
The first target is the **primary** target — the repo `/omni` was invoked in
unless the user named another — and the top-level `repo`, `workdir`, `branch`,
`base_branch` and `test_command` are always copies of it, so a run with one
target looks exactly like it always did and the hooks need no migration.
Targets are written once at setup and never change: adding a repo mid-run is a
spec change, so it is a new run. Worktree path per target:
`~/.omni-pipeline/worktrees/<run-id>/<name>`; a run with a single target keeps
`~/.omni-pipeline/worktrees/<run-id>`. Paths in `targets` are absolute and
expanded — never `~`; the hooks resolve them with realpath, which does not
expand it.

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
   primary target unless the user names another. If the idea plainly spans
   more than one repository (a service and its client, a library and its
   consumer), ask for each additional repo's absolute path now and explore it
   the same way — every repo the feature touches becomes a target.
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
   questions the human will get). Per target, when there is more than one, ask
   each of the first three for every target by name:
   - Isolation: **git worktree** (default — parallel-safe, main workspace
     untouched) or branch on the current workspace?
   - Test command (propose what you found in the repo; confirm)
   - Base branch (default: repo's default branch)
   - Max review iterations (default 5) — one value for the whole run
6. Set up, in this order — it is what keeps a refused run from leaving half a
   run behind:
   a. **Clean check first.** For every `in-place` target run
      `git status --porcelain` in its repo. Any output → refuse the whole run
      before creating anything: name the dirty repo, offer stash or worktree
      mode for it, and go back to step 5.
   b. **Write state.** Create the run dir (named by the run-id, primary repo
      basename in it), write `spec.md` and `state.json` (`phase: "planning"`,
      `session_id: null`, `run_id`, `feature_slug`, the full `targets` array
      and the top-level mirrors of `targets[0]`, per the schema) — plus
      `takeover_requested` (the output of `date +%s`) and `takeover_cwd` (the
      output of `pwd`), which is how you claim the run you just created.
      Claiming and resuming use the one mechanism, so there is no case where
      you write `session_id` yourself. The gatekeeper matches `pwd` against
      every target's directory, so it does not matter which repo you are in.
   c. **Create branches.** For each target in order, create `omni/<feature_slug>`
      (branches are repo-scoped, so every target shares the name) — via
      `git worktree add <workdir> -b omni/<feature_slug> <base_branch>` for
      `worktree` targets (path per the schema), or `git checkout -b` in place
      for `in-place` targets. If a target's branch or worktree cannot be
      created, set `phase: "blocked"` with a `blocked_reason` naming the
      targets that were created and the one that failed — resume must never
      assume every target exists.
7. Announce: "**Omnislash cast — pipeline tự chém đến deliver.** Theo dõi: /omni-status. Hủy:
   /omni-abort." Then **end your turn without spawning anything** — the
   gatekeeper binds the run to this session at that boundary and comes back
   telling you to start planning. From here, do not ask the human anything.

## Phase 1 — planning

Spawn the `omni:planner` agent (foreground). Prompt must include: absolute paths of
`spec.md` and the run dir, **every target** as `name`, `workdir`,
`base_branch` and `test_command`, and the instruction to write `plan.md` into
the run dir.

Validate the returned `plan.md`: every task must have files, a `**Target:**`
line naming a target that exists in `state.json`, test-first steps, a verify
command, and done-criteria. If malformed, a target is unknown, or tasks are not
independent enough to implement sequentially without guessing, re-spawn the
planner with the specific defects named (max 2 retries, then `blocked`).

Update state: `task_total`, `phase: "implementing"`, `task_index: 0`.

## Phase 2 — implementing

For each task N in `plan.md`, read its `**Target:**` line, look that target up
in `state.json`, and spawn a fresh `omni:implementer` agent (foreground — wait
for it to return before doing anything else) with: that target's `workdir` and
`test_command`, `spec.md` + `plan.md` paths, "implement ONLY task N", and the
commit rules below. The implementer sees one directory; it never needs to know
the other targets exist.

After EACH task, verify yourself in that target's `workdir`:
1. Run that target's test command — must pass.
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
a Co-Authored-By trailer**; never push; never touch files outside the task's
target `workdir`.

## Phase 3 — review loop

Each iteration:
1. Run every target's test command in its `workdir`. Failures → treat as
   blocking findings, prefixed with the target name.
2. Spawn `omni:reviewer` (foreground) with: `spec.md` and `plan.md` paths,
   every target as `name`, `workdir` and `base_branch` (for
   `git diff <base>...HEAD` in each), and the required output format. Finding
   paths come back as `<name>:path/file.ext:line`; pass them to the implementer
   grouped by target, each group with that target's `workdir`. Findings in two
   targets mean two implementer spawns, one after the other. A finding with no
   prefix, or a prefix naming no target, resolves to the primary target; note
   that in `report.md`.
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

1. Confirm, per target: tests pass, working tree clean, all commits on
   `omni/<feature_slug>`.
2. Write `report.md` to the run dir: what was built (vs spec); per target its
   branch, base, task list with commit SHAs and final test output (real
   evidence, pasted); review history (iterations, findings, resolutions); any
   handovers (how many times `prev_owners` grew, and at which task each
   takeover resumed, plus a note if git could not confirm `task_index`); and
   how to merge — including the order the branches should land in when one
   target depends on another.
3. For `worktree` targets, leave the worktree in place (the user may want to
   inspect); note each path in the report, plus the cleanup commands for after
   merge (`git worktree remove <path>`, `git branch -d omni/<feature_slug>` in
   that repo, and removing the run dir once every target is merged).
4. Set `phase: "done"`, `next_action: null`. The gatekeeper disarms.
5. Announce: "**GG — throne down.** Branch `omni/<feature_slug>` sẵn sàng." —
   naming every target's repo when there is more than one — plus a short
   summary, branch name, report path. **Never push, never open an MR** — the
   human decides that.

## Blocked protocol

Real blockers only: missing credentials, spec contradiction discovered
mid-build, environment breakage you cannot fix, retry budgets exhausted.
Set `phase: "blocked"`, write a `blocked_reason` a human can act on, set
`next_action` to what resume should do, tell the user what you need, stop.
NOT valid reasons to block: a hard bug (debug it), a failing test (fix it),
an ambiguous nit (pick the spec-consistent reading and note it in report.md).

## Abort protocol (/omni-abort)

1. Set `phase: "aborted"` in `state.json` first — the gatekeeper disarms and
   nothing can stay trapped.
2. Report what exists per target: branch, commits against `base_branch`,
   worktree path for `worktree` targets, and the run dir.
3. Ask once — keep everything (default) or delete branches, worktrees and the
   run dir. Only after an explicit yes, for each target: `worktree` →
   `git worktree remove <workdir> --force`, then `git branch -D
   omni/<feature_slug>` in its repo; `in-place` → `git checkout <base_branch>`
   in its repo, then `git branch -D omni/<feature_slug>`. A target whose
   worktree or branch does not exist is skipped, not an error — keep going
   and report it. Remove the run dir last.

## Resume protocol (/omni-resume)

1. Locate the run (arg run-id, else the single non-terminal run; if several, ask).
2. Read `state.json`, `spec.md`, `plan.md` to rebuild context.
3. If blocked: get the human answer for `blocked_reason` first.
4. **Reconcile against git.** `state.json` records what the dead session
   *intended*; git records what actually happened. For every target, in its
   `workdir`: a target whose `workdir` does not exist contributes no subjects
   and no test run; record it in `report.md` and in `blocked_reason` if you
   block.
   a. `git status --porcelain` — non-empty means an agent died mid-edit. Run
      `git stash push -u -m "omni takeover <date +%s>"`. Never `reset --hard`:
      the work may be worth reading before it is thrown away.
   b. `git log --format=%s <base_branch>..HEAD` — collect the subjects.
   Then, across the union of every target's subjects, take the highest N
   matching `(omni-task-N)`. Tasks are strictly sequential and each lives in
   one target, so that N is the last task actually committed anywhere — set
   `task_index` to it, whatever `state.json` said.
   c. No subject matches in any target (a run that predates the convention) →
      keep the existing `task_index` and record in `report.md` that git could
      not confirm it.
   d. Run every target's test command. If any fails, the last task is not
      really done: do not advance past it — `next_action` is an implementer
      carrying the failure output, in that target's `workdir`, under the same
      retry budget as Phase 2.
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
