---
description: Start a omni run — brainstorm the idea into a locked spec, then autonomous plan → implement (TDD) → review loop → deliver on a feature branch
agent: omni
---

Invoke the `pipeline` skill and follow it exactly, starting at Phase 0
(brainstorm) with this feature idea:

$ARGUMENTS

If no idea was given, ask for one before doing anything else.

Reminders that override any competing habit:
- Brainstorm is interactive; everything after spec approval + run-config is
  zero-touch — do not ask the human anything past that point.
- The omni-gatekeeper plugin re-prompts this session on `session.idle` while
  the run is mid-pipeline, so going quiet does not end the run. The only
  exits are done, blocked (with a written reason), or /omni-abort.
