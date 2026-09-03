"""Today's gatekeeper behaviour, pinned before it changes."""
import time

from omni_hook_harness import HookCase


class OwnershipTest(HookCase):
    def test_bound_session_is_blocked_from_stopping(self):
        self.write_run("r1", session_id="s1")
        out = self.run_hook(session_id="s1")
        self.assertEqual(out.get("decision"), "block")
        self.assertIn("spawn implementer for task 3", out.get("reason", ""))

    def test_unbound_run_offers_once_then_stays_silent(self):
        self.write_run("r1", session_id=None)
        first = self.run_hook(session_id="s2")
        self.assertEqual(first.get("decision"), "block")
        # the id's exact shape is Task 2's business; here it only matters
        # that the session was offered the run exactly once
        self.assertEqual(len(self.read_state("r1")["adopt_offers"]), 1)
        self.assertEqual(self.run_hook(session_id="s2"), {})

    def test_run_bound_to_another_session_is_ignored(self):
        self.write_run("r1", session_id="s1")
        self.assertEqual(self.run_hook(session_id="s2"), {})

    def test_terminal_phase_never_blocks(self):
        self.write_run("r1", session_id="s1", phase="done")
        self.assertEqual(self.run_hook(session_id="s1"), {})

    def test_unparseable_state_fails_open(self):
        path = self.write_run("r1", session_id="s1")
        with open(path, "w") as f:
            f.write("{not json")
        self.assertEqual(self.run_hook(session_id="s1"), {})

    def test_safety_valve_blocks_the_run_not_the_session(self):
        self.write_run("r1", session_id="s1", gk_blocks=15,
                       gk_fingerprint="implementing|2|0")
        out = self.run_hook(session_id="s1")
        self.assertNotIn("decision", out)
        self.assertEqual(self.read_state("r1")["phase"], "blocked")


class HostPrefixTest(HookCase):
    """`OMNI_HOST` names the host the hook is running inside, so the same
    gatekeeper.py wired into codex qualifies ids as `codex-` and cannot be
    confused with a Claude Code session."""

    CODEX = {"OMNI_HOST": "codex"}

    def test_default_host_is_still_claude(self):
        self.write_run("r1", session_id=None)
        self.run_hook(session_id="s2")
        self.assertEqual(self.read_state("r1")["adopt_offers"], ["claude-s2"])

    def test_codex_qualifies_ids_with_the_codex_prefix(self):
        self.write_run("r1", session_id=None)
        out = self.run_hook(session_id="s2", env=self.CODEX)
        self.assertEqual(out.get("decision"), "block")
        self.assertEqual(self.read_state("r1")["adopt_offers"], ["codex-s2"])

    def test_codex_recognises_its_own_bound_session(self):
        self.write_run("r1", session_id="codex-s1")
        out = self.run_hook(session_id="s1", env=self.CODEX)
        self.assertEqual(out.get("decision"), "block")
        self.assertIn("spawn implementer for task 3", out.get("reason", ""))

    def test_codex_session_is_not_offered_a_claude_owned_run(self):
        self.write_run("r1", session_id="claude-s1")
        self.assertEqual(self.run_hook(session_id="s1", env=self.CODEX), {})

    def test_claude_session_is_not_offered_a_codex_owned_run(self):
        self.write_run("r1", session_id="codex-s1")
        self.assertEqual(self.run_hook(session_id="s1"), {})

    def test_codex_takeover_cannot_steal_a_claude_owned_run(self):
        self.write_run("r1", session_id="claude-s1",
                       takeover_requested=int(time.time()),
                       takeover_cwd="/repo")
        self.run_hook(session_id="s9", env=self.CODEX)
        self.assertEqual(self.read_state("r1")["session_id"], "claude-s1")

    def test_codex_takeover_claims_a_codex_owned_run(self):
        self.write_run("r1", session_id="codex-s1",
                       takeover_requested=int(time.time()),
                       takeover_cwd="/repo")
        self.run_hook(session_id="s9", env=self.CODEX)
        self.assertEqual(self.read_state("r1")["session_id"], "codex-s9")

    def test_an_unknown_host_falls_back_to_claude(self):
        self.write_run("r1", session_id=None)
        self.run_hook(session_id="s2", env={"OMNI_HOST": "not-a-host"})
        self.assertEqual(self.read_state("r1")["adopt_offers"], ["claude-s2"])
