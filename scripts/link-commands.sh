#!/usr/bin/env bash
#
# Legt een symlink van flux-web-components/.claude naar deze repo's
# agents/cc/.claude folder. Zo staan alle agent-definities op één plek
# (in flux-agents), maar zijn de commands beschikbaar als /develop,
# /review, /address in je project.
#
# Usage:
#   ./scripts/link-commands.sh /path/to/flux-web-components
#
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <path-to-flux-web-components>"
  exit 1
fi

TARGET_REPO="$1"
AGENTS_FLUX_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE=".claude"
SOURCE_ABS="$AGENTS_FLUX_ROOT/agents/cc/$SOURCE"
DEST="$TARGET_REPO/.claude"

if [[ ! -d "$TARGET_REPO" ]]; then
  echo "ERROR: $TARGET_REPO is not a directory"
  exit 1
fi

if [[ ! -d "$TARGET_REPO/.git" ]]; then
  echo "ERROR: $TARGET_REPO doesn't look like a git repo"
  exit 1
fi

if [[ ! -d "$SOURCE_ABS" ]]; then
  echo "ERROR: source $SOURCE_ABS does not exist"
  exit 1
fi

# If dest exists and is a real directory (not symlink), refuse to overwrite
if [[ -e "$DEST" && ! -L "$DEST" ]]; then
  echo "ERROR: $DEST exists and is not a symlink."
  echo "If you already have project-specific Claude Code config there,"
  echo "merge it manually or rename it first."
  exit 1
fi

# Remove existing symlink if any
if [[ -L "$DEST" ]]; then
  echo "Removing existing symlink at $DEST"
  rm "$DEST"
fi

ln -s "$SOURCE_ABS" "$DEST"
echo "✓ Linked $DEST → $SOURCE_ABS"
echo ""
echo "Test it: cd $TARGET_REPO && claude"
echo "Commands: /develop, /review, /address"
echo ""
echo "⚠️  Note: .claude is now a symlink. If your repo's .gitignore doesn't"
echo "   already ignore it, add '.claude' to .gitignore so colleagues don't"
echo "   check it in accidentally."
