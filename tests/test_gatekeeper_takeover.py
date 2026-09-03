"""Host-qualified ownership and human-triggered handover."""
import time

from omni_hook_harness import HookCase


class HostPrefixTest(HookCase):
    def test_owner_is_recorded_with_the_host_prefix(self):
        self.write_run("r1", session_id=None)
        self.run_hook(session_id="s2")
        self.assertIn("claude-s2", self.read_state("r1")["adopt_offers"])

    def test_prefixed_owner_recognises_its_own_session(self):
        self.write_run("r1", session_id="claude-s1")
        self.assertEqual(self.run_hook(session_id="s1").get("decision"), "block")

    def test_legacy_unprefixed_owner_still_recognised(self):
        self.write_run("r1", session_id="s1")
        self.assertEqual(self.run_hook(session_id="s1").get("decision"), "block")

    def test_run_owned_by_the_other_host_is_left_alone(self):
        self.write_run("r1", session_id="opencode-s1")
        self.assertEqual(self.run_hook(session_id="s1"), {})
        self.assertEqual(self.read_state("r1")["session_id"], "opencode-s1")


class TakeoverTest(HookCase):
    def test_fresh_request_hands_the_run_over_and_clears_the_flag(self):
        self.write_run("r1", session_id="claude-dead",
                       takeover_requested=int(time.time()), takeover_cwd="/repo")
        out = self.run_hook(session_id="alive", cwd="/repo")
        state = self.read_state("r1")
        self.assertEqual(out.get("decision"), "block")
        self.assertEqual(state["session_id"], "claude-alive")
        self.assertEqual(state["prev_owners"], ["claude-dead"])
        self.assertNotIn("takeover_requested", state)
        self.assertNotIn("takeover_cwd", state)

    def test_expired_request_is_ignored(self):
        self.write_run("r1", session_id="claude-dead",
                       takeover_requested=int(time.time()) - 400,
                       takeover_cwd="/repo")
        self.assertEqual(self.run_hook(session_id="alive", cwd="/repo"), {})
        self.assertEqual(self.read_state("r1")["session_id"], "claude-dead")

    def test_request_from_an_unrelated_directory_is_ignored(self):
        self.write_run("r1", session_id="claude-dead",
                       takeover_requested=int(time.time()),
                       takeover_cwd="/somewhere/else")
        self.assertEqual(self.run_hook(session_id="alive", cwd="/repo"), {})
        self.assertEqual(self.read_state("r1")["session_id"], "claude-dead")

    def test_a_run_owned_by_the_other_host_cannot_be_claimed(self):
        self.write_run("r1", session_id="opencode-dead",
                       takeover_requested=int(time.time()), takeover_cwd="/repo")
        self.assertEqual(self.run_hook(session_id="alive", cwd="/repo"), {})
        self.assertEqual(self.read_state("r1")["session_id"], "opencode-dead")

    def test_unowned_run_can_be_claimed_by_request(self):
        self.write_run("r1", session_id=None,
                       takeover_requested=int(time.time()), takeover_cwd="/repo")
        out = self.run_hook(session_id="alive", cwd="/repo")
        self.assertEqual(out.get("decision"), "block")
        self.assertEqual(self.read_state("r1")["session_id"], "claude-alive")
        self.assertEqual(self.read_state("r1").get("prev_owners"), None)

    def test_garbage_in_the_flag_fails_open(self):
        self.write_run("r1", session_id="claude-dead",
                       takeover_requested="not-a-number", takeover_cwd="/repo")
        self.assertEqual(self.run_hook(session_id="alive", cwd="/repo"), {})


class RevocationTest(HookCase):
    def test_previous_owner_is_told_once_that_it_lost_the_run(self):
        self.write_run("r1", session_id="claude-new",
                       prev_owners=["claude-old"])
        out = self.run_hook(session_id="old")
        self.assertEqual(out.get("decision"), "block")
        self.assertIn("no longer own", out.get("reason", ""))
        self.assertIn("claude-old", self.read_state("r1")["revoked_notified"])

    def test_previous_owner_is_never_told_twice(self):
        self.write_run("r1", session_id="claude-new",
                       prev_owners=["claude-old"],
                       revoked_notified=["claude-old"])
        self.assertEqual(self.run_hook(session_id="old"), {})

    def test_current_owner_is_unaffected_by_prev_owners(self):
        self.write_run("r1", session_id="claude-new",
                       prev_owners=["claude-old"])
        self.assertEqual(self.run_hook(session_id="new").get("decision"), "block")


class OfferWordingTest(HookCase):
    """A run left unbound with no flag (created before flags existed) is still
    offered — but the offer must not tell the model to write session_id, which
    the skill now forbids outright."""

    def test_offer_asks_for_the_flag_not_for_session_id(self):
        self.write_run("r1", session_id=None)
        reason = self.run_hook(session_id="s2").get("reason", "")
        self.assertIn("takeover_requested", reason)
        self.assertIn("takeover_cwd", reason)
        self.assertNotIn('"session_id"', reason)


class ClaimReachabilityTest(HookCase):
    """A claim must reach the run it names, whatever else is in the runs dir."""

    def test_blocked_run_can_be_claimed_without_blocking_the_stop(self):
        # The commonest resume case: the valve fired, or a human was asked a
        # question. Ownership must still move — but a blocked run never traps
        # a session, so the hook stays silent.
        self.write_run("r1", session_id="claude-dead", phase="blocked",
                       blocked_reason="needs a human answer",
                       takeover_requested=int(time.time()), takeover_cwd="/repo")
        out = self.run_hook(session_id="alive", cwd="/repo")
        self.assertEqual(out, {})
        self.assertEqual(self.read_state("r1")["session_id"], "claude-alive")

    def test_a_claim_is_not_starved_by_an_earlier_run(self):
        self.write_run("r1-first", session_id="claude-alive")
        self.write_run("r2-second", session_id="claude-dead",
                       takeover_requested=int(time.time()), takeover_cwd="/repo")
        out = self.run_hook(session_id="alive", cwd="/repo")
        self.assertEqual(out.get("decision"), "block")
        self.assertEqual(self.read_state("r2-second")["session_id"], "claude-alive")

    def test_reclaiming_clears_stale_revocation_bookkeeping(self):
        self.write_run("r1", session_id="claude-b",
                       prev_owners=["claude-a"], revoked_notified=["claude-a"],
                       takeover_requested=int(time.time()), takeover_cwd="/repo")
        self.run_hook(session_id="a", cwd="/repo")
        state = self.read_state("r1")
        self.assertEqual(state["session_id"], "claude-a")
        self.assertNotIn("claude-a", state.get("prev_owners") or [])
        self.assertNotIn("claude-a", state.get("revoked_notified") or [])
        self.assertIn("claude-b", state["prev_owners"])
