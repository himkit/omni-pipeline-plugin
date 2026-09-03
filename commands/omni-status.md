---
description: Scoreboard for omni runs — phase, task progress, review iteration, branch
argument-hint: [run-id]
---

Show the state of omni runs from `~/.omni-pipeline/runs/*/state.json`.

1. Read every `state.json` (with the argument `$ARGUMENTS` as a run-id filter
   if given). No runs directory or no matches → say so and stop.
2. Render a scoreboard table: run-id, phase, task i/n, review iter, branch,
   workdir, updated_at. Terminal phases (done/blocked/aborted) go below active
   runs.
3. For a `blocked` run, quote its `blocked_reason` and point at `/omni-resume`.
   For a `done` run, point at its `report.md`.

Read-only — do not modify any state file.
