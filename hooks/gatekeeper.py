#!/usr/bin/env python3
"""omni gatekeeper — Stop-hook enforcer for the autonomous pipeline.

Fires at the end of every assistant turn. If the current session owns a run
whose phase is mid-pipeline (planning/implementing/reviewing/delivering), the
stop is blocked and the model is told to continue.

Design rules:
- FAIL-OPEN: any error, missing file, or bad JSON must allow the stop.
  A broken gatekeeper must never trap a session.
- Ownership handshake: the gatekeeper never adopts a session on its own.
  For an unbound run (session_id null) whose repo/workdir (or resume_cwd,
  written by /omni-resume) contains this session's cwd, it blocks ONCE with
  an offer naming this session's id; the orchestrator binds by writing that
  id into state.json itself. A session that ignores the offer is never
  blocked by that run again (tracked in adopt_offers), so unrelated sessions
  in the same repo lose at most one turn.
- Safety valve, gatekeeper-enforced: the block counter (`gk_blocks`) and the
  progress signature it is keyed to (`gk_fingerprint`) are owned and written
  by this hook alone, never read from what the orchestrator wrote. The
  counter resets only when `phase`/`task_index`/`review_iter` actually
  advance, so a model that rewrites state on an idle turn cannot disarm the
  valve. MAX_CONSECUTIVE_BLOCKS blocks without real progress force-mark the
  run blocked and let the session stop. `stop_blocks` is a display mirror for
  /omni-status: written here, never trusted here.
"""
import json
import os
import sys
import time

RUNNING_PHASES = {"planning", "implementing", "reviewing", "delivering"}
MAX_CONSECUTIVE_BLOCKS = 15
TAKEOVER_TTL_SEC = 300
# OMNI_HOME exists so tests never touch the user's real runs.
OMNI_HOME = os.environ.get("OMNI_HOME") or os.path.expanduser("~/.omni-pipeline")
RUNS_DIR = os.path.join(OMNI_HOME, "runs")
# One gatekeeper.py serves every host: Claude Code, codex (via
# ~/.codex/hooks.json) and opencode. OMNI_HOST says which one is running it, so
# two hosts sharing RUNS_DIR can never be mistaken for each other. Unset or
# unrecognised means Claude Code, the host that has always run this file.
KNOWN_HOSTS = ("claude", "codex", "opencode")
_HOST = (os.environ.get("OMNI_HOST") or "").strip().lower()
HOST = _HOST if _HOST in KNOWN_HOSTS else "claude"
HOST_PREFIX = HOST + "-"
KNOWN_PREFIXES = tuple(h + "-" for h in KNOWN_HOSTS)


def write_state(path, state):
    try:
        state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state, f, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception:
        pass


def inside(cwd, base):
    """True if cwd is base or under it, symlink-safe (/tmp vs /private/tmp)."""
    if not cwd or not base:
        return False
    try:
        cwd = os.path.realpath(cwd)
        base = os.path.realpath(base)
    except Exception:
        return False
    return cwd == base or cwd.startswith(base.rstrip("/") + "/")


def qualify(sid):
    """This host's session id, namespaced so two hosts sharing the runs dir
    can never be mistaken for each other."""
    if not sid:
        return sid
    return sid if sid.startswith(KNOWN_PREFIXES) else HOST_PREFIX + sid


def owner_prefix(bound):
    """Which host wrote `bound`. An id with no known prefix predates prefixing,
    so it belongs to whoever is reading it."""
    for p in KNOWN_PREFIXES:
        if bound.startswith(p):
            return p
    return HOST_PREFIX


def same_owner(bound, sid):
    """True if `bound` names this very session, prefixed or legacy."""
    if not bound:
        return False
    if owner_prefix(bound) != HOST_PREFIX:
        return False
    return bound == qualify(sid) or bound == sid


def takeover_claim(state, cwd, now):
    """True if a fresh, directory-matched /omni-resume request should hand this
    session the run.

    Never a liveness guess: nothing here asks whether the old owner is alive,
    because no hook fires while a foreground subagent runs and a busy session is
    indistinguishable from a dead one. A human asked for this handover.
    """
    try:
        requested = int(state.get("takeover_requested") or 0)
    except (TypeError, ValueError):
        return False
    if requested <= 0 or now - requested > TAKEOVER_TTL_SEC:
        return False
    claim_cwd = state.get("takeover_cwd")
    bases = (claim_cwd,) if claim_cwd else (state.get("workdir"), state.get("repo"))
    return any(inside(cwd, b) for b in bases)


def grant_claim(state, cwd, now, me):
    """Hand `me` the run if a fresh, directory-matched request asks for it.

    Mutates `state`; returns True when ownership actually moved. Taking a run
    back also clears this session out of the revocation bookkeeping, so a later
    handover away from it is announced again instead of being swallowed.
    """
    bound = state.get("session_id")
    if not takeover_claim(state, cwd, now):
        return False
    if bound is not None and owner_prefix(bound) != HOST_PREFIX:
        return False
    if bound and bound != me:
        kept = [o for o in (state.get("prev_owners") or []) if o != bound]
        state["prev_owners"] = kept + [bound]
    for key in ("prev_owners", "revoked_notified"):
        if state.get(key):
            state[key] = [o for o in state[key] if o != me]
    state["session_id"] = me
    for key in ("takeover_requested", "takeover_cwd", "adopt_offers",
                "resume_cwd"):
        state.pop(key, None)
    return True


