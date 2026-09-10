"""Codex loads the plugin's own hook manifest. It must name the host and run
the same two Python hooks Claude Code runs."""
import json
import os
import unittest

from omni_hook_harness import HookCase

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(rel):
    with open(os.path.join(ROOT, rel)) as f:
        return json.load(f)


class CodexManifestTest(unittest.TestCase):
    def test_manifest_points_at_skills_and_the_codex_hook_file(self):
        m = load(".codex-plugin/plugin.json")
        self.assertEqual(m["name"], "omnislash")
        self.assertEqual(m["skills"], "./skills/")
        self.assertEqual(m["hooks"], "./hooks/hooks-codex.json")

    def test_codex_hooks_set_the_host_and_use_the_plugin_root(self):
        h = load("hooks/hooks-codex.json")["hooks"]
        self.assertEqual(set(h), {"Stop", "SessionStart"})
        commands = [x["command"] for group in h.values()
                    for entry in group for x in entry["hooks"]]
        self.assertEqual(len(commands), 2)
        for c in commands:
            self.assertTrue(c.startswith("OMNI_HOST=codex "), c)
            self.assertIn("${CLAUDE_PLUGIN_ROOT}/hooks/", c)
        self.assertTrue(any("gatekeeper.py" in c for c in commands))
        self.assertTrue(any("session_start.py" in c for c in commands))

    def test_codex_and_claude_manifests_run_the_same_scripts(self):
        def scripts(rel):
            h = load(rel)["hooks"]
            return sorted(x["command"].split("/hooks/")[1].rstrip('"')
                          for group in h.values() for entry in group for x in entry["hooks"])
        self.assertEqual(scripts("hooks/hooks.json"), scripts("hooks/hooks-codex.json"))


class CodexStdinShapeTest(HookCase):
    """Codex's Stop payload carries fields Claude's does not. The hook must
    read only the shared ones and decide identically."""

    def run_codex_stop(self, session_id, cwd="/repo"):
        import subprocess, sys
        from omni_hook_harness import HOOKS_DIR
        payload = json.dumps({
            "session_id": session_id,
            "cwd": cwd,
            "hook_event_name": "Stop",
            "transcript_path": None,
            "model": "gpt-5-codex",
            "permission_mode": "default",
            "turn_id": "t-1",
            "stop_hook_active": False,
            "last_assistant_message": "done for now",
        })
        env = dict(os.environ, OMNI_HOME=self.home, OMNI_HOST="codex")
        proc = subprocess.run([sys.executable, os.path.join(HOOKS_DIR, "gatekeeper.py")],
                              input=payload, capture_output=True, text=True, env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout) if proc.stdout.strip() else {}

    def test_bound_codex_session_is_blocked(self):
        self.write_run("r1", session_id="codex-s1")
        out = self.run_codex_stop("s1")
        self.assertEqual(out.get("decision"), "block")
        self.assertIn("spawn implementer for task 3", out["reason"])

    def test_claude_owned_run_is_ignored_by_codex(self):
        self.write_run("r1", session_id="claude-s1")
        self.assertEqual(self.run_codex_stop("s1"), {})
