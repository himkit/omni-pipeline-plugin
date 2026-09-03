#!/usr/bin/env bash
# Install the omni pipeline into opencode.
#
#   ./install.sh            symlink into ~/.config/opencode (default)
#   ./install.sh --copy     copy instead of symlink
#   ./install.sh --uninstall
#
# Honours $OPENCODE_CONFIG_DIR. Links the agents, commands, plugin, and the
# `pipeline` skill directory; touches no config file. (opencode has no
# `skills.paths` setting — skills are discovered from
# ~/.config/opencode/skills/<name>/SKILL.md and the project-local equivalents.)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SRC/.." && pwd)"          # repo root
DEST="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
SKILL_SRC="$PLUGIN_ROOT/skills/pipeline"
SKILL_DST="$DEST/skills/pipeline"

MODE=symlink
case "${1:-}" in
  --copy) MODE=copy ;;
  --uninstall) MODE=uninstall ;;
  "") ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

files() { # <subdir> — prints "src_path dest_path" pairs
  local sub=$1
  local f
  for f in "$SRC/$sub"/*; do
    [ -e "$f" ] || continue
    printf '%s\t%s/%s/%s\n' "$f" "$DEST" "$sub" "$(basename "$f")"
  done
}

if [ "$MODE" = uninstall ]; then
  while IFS=$'\t' read -r _ dst; do
    [ -e "$dst" ] || [ -L "$dst" ] || continue
    rm -f "$dst" && echo "removed $dst"
  done < <(files agents; files commands; files plugins)
  if [ -L "$SKILL_DST" ]; then rm -f "$SKILL_DST" && echo "removed $SKILL_DST"; fi
  exit 0
fi

mkdir -p "$DEST/agents" "$DEST/commands" "$DEST/plugins" "$DEST/skills"

while IFS=$'\t' read -r src dst; do
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    echo "refusing to overwrite real file: $dst" >&2
    echo "  move it aside and re-run." >&2
    exit 1
  fi
  rm -f "$dst"
  if [ "$MODE" = copy ]; then cp "$src" "$dst"; else ln -s "$src" "$dst"; fi
  echo "${MODE} $dst"
done < <(files agents; files commands; files plugins)

# --- the pipeline skill ---------------------------------------------------
# Skill discovery is directory-based: <skills>/<name>/SKILL.md, where <name>
# must equal the frontmatter name. So the directory is linked, not the file.
if [ -e "$SKILL_DST" ] && [ ! -L "$SKILL_DST" ]; then
  echo "refusing to overwrite real directory: $SKILL_DST" >&2
  exit 1
fi
rm -f "$SKILL_DST"
if [ "$MODE" = copy ]; then cp -R "$SKILL_SRC" "$SKILL_DST"; else ln -s "$SKILL_SRC" "$SKILL_DST"; fi
echo "${MODE} $SKILL_DST"

echo
echo "done. Restart opencode, then: /omni <feature idea>"
