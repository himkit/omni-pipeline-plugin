"""Prompts are shared by every host, so they must not name one. Host-specific
notes belong in hosts/README.md; the hooks and adapters know which host they
run in. Guards against the drift that used to need a CLAUDE.md warning."""
import json
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROMPT_DIRS = ("skills", "agents", "commands")


def labels():
    with open(os.path.join(ROOT, "hosts", "registry.json")) as f:
        reg = json.load(f)
    out = set()
    for host, entry in reg.items():
        out.add(host)
        out.add(entry["label"])
    return sorted(out, key=len, reverse=True)


def prompt_files():
    for d in PROMPT_DIRS:
        for dirpath, _, files in os.walk(os.path.join(ROOT, d)):
            for name in files:
                if name.endswith(".md"):
                    yield os.path.join(dirpath, name)


class PromptNeutralityTest(unittest.TestCase):
    def test_no_prompt_names_a_host(self):
        offenders = []
        patterns = [re.compile(r"\b%s\b" % re.escape(l), re.IGNORECASE) for l in labels()]
        for path in prompt_files():
            with open(path) as f:
                for lineno, line in enumerate(f, 1):
                    for pat in patterns:
                        if pat.search(line):
                            offenders.append("%s:%d: %s" % (
                                os.path.relpath(path, ROOT), lineno, line.strip()))
        self.assertEqual(offenders, [], "\n" + "\n".join(offenders))

    def test_orchestrator_prompt_exists_and_is_neutral_frontmatter(self):
        path = os.path.join(ROOT, "agents", "orchestrator.md")
        self.assertTrue(os.path.isfile(path))
        with open(path) as f:
            head = f.read().split("---")[1]
        self.assertIn("name: orchestrator", head)
        self.assertNotIn("mode:", head)
        self.assertNotIn("permission:", head)