def fingerprint(state):
    """Signature of real pipeline progress.

    Changes only when the orchestrator moves the state machine forward, which
    is what makes the block counter meaningful without trusting the model.
    """
    return "%s|%s|%s" % (
        state.get("phase"),
        state.get("task_index", 0),
        state.get("review_iter", 0),
    )


def counter(state):
    try:
        return int(state.get("gk_blocks") or 0)
    except (TypeError, ValueError):
        return 0


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    sid = data.get("session_id")
    cwd = data.get("cwd") or ""
    if not sid or not os.path.isdir(RUNS_DIR):
        return
    me = qualify(sid)

    now = time.time()

    # Pass 1 — grant handovers on EVERY run before deciding anything. The
    # decision pass returns on the first run it acts on, so a claim on a run
    # further down the list would otherwise be starved by an unrelated one. A
    # `blocked` run is claimable too: that is the commonest thing /omni-resume
    # is pointed at, and ownership has to move before the phase can be restored.
    enforceable = []
    for slug in sorted(os.listdir(RUNS_DIR)):
        state_path = os.path.join(RUNS_DIR, slug, "state.json")
        try:
            with open(state_path) as f:
                state = json.load(f)
        except Exception:
            continue
        phase = state.get("phase")
        if phase not in RUNNING_PHASES and phase != "blocked":
            continue
        if grant_claim(state, cwd, now, me):
            write_state(state_path, state)
        if phase in RUNNING_PHASES:
            enforceable.append((slug, state_path, state))

    # Pass 2 — enforce. A blocked run never reaches here: it must never trap a
    # session, whoever owns it.
    for slug, state_path, state in enforceable:
        bound = state.get("session_id")

        # Ownership moved while this session was mid-turn. Say so once — a
        # session that keeps spawning agents into a worktree it no longer owns
        # is the one failure this whole handover is meant to prevent.
        if not same_owner(bound, sid) and me in (state.get("prev_owners") or []):
            told = state.get("revoked_notified") or []
            if me in told:
                continue
            state["revoked_notified"] = told + [me]
            write_state(state_path, state)
            print(json.dumps({"decision": "block", "reason": (
                "[omni gatekeeper] Run '%s' now belongs to session %s. You no "
                "longer own it: spawn nothing, write nothing under %s. Tell the "
                "user it moved, then stop — you will not be blocked again." % (slug, state.get("session_id"), state.get("workdir"))
            )}))
            return

        if bound is None:
            offers = state.get("adopt_offers") or []
            if me in offers or sid in offers:
                continue  # offered before, session declined by not binding
            bases = (state.get("workdir"), state.get("repo"),
                     state.get("resume_cwd"))
            if not any(inside(cwd, b) for b in bases):
                continue
            offers.append(me)
            state["adopt_offers"] = offers
            write_state(state_path, state)
            print(json.dumps({"decision": "block", "reason": (
                "[omni gatekeeper] Unbound run '%s' (phase=%s) is in this "
                "session's directory. If you are its orchestrator, claim it: add "
                "\"takeover_requested\" (`date +%%s`) and \"takeover_cwd\" (`pwd`) "
                "to %s, then stop — this hook writes the session id itself and "
                "comes back with your next action (%s). If this is not your "
                "pipeline, ignore this and stop again; it will not block you twice."
                % (slug, state.get("phase"), state_path,
                   state.get("next_action") or "read state.json and plan.md in the run dir")
            )}))
            return
        elif not same_owner(bound, sid):
            continue

        # Bound to this session: handshake leftovers are no longer needed.
        state.pop("adopt_offers", None)
        state.pop("resume_cwd", None)

        # Gatekeeper-owned counter. Reset happens here, on observed progress —
        # never because the orchestrator zeroed a field.
        fp = fingerprint(state)
        blocks = 1 if state.get("gk_fingerprint") != fp else counter(state) + 1
        state["gk_fingerprint"] = fp
        state["gk_blocks"] = blocks
        state["stop_blocks"] = blocks  # display mirror for /omni-status

        if blocks > MAX_CONSECUTIVE_BLOCKS:
            state["phase"] = "blocked"
            state["blocked_reason"] = (
                "gatekeeper safety valve: %d consecutive stop-blocks with no "
                "progress past %s (phase|task_index|review_iter)"
                % (MAX_CONSECUTIVE_BLOCKS, fp)
            )
            write_state(state_path, state)
            print(json.dumps({
                "systemMessage": "[omni] run '%s' auto-blocked by safety valve. "
                                 "Inspect %s and resume with /omni-resume." % (slug, state_path)
            }))
            return

        write_state(state_path, state)
        reason = (
            "[omni gatekeeper] Run '%s' is mid-pipeline: phase=%s, "
            "task %s/%s, review iter %s. Next action: %s. "
            "Do NOT stop — continue the pipeline now, following the omni:pipeline skill. "
            "If that next action is already in flight (an agent you spawned has not "
            "returned yet), do NOT spawn it again — spawn subagents in the foreground "
            "so the turn ends only after they return. "
            "If you are genuinely blocked on something only a human can decide, set "
            "\"phase\": \"blocked\" with a blocked_reason in %s, explain it to the user, "
            "and then you may stop."
            % (
                slug,
                state.get("phase"),
                state.get("task_index", 0),
                state.get("task_total", "?"),
                state.get("review_iter", 0),
                state.get("next_action") or "read plan.md and state.json in the run dir, continue from there",
                state_path,
            )
        )
        print(json.dumps({"decision": "block", "reason": reason}))
        return


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
