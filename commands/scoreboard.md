---
description: Scoreboard for omnislash runs — phase, task progress, review iteration, branch
argument-hint: [run-id]
---

Show the state of omnislash runs from `~/.omni-pipeline/runs/*/state.json`.

1. Read every `state.json` (with the argument `$ARGUMENTS` as a run-id filter
   if given). No runs directory or no matches → say so and stop.
2. Render a scoreboard table: run-id, phase, task i/n, review iter, branch,
   workdir, updated_at. A run whose `targets` has more than one entry shows
   `<n> targets` in the workdir column and, under its row, one indented line
   per target: `name — isolation — workdir`. Terminal phases
   (done/blocked/aborted) go below active runs.
3. For a `blocked` run, quote its `blocked_reason` and point at `/omnislash:reconnect`.
   For a `done` run, point at its `report.md`.

Read-only — do not modify any state file.
