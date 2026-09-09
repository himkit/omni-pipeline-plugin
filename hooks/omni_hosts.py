"""Which hosts exist, and which one is running this hook.

Read by hooks/gatekeeper.py and hooks/session_start.py. The list lives in
hosts/registry.json so that adding a host is a registry edit, not a code edit
in two files. FAIL-OPEN: a missing or broken registry yields the three hosts
that were hard-coded before the registry existed.
"""
import json
import os

FALLBACK_HOSTS = ("claude", "codex", "opencode")
DEFAULT_HOST = "claude"


def registry_path():
    override = os.environ.get("OMNI_REGISTRY")
    if override:
        return override
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(here), "hosts", "registry.json")


def load_registry():
    try:
        with open(registry_path()) as f:
            data = json.load(f)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def known_hosts():
    hosts = tuple(h for h in load_registry() if isinstance(h, str) and h)
    return hosts or FALLBACK_HOSTS


def _prefix(registry, host):
    """The `prefix` the registry declares for `host`, or None."""
    entry = registry.get(host)
    if isinstance(entry, dict):
        prefix = entry.get("prefix")
        if isinstance(prefix, str) and prefix:
            return prefix
    return None


def host_prefix(host):
    """The session-id prefix `host` writes: its registry `prefix`, else
    `<host>-` — the shape every host used before the field existed."""
    return _prefix(load_registry(), host) or host + "-"


def known_prefixes():
    """Every host's prefix, in registry order, deduplicated. A prefix missing
    here would let one host adopt another host's run, so this must cover the
    same set as known_hosts()."""
    registry = load_registry()
    out = []
    for host in known_hosts():
        prefix = _prefix(registry, host) or host + "-"
        if prefix not in out:
            out.append(prefix)
    return tuple(out)


def current_host():
    host = (os.environ.get("OMNI_HOST") or "").strip().lower()
    return host if host in known_hosts() else DEFAULT_HOST
