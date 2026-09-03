# omni-pipeline-plugin

## Repo conventions

### Commit identity

Commit with the GitHub noreply address, never a work address:

```
Đạt Phạm <4756487+phongthanfz@users.noreply.github.com>
```

`git config user.email` is already set to this locally. The repo is intended to
go public, and commit metadata is permanent once pushed — a work address in the
author field cannot be taken back from forks, clones, or closed pull requests.

History was rewritten on 2026-09-03 to replace an earlier `@onemount.com`
address across all commits. The old address still appears on the commits
attached to closed PR #1, which GitHub keeps regardless of a rewrite; that was
accepted as out of scope.

### Branch protection

`main` has no ruleset yet. GitHub refuses to create one while the repo is
private under a free org plan:

```
Upgrade to GitHub Pro or make this repository public to enable this feature.
```

The intended ruleset — block force push, block deletion, require a PR before
merge, repo admin bypass — applies as soon as the repo is public.

## Tests

Both suites must pass before a push:

```bash
python3 -m pytest tests -q
```

```bash
bun test tests/omni-gatekeeper.test.ts
```

The Python hooks (`hooks/gatekeeper.py`, `hooks/session_start.py`) and the
opencode plugin (`.opencode-plugin/plugins/omni-gatekeeper.ts`) are two ports of
the same gatekeeper logic. A change to the ownership, prefix, or safety-valve
rules in one has to land in the other, and both list every host in `KNOWN_HOSTS`
— an omission there lets one host take over another host's run.
