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

The repo is public, and ruleset `protect-main` (id 22178947) is active on
`main`:

- `deletion` — the branch cannot be deleted
- `non_fast_forward` — no force pushes
- `pull_request` — changes land through a PR (0 approvals required)
- `required_status_checks` — the `python-hooks` and `bun` jobs from
  `.github/workflows/test.yml` must pass, and the branch must be up to date
  with `main` (strict)

Repo admins bypass all four (`bypass_mode: always`), so a direct push to
`main` still works when you mean it. Note that the ruleset only exists because
the repo is public: GitHub refuses rulesets on a private repo under a free org
plan.

## Tests

Both suites must pass before a push. CI (`.github/workflows/test.yml`) runs
the same two commands on every push to `main` and every pull request:

```bash
python3 -m pytest tests -q
```

```bash
bun test
```

`bun test` picks up every `tests/*.test.ts` — the opencode plugin's gatekeeper
helpers and its `config`-hook registration.

Hosts live in `hosts/registry.json`; both gatekeepers (`hooks/gatekeeper.py`
and `.opencode/plugins/omni.ts`) read `KNOWN_HOSTS` from it, so adding a host
is a registry edit plus an adapter directory — see `docs/porting-a-host.md`.
The ownership, prefix, directory-matching and safety-valve rules are still two
ports of one design; a change in one lands in the other. Prompts in `skills/`,
`agents/` and `commands/` never name a host — `tests/test_prompt_neutrality.py`
enforces it.
