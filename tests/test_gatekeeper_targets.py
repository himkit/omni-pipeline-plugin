"""A run with several targets lives in several directories. Every directory
check the gatekeeper makes must accept any of them, and a broken `targets`
must fall back to the primary pair instead of hiding the run."""
import time

from omni_hook_harness import HookCase

TARGETS = [
    {"name": "api", "repo": "/repo", "workdir": "/repo",
     "isolation": "in-place", "branch": "omni/dark-mode",
     "base_branch": "main", "test_command": "go test ./..."},
    {"name": "web", "repo": "/web", "workdir": "/wt/web",
     "isolation": "worktree", "branch": "omni/dark-mode",
     "base_branch": "develop", "test_command": "bun test"},
]


class TargetDirectoriesTest(HookCase):
    def test_unbound_run_is_offered_from_a_second_targets_worktree(self):
        self.write_run("r1", session_id=None, targets=TARGETS)
        out = self.run_hook(session_id="s2", cwd="/wt/web/src")
        self.assertEqual(out.get("decision"), "block")
        self.assertEqual(self.read_state("r1")["adopt_offers"], ["claude-s2"])

    def test_unbound_run_is_offered_from_a_second_targets_repo(self):
        self.write_run("r1", session_id=None, targets=TARGETS)
        out = self.run_hook(session_id="s2", cwd="/web")
        self.assertEqual(out.get("decision"), "block")

    def test_unrelated_directory_is_still_ignored(self):
        self.write_run("r1", session_id=None, targets=TARGETS)
        self.assertEqual(self.run_hook(session_id="s2", cwd="/elsewhere"), {})
        self.assertNotIn("adopt_offers", self.read_state("r1"))

    def test_takeover_without_a_cwd_flag_matches_a_second_target(self):
        self.write_run("r1", session_id="claude-dead", targets=TARGETS,
                       takeover_requested=int(time.time()))
        out = self.run_hook(session_id="alive", cwd="/wt/web")
        self.assertEqual(out.get("decision"), "block")
        self.assertEqual(self.read_state("r1")["session_id"], "claude-alive")

    def test_revocation_names_every_target_directory(self):
        self.write_run("r1", session_id="claude-new",
                       prev_owners=["claude-old"], targets=TARGETS)
        reason = self.run_hook(session_id="old").get("reason", "")
        self.assertIn("no longer own", reason)
        self.assertIn("/repo", reason)
        self.assertIn("/wt/web", reason)


class MalformedTargetsTest(HookCase):
    def test_targets_that_are_not_a_list_fall_back_to_the_primary_pair(self):
        self.write_run("r1", session_id=None, targets="not-a-list")
        out = self.run_hook(session_id="s2", cwd="/repo")
        self.assertEqual(out.get("decision"), "block")

    def test_target_entries_that_are_not_objects_are_skipped(self):
        self.write_run("r1", session_id=None,
                       targets=[None, "str", 7, {"workdir": 3, "repo": None}])
        out = self.run_hook(session_id="s2", cwd="/repo")
        self.assertEqual(out.get("decision"), "block")

    def test_garbage_targets_do_not_widen_the_match(self):
        self.write_run("r1", session_id=None, targets=[{"workdir": 3}])
        self.assertEqual(self.run_hook(session_id="s2", cwd="/elsewhere"), {})
