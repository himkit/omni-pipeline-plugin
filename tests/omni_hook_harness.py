"""Drives a omni hook the way Claude Code does: JSON on stdin, JSON on stdout.

Black-box on purpose. The hook's contract with Claude Code is the thing worth
testing; its internals are free to move.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HOOKS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks")

DEFAULT_STATE = {
    "run_id": "2026-09-03-repo-dark-mode",
    "feature_slug": "dark-mode",
    "phase": "implementing",
    "session_id": None,
    "repo": "/repo",
    "workdir": "/repo",
    "branch": "omni/dark-mode",
    "task_index": 2,
    "task_total": 5,
    "review_iter": 0,
    "next_action": "spawn implementer for task 3",
}


class HookCase(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="omni-home-")
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        self.runs = os.path.join(self.home, "runs")
        os.makedirs(self.runs, exist_ok=True)

    def write_run(self, slug, **fields):
        """Create runs/<slug>/state.json. Any field can be overridden; passing
        None for a key that has a default still sets it to None."""
        d = os.path.join(self.runs, slug)
        os.makedirs(d, exist_ok=True)
        state = dict(DEFAULT_STATE)
        state.update(fields)
        path = os.path.join(d, "state.json")
        with open(path, "w") as f:
            json.dump(state, f)
        return path

    def read_state(self, slug):
        with open(os.path.join(self.runs, slug, "state.json")) as f:
            return json.load(f)

    def run_hook(self, hook="gatekeeper.py", session_id="s1", cwd="/repo",
                 event="Stop", env=None):
        """Returns the hook's stdout parsed as JSON, or {} when it printed nothing.

        `env` adds/overrides environment variables for the hook process, which is
        how a host other than the default (OMNI_HOST) is exercised.
        """
        payload = json.dumps({
            "session_id": session_id,
            "cwd": cwd,
            "hook_event_name": event,
            "transcript_path": "/dev/null",
        })
        hook_env = dict(os.environ, OMNI_HOME=self.home)
        hook_env.update(env or {})
        proc = subprocess.run(
            [sys.executable, os.path.join(HOOKS_DIR, hook)],
            input=payload, capture_output=True, text=True, env=hook_env)
        self.assertEqual(proc.returncode, 0,
                         "hooks must always exit 0; stderr=%s" % proc.stderr)
        out = proc.stdout.strip()
        return json.loads(out) if out else {}
