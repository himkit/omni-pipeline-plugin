"""hosts/registry.json is the source of truth about hosts. These tests keep it
well-formed and keep every reader (hooks, manifests, docs) in step with it."""
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTRY = os.path.join(ROOT, "hosts", "registry.json")
sys.path.insert(0, os.path.join(ROOT, "hooks"))

import omni_hosts  # noqa: E402


def registry():
    with open(REGISTRY) as f:
        return json.load(f)


class RegistryShapeTest(unittest.TestCase):
    REQUIRED = {"label", "tier", "prefix", "enforcer", "subagents", "commands",
                "adapter", "install", "verified"}

    def test_every_host_has_every_field(self):
        for host, entry in registry().items():
            self.assertEqual(self.REQUIRED - set(entry), set(),
                             "%s is missing fields" % host)

    def test_prefixes_are_unique_and_end_with_a_dash(self):
        prefixes = [e["prefix"] for e in registry().values()]
        self.assertEqual(len(prefixes), len(set(prefixes)))
        for p in prefixes:
            self.assertTrue(p.endswith("-"), p)

    def test_full_tier_hosts_have_an_adapter_directory_and_install_steps(self):
        for host, entry in registry().items():
            if entry["tier"] != "full":
                continue
            self.assertTrue(os.path.isdir(os.path.join(ROOT, entry["adapter"])),
                            "%s adapter %s missing" % (host, entry["adapter"]))
            self.assertTrue(entry["install"], "%s has no install steps" % host)

    def test_prefix_matches_id_or_is_documented(self):
        """Every shipped host's prefix is just its id plus a dash. The field
        exists so a host whose product name differs from its registry key can
        say so; nothing ships that way yet, and the loaders' fallback is
        `<id>-`, so a divergence here would be silent."""
        for host, entry in registry().items():
            self.assertEqual(entry["prefix"], host + "-", host)

    def test_tier_is_full_or_skills_only(self):
        for entry in registry().values():
            self.assertIn(entry["tier"], ("full", "skills-only"))


class LoaderTest(unittest.TestCase):
    def test_known_hosts_come_from_the_registry(self):
        self.assertEqual(omni_hosts.known_hosts(), tuple(registry().keys()))

    def test_prefixes_come_from_the_registry(self):
        reg = registry()
        self.assertEqual(omni_hosts.known_prefixes(),
                         tuple(e["prefix"] for e in reg.values()))
        for host, entry in reg.items():
            self.assertEqual(omni_hosts.host_prefix(host), entry["prefix"])

    def test_missing_registry_falls_back_to_the_builtin_three(self):
        os.environ["OMNI_REGISTRY"] = "/nonexistent/registry.json"
        try:
            self.assertEqual(omni_hosts.known_hosts(), ("claude", "codex", "opencode"))
            self.assertEqual(omni_hosts.known_prefixes(),
                             ("claude-", "codex-", "opencode-"))
            self.assertEqual(omni_hosts.host_prefix("codex"), "codex-")
        finally:
            del os.environ["OMNI_REGISTRY"]

    def test_current_host_defaults_to_claude(self):
        os.environ.pop("OMNI_HOST", None)
        self.assertEqual(omni_hosts.current_host(), "claude")
        os.environ["OMNI_HOST"] = "CODEX"
        try:
            self.assertEqual(omni_hosts.current_host(), "codex")
        finally:
            del os.environ["OMNI_HOST"]

    def test_unknown_host_falls_back_to_claude(self):
        os.environ["OMNI_HOST"] = "vim"
        try:
            self.assertEqual(omni_hosts.current_host(), "claude")
        finally:
            del os.environ["OMNI_HOST"]


class DocsAndVersionTest(unittest.TestCase):
    def test_hosts_readme_has_one_row_per_host(self):
        with open(os.path.join(ROOT, "hosts", "README.md")) as f:
            text = f.read()
        for host, entry in registry().items():
            row = "| %s |" % entry["label"]
            self.assertIn(row, text, "hosts/README.md lacks a row for %s" % host)
            self.assertIn("| %s |" % entry["tier"], text)

    def test_versions_agree(self):
        def version(rel):
            with open(os.path.join(ROOT, rel)) as f:
                return json.load(f)["version"]
        versions = {rel: version(rel) for rel in (
            "package.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json")}
        self.assertEqual(len(set(versions.values())), 1, versions)
