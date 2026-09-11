"""omnislash adapter for Hermes Agent.

Hermes has no Stop hook. The one hook whose return value can keep the agent
going is `pre_verify`, which fires just before the agent accepts a final answer
and accepts the Claude-Code Stop shape (`{"decision": "block", "reason": ...}`)
as a synonym for its own `{"action": "continue", "message": ...}`. So the
gatekeeper's stdout crosses onto Hermes unchanged and this file is only a
bridge: it runs `hooks/gatekeeper.py` and `hooks/session_start.py` as
subprocesses with `OMNI_HOST=hermes`, exactly the way Claude Code and Codex run
them from a hook manifest.

Two Hermes-specific limits are worth knowing, and both are documented in
`hosts/README.md` rather than worked around here:

- `pre_verify` fires only on a turn where the agent edited code. A turn that
  only spawned an agent or read files is not gated, so the skill's own
  state re-read is what continues the run there.
- Consecutive continue directives inside one turn are capped by
  `agent.max_verify_nudges` (default 3). The gatekeeper's own 15-block safety
  valve is the real bound, so raise the Hermes cap to let it do its job.

FAIL-OPEN like the hooks themselves: a missing script, a timeout, or unparseable
output means the turn finishes. A broken adapter must never trap a session.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

HOOK_TIMEOUT_SEC = 10

HERE = os.path.dirname(os.path.realpath(__file__))


def plugin_root():
    """The repo root that ships `hooks/` and `skills/`, for either layout.

    `hermes plugins install himkit/omni-pipeline-plugin` clones the repo, so
    `.hermes-plugin/` and `hooks/` are siblings; a flattened install copies the
    plugin files to the plugin directory root instead. Raise rather than guess:
    a bridge that silently does nothing is a broken install pretending to work.
    """
    candidates = (os.path.realpath(os.path.join(HERE, "..")), HERE)
    for cand in candidates:
        if os.path.isfile(os.path.join(cand, "hooks", "gatekeeper.py")):
            return cand
    raise RuntimeError(
        "omnislash plugin: cannot find hooks/gatekeeper.py (looked at %s). "
        "Reinstall with `hermes plugins install himkit/omni-pipeline-plugin`."
        % (candidates,))


ROOT = plugin_root()
HOOKS = os.path.join(ROOT, "hooks")
SKILLS = os.path.join(ROOT, "skills")


def hook_env():
    """Hermes runs one shared gatekeeper, so the host has to name itself.
    Unset, the hooks default to Claude Code and this session would adopt runs
    that belong to another host."""
    return dict(os.environ, OMNI_HOST="hermes")


def run_hook(script, payload):
    """The hook's stdout parsed as JSON, or {} when it said nothing."""
    path = os.path.join(HOOKS, script)
    try:
        proc = subprocess.run(
            [sys.executable, path], input=json.dumps(payload),
            capture_output=True, text=True, timeout=HOOK_TIMEOUT_SEC,
            env=hook_env())
        out = (proc.stdout or "").strip()
        return json.loads(out) if out else {}
    except Exception:
        return {}


def payload(session_id, event):
    """What the Python hooks read: only `session_id` and `cwd`. Hermes gives
    `pre_verify` no working directory, and the plugin runs in-process, so this
    session's cwd is the agent's cwd."""
    return {"session_id": session_id, "cwd": os.getcwd(),
            "hook_event_name": event}


def pre_verify(session_id=None, **kwargs):
    """Keep the agent going while the gatekeeper says the run is mid-pipeline.

    Deliberately not gated on `attempt`: every nudge re-runs the agent loop, so
    each one is a turn of real pipeline work, and the gatekeeper's own counter
    (15 blocks without progress) is what ends a run that is going nowhere.
    """
    verdict = run_hook("gatekeeper.py", payload(session_id, "Stop"))
    reason = verdict.get("reason")
    if verdict.get("decision") == "block" and reason:
        return {"action": "continue", "message": reason}
    return None


def pre_llm_call(session_id=None, is_first_turn=None, **kwargs):
    """The "unfinished run here" reminder. Hermes ignores what
    `on_session_start` returns, and context injection is `pre_llm_call`'s
    return value, so the first turn carries it."""
    if not is_first_turn:
        return None
    notice = run_hook("session_start.py", payload(session_id, "SessionStart"))
    message = notice.get("systemMessage")
    return {"context": message} if message else None


def register(ctx):
    """Called once at startup. Registers the enforcer, the reminder, and every
    shipped skill under this plugin's namespace (`skill_view("omnislash:cast")`).

    register_skill requires a pathlib.Path — a str raises and Hermes disables
    the whole plugin.
    """
    for name in sorted(os.listdir(SKILLS)):
        skill_md = Path(SKILLS) / name / "SKILL.md"
        if skill_md.is_file():
            ctx.register_skill(name, skill_md)

    ctx.register_hook("pre_verify", pre_verify)
    ctx.register_hook("pre_llm_call", pre_llm_call)
