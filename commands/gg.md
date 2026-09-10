---
description: Abort an omnislash run (gg) — disarm the gatekeeper, optionally clean up branches and worktrees
argument-hint: [run-id]
---

Abort the omnislash run matching `$ARGUMENTS` (no argument: the single non-terminal
run under `~/.omni-pipeline/runs/`; several candidates: list them and ask which).

1. Set `"phase": "aborted"` in its `state.json` immediately — this disarms the
   gatekeeper, nothing can stay trapped.
2. Report what exists, per target when there are several: branch, commits so
   far (`git log --oneline <base_branch>..omni/<feature_slug>` in its repo),
   worktree path for `worktree` targets, and the run dir path.
3. Ask the user — one question, explicit options, and default to keeping
   everything if they don't care:
   - keep everything (state marked aborted, code stays for salvage)
   - delete branches + worktrees + run dir (full cleanup)
   Only delete after an explicit yes. Then for each target: `worktree` →
   `git worktree remove <workdir> --force`, then `git branch -D omni/<feature_slug>`
   in its repo; `in-place` → `git checkout <base_branch>` in its repo, then
   `git branch -D omni/<feature_slug>`. A target whose worktree or branch does
   not exist is skipped, not an error — keep going and report it. Remove the
   run dir last.
