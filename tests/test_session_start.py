"""The session-start notice. Read-only: it must never write state.json."""
from omni_hook_harness import HookCase


class SessionStartTest(HookCase):
    def notice(self, **kw):
        return self.run_hook(hook="session_start.py", event="SessionStart",
                             **kw).get("systemMessage", "")

    def test_stranded_run_in_this_directory_is_announced(self):
        self.write_run("r1", session_id="claude-dead")
        text = self.notice(session_id="fresh", cwd="/repo")
        self.assertIn("r1", text)
        self.assertIn("/omni-resume", text)

    def test_notice_never_writes_state(self):
        self.write_run("r1", session_id="claude-dead")
        before = self.read_state("r1")
        self.notice(session_id="fresh", cwd="/repo")
        self.assertEqual(self.read_state("r1"), before)

    def test_run_owned_by_this_session_is_not_announced(self):
        self.write_run("r1", session_id="claude-fresh")
        self.assertEqual(self.notice(session_id="fresh", cwd="/repo"), "")

    def test_run_in_another_directory_is_not_announced(self):
        self.write_run("r1", session_id="claude-dead", repo="/other",
                       workdir="/other")
        self.assertEqual(self.notice(session_id="fresh", cwd="/repo"), "")

    def test_finished_run_is_not_announced(self):
        self.write_run("r1", session_id="claude-dead", phase="done")
        self.assertEqual(self.notice(session_id="fresh", cwd="/repo"), "")

    def test_other_hosts_run_is_announced_naming_the_host(self):
        self.write_run("r1", session_id="opencode-dead")
        text = self.notice(session_id="fresh", cwd="/repo")
        self.assertIn("opencode", text)

    def test_unparseable_state_fails_open(self):
        path = self.write_run("r1", session_id="claude-dead")
        with open(path, "w") as f:
            f.write("{not json")
        self.assertEqual(self.notice(session_id="fresh", cwd="/repo"), "")
