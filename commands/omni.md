---
description: Start a omni run — brainstorm the idea into a locked spec, then autonomous plan → implement (TDD) → review loop → deliver on a feature branch
argument-hint: <feature idea>
---

Invoke the `omni:pipeline` skill and follow it exactly, starting at Phase 0
(brainstorm) with this feature idea:

$ARGUMENTS

If no idea was given, ask for one before doing anything else.

Reminders that override any competing habit:
- Brainstorm is interactive; everything after spec approval + run-config is
  zero-touch — do not ask the human anything past that point.
- The Stop hook will not let this session stop while the run is mid-pipeline.
  The only exits are done, blocked (with a written reason), or /omni-abort.
