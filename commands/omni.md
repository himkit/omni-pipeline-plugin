---
description: Start a omni run — brainstorm the idea into a locked spec, then autonomous plan → implement (TDD) → review loop → deliver on a feature branch
argument-hint: <feature idea>
---

Invoke the `pipeline` skill (namespaced `omni:pipeline` where the host
namespaces plugin skills) and follow it exactly, starting at Phase 0
(brainstorm) with this feature idea:

$ARGUMENTS

If no idea was given, ask for one before doing anything else.

Reminders that override any competing habit:
- Brainstorm is interactive; everything after spec approval + run-config is
  zero-touch — do not ask the human anything past that point.
- Where this host has a gatekeeper it will not let the session stop while the
  run is mid-pipeline; where it has none, you keep going anyway. The only
  exits are done, blocked (with a written reason), or /omni-abort.
