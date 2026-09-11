"""Hermes Agent loads a Python plugin and calls `register(ctx)`. The adapter's
whole job is to bridge Hermes' two usable hook points onto the same two Python
hooks every other host runs, with `OMNI_HOST=hermes` set.

Hermes has no Stop hook. `pre_verify` is the one hook whose return value can
keep the agent going, and it accepts the Claude-Code Stop shape, so the
gatekeeper's stdout crosses unchanged apart from the wrapper.
"""
import importlib.util
import json
import os
import sys
import unittest

import yaml

from omni_hook_harness import HookCase

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADAPTER = os.path.join(ROOT, ".hermes-plugin")


def load_adapter():
    """Import `.hermes-plugin/__init__.py` by path — its directory name is not
    a Python identifier, so it can never be imported by name."""
    spec = importlib.util.spec_from_file_location(
        "omni_hermes_adapter", os.path.join(ADAPTER, "__init__.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeCtx:
    """The slice of Hermes' PluginContext the adapter touches."""

    def __init__(self):
        self.hooks = {}
        self.skills = {}

    def register_hook(self, name, callback):
        self.hooks.setdefault(name, []).append(callback)

    def register_skill(self, name, path):
        self.skills[name] = path


class ManifestTest(unittest.TestCase):
    def test_manifest_declares_the_two_hooks_the_adapter_registers(self):
        with open(os.path.join(ADAPTER, "plugin.yaml")) as f:
            manifest = yaml.safe_load(f)
        self.assertEqual(manifest["name"], "omnislash")
        self.assertEqual(sorted(manifest["provides_hooks"]),
                         ["pre_llm_call", "pre_verify"])

    def test_manifest_version_matches_the_other_manifests(self):
        with open(os.path.join(ADAPTER, "plugin.yaml")) as f:
            manifest = yaml.safe_load(f)
        with open(os.path.join(ROOT, "package.json")) as f:
            self.assertEqual(str(manifest["version"]), json.load(f)["version"])


class RegisterTest(unittest.TestCase):
    def setUp(self):
        self.adapter = load_adapter()
        self.ctx = FakeCtx()
        self.adapter.register(self.ctx)

    def test_registers_the_enforcer_and_the_reminder(self):
        self.assertEqual(sorted(self.ctx.hooks), ["pre_llm_call", "pre_verify"])

    def test_registers_every_shipped_skill_by_its_directory_name(self):
        skills_dir = os.path.join(ROOT, "skills")
        expected = sorted(name for name in os.listdir(skills_dir)
                          if os.path.isfile(os.path.join(skills_dir, name, "SKILL.md")))
        self.assertEqual(sorted(self.ctx.skills), expected)
        for name, path in self.ctx.skills.items():
            self.assertEqual(os.path.realpath(str(path)),
                             os.path.join(skills_dir, name, "SKILL.md"))
            # register_skill rejects a str: hermes disables the whole plugin.
            self.assertFalse(isinstance(path, str))

    def test_plugin_root_is_the_repo_that_ships_the_hooks(self):
        self.assertEqual(self.adapter.plugin_root(), ROOT)


class EnforcerTest(HookCase):
    """pre_verify carries the gatekeeper's verdict, or nothing at all."""

    def setUp(self):
        super().setUp()
        self.adapter = load_adapter()
        self.ctx = FakeCtx()
        os.environ["OMNI_HOME"] = self.home
        self.addCleanup(os.environ.pop, "OMNI_HOME", None)
        self.adapter.register(self.ctx)
        self.pre_verify = self.ctx.hooks["pre_verify"][0]
        self.pre_llm_call = self.ctx.hooks["pre_llm_call"][0]

    def test_bound_hermes_run_keeps_the_agent_going(self):
        self.write_run("r1", session_id="hermes-s1", workdir=os.getcwd(),
                       repo=os.getcwd())
        out = self.pre_verify(session_id="s1", coding=True, attempt=0)
        self.assertEqual(out["action"], "continue")
        self.assertIn("spawn implementer for task 3", out["message"])

    def test_a_run_owned_by_another_host_lets_the_turn_finish(self):
        self.write_run("r1", session_id="claude-s1", workdir=os.getcwd(),
                       repo=os.getcwd())
        self.assertIsNone(self.pre_verify(session_id="s1", coding=True, attempt=0))

    def test_no_run_lets_the_turn_finish(self):
        self.assertIsNone(self.pre_verify(session_id="s1", coding=True, attempt=0))

    def test_a_broken_gatekeeper_never_traps_the_turn(self):
        self.write_run("r1", session_id="hermes-s1", workdir=os.getcwd(),
                       repo=os.getcwd())
        self.adapter.HOOKS = "/nonexistent/hooks"
        self.addCleanup(setattr, self.adapter, "HOOKS",
                        os.path.join(ROOT, "hooks"))
        self.assertIsNone(self.pre_verify(session_id="s1", coding=True, attempt=0))

    def test_the_reminder_is_injected_on_the_first_turn_only(self):
        self.write_run("r1", session_id="claude-s1", workdir=os.getcwd(),
                       repo=os.getcwd())
        out = self.pre_llm_call(session_id="s1", is_first_turn=True)
        self.assertIn("Unfinished run(s)", out["context"])
        self.assertIsNone(self.pre_llm_call(session_id="s1", is_first_turn=False))

    def test_the_reminder_is_silent_when_no_run_is_stranded_here(self):
        self.assertIsNone(self.pre_llm_call(session_id="s1", is_first_turn=True))


class HostEnvTest(unittest.TestCase):
    def test_hooks_run_as_the_hermes_host(self):
        """Without OMNI_HOST the hooks default to Claude Code, and this session
        would adopt runs belonging to another host."""
        adapter = load_adapter()
        self.assertEqual(adapter.hook_env()["OMNI_HOST"], "hermes")


if __name__ == "__main__":
    sys.exit(unittest.main())
