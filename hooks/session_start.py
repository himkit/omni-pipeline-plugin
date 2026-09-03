#!/usr/bin/env python3
"""omni session-start notice — says a run is stranded in this directory.

Read-only by design: it never writes state.json and never claims a run. Its
whole job is turning "the human has to remember there is a dead run" into
"the human is told the moment they open the right repo".

FAIL-OPEN like the gatekeeper: any error means no notice, never an error.
"""
import json
import os
import sys

RUNNING_PHASES = {"planning", "implementing", "reviewing", "delivering"}
RUNS_DIR = os.environ.get("OMNI_RUNS_DIR") or os.path.expanduser(
    "~/.claude/omni-plugins/runs")
HOST = "claude"
KNOWN_HOSTS = ("claude", "opencode")


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


def owner_host(bound):
    """Which host owns `bound`, or None when the run is unowned. An id with no
    known prefix predates prefixing and belongs to whoever is reading it."""
    if not bound:
        return None
    for host in KNOWN_HOSTS:
        if bound.startswith(host + "-"):
            return host
    return HOST


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    sid = data.get("session_id")
    cwd = data.get("cwd") or ""
    if not os.path.isdir(RUNS_DIR):
        return

    lines = []
    for slug in sorted(os.listdir(RUNS_DIR)):
        try:
            with open(os.path.join(RUNS_DIR, slug, "state.json")) as f:
                state = json.load(f)
        except Exception:
            continue
        if state.get("phase") not in RUNNING_PHASES:
            continue
        if not any(inside(cwd, b) for b in (state.get("workdir"), state.get("repo"))):
            continue
        bound = state.get("session_id")
        if sid and bound in (sid, "%s-%s" % (HOST, sid)):
            continue  # this very session already owns it
        host = owner_host(bound)
        lines.append("  - %s: phase=%s, task %s/%s, %s"
                     % (slug, state.get("phase"), state.get("task_index", 0),
                        state.get("task_total", "?"),
                        "unowned" if host is None else "owned by a %s session" % host))
        if host is not None and host != HOST:
            lines.append("    started in %s - resume it there, not here" % host)

    if not lines:
        return
    print(json.dumps({"systemMessage":
                      "[omni] Unfinished run(s) for this directory:\n"
                      + "\n".join(lines)
                      + "\nRun /omni-resume to take one over."}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
