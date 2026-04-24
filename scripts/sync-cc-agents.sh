#!/usr/bin/env bash
#
# Synct de Claude Code subagent-bestanden onder
# agents/claude-code/.claude/agents/ met de canonical prompts onder
# agents/prompts/. De SDK-agents laden prompts direct uit agents/prompts/;
# CC leest z'n eigen folder. Dit script houdt beide consistent.
#
# Usage:
#   ./scripts/sync-cc-agents.sh        (of: npm run sync-cc-agents)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROMPTS="$ROOT/agents/prompts"
CC_AGENTS="$ROOT/agents/claude-code/.claude/agents"

sync_one() {
  local canonical="$1"   # bv. develop
  local cc_name="$2"     # bv. ticket-author
  local description="$3"
  local tools="$4"
  local model="$5"

  local src="$PROMPTS/${canonical}.md"
  local dest="$CC_AGENTS/${cc_name}.md"

  if [[ ! -f "$src" ]]; then
    echo "ERROR: missing canonical $src"
    exit 1
  fi

  cat > "$dest" <<EOF
---
name: ${cc_name}
description: ${description}
tools: ${tools}
model: ${model}
---

<!-- MIRROR — gesynced van agents/prompts/${canonical}.md.
     Wijzig de canonical prompt (niet dit bestand) en herhaal de sync. -->

EOF
  cat "$src" >> "$dest"
  echo "✓ $dest  ←  $src"
}

sync_one \
  develop \
  ticket-author \
  "Implementeert of past een ticket aan voor de flux-web-components library. Gebruikt het refinement-rapport als specificatie. Werkt uitsluitend lokaal (branch, commit) — geen push, geen PR." \
  "Read, Write, Edit, Glob, Grep, Bash" \
  sonnet

sync_one \
  review \
  ticket-reviewer \
  "Reviewt de wijzigingen die ticket-author op een branch heeft gemaakt. Vergelijkt met het refinement-rapport, checkt VO-conventies, schrijft review.md. Bij approval: squasht commits en opent GitHub PR." \
  "Read, Glob, Grep, Bash" \
  opus
