---
description: Resume an interrupted or blocked omni run in this session
argument-hint: [run-id]
---

Invoke the `omni:pipeline` skill and follow its **Resume protocol** for the
run matching `$ARGUMENTS` (no argument: the single non-terminal run under
`~/.claude/omni-plugins/runs/`; several candidates: list them and ask which).

Key steps the protocol requires, in this order:
1. Rebuild context: `state.json`, `spec.md`, `plan.md`, `git log` on the branch.
2. If phase is `blocked`, surface `blocked_reason` and get the human's answer
   before anything else.
3. Reconcile against git — git is the truth, `state.json` is only what the
   dead session intended. Stash a dirty worktree, read the last completed task
   out of the `(omni-task-N)` commit scopes, re-run the full test command, and
   write the reconciled `task_index` and `next_action`. Restore the working
   phase.
4. **Claim the run last, then stop.** Write `takeover_requested` (the output
   of `date +%s`) and `takeover_cwd` (the output of `pwd`). **Never write
   `session_id` yourself** — the gatekeeper holds this session's id and writes
   it at that turn boundary. End the turn immediately, spawning nothing: the
   claim expires after 5 minutes, so raising it before a long reconcile or a
   spawned agent would let it lapse unseen.
5. The gatekeeper comes back with your `next_action`. Zero-touch from there.
