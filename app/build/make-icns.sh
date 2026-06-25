#!/usr/bin/env bash
#
# Bouwt het app-icoon vanaf build/icon.svg:
#   1. rendert de SVG naar build/icon.png MET transparantie (Electron offscreen;
#      QuickLook zou de alpha naar wit pletten),
#   2. genereert een .iconset met alle macOS-maten,
#   3. bundelt die tot build/icon.icns (gebruikt door electron-builder).
#
# Draai dit opnieuw na elke wijziging aan build/icon.svg.
#
# Gebruik:  ./app/build/make-icns.sh   (vanuit de repo-root of waar dan ook)
set -euo pipefail

# cwd = app/ (de map boven dit script), ongeacht waar je het start. Alle paden
# hieronder (build/icon.*) zijn relatief daaraan → app/build/...
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

src="build/icon.png"
iconset="$(mktemp -d)/icon.iconset"
trap 'rm -rf "$(dirname "$iconset")"' EXIT

echo "→ SVG renderen naar $src (transparant, via Electron)…"
npx electron build/render-icon.cjs

echo "→ iconset genereren…"
mkdir -p "$iconset"
gen() { sips -z "$2" "$2" "$src" --out "$iconset/$1" >/dev/null; }
gen icon_16x16.png 16;    gen icon_16x16@2x.png 32
gen icon_32x32.png 32;    gen icon_32x32@2x.png 64
gen icon_128x128.png 128; gen icon_128x128@2x.png 256
gen icon_256x256.png 256; gen icon_256x256@2x.png 512
gen icon_512x512.png 512; cp "$src" "$iconset/icon_512x512@2x.png"

echo "→ .icns bundelen…"
iconutil -c icns "$iconset" -o build/icon.icns

echo "✓ build/icon.icns + build/icon.png bijgewerkt"
