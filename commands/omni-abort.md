---
description: Abort a omni run (gg) — disarm the gatekeeper, optionally clean up branch and worktree
argument-hint: [run-id]
---

Abort the omni run matching `$ARGUMENTS` (no argument: the single non-terminal
run under `~/.omni-pipeline/runs/`; several candidates: list them and ask which).

1. Set `"phase": "aborted"` in its `state.json` immediately — this disarms the
   gatekeeper, nothing can stay trapped.
2. Report what exists: branch, commits so far (`git log --oneline` against the
   base branch), worktree path if any, run dir path.
3. Ask the user — one question, explicit options, and default to keeping
   everything if they don't care:
   - keep everything (state marked aborted, code stays for salvage)
   - delete worktree + branch + run dir (full cleanup)
   Only delete after an explicit yes. Deleting a worktree:
   `git worktree remove <path> --force`, then `git branch -D omni/<feature_slug>` from
   the main repo, then remove the run dir.
