#!/usr/bin/env bash
#
# Schrijfstijl-check: nergens een em-dash (U+2014) of en-dash (U+2013), overal
# een gewone dash. Geldt voor code, commentaar, prompts, docs en UI-teksten.
# tools/patches/ is uitgezonderd (patch-context moet exact blijven).
#
# Usage:
#   ./tools/check-dashes.sh        (of: npm run dev:check-dashes)
#
set -euo pipefail

cd "$(dirname "$0")/.."

# git grep -P: Perl-regex met Unicode-codepunten, zodat dit script zelf
# dash-vrij blijft.
if hits="$(git grep -nP '[\x{2013}\x{2014}]' -- . ':!tools/patches' 2>/dev/null)" && [[ -n "$hits" ]]; then
  echo "✗ em-/en-dash gevonden; gebruik een gewone dash (-):"
  echo "$hits"
  exit 1
fi
echo "✓ geen em-/en-dashes."
