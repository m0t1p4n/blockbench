#!/usr/bin/env bash
# Copies the Blockbench web build into the Flutter package's asset folder.
# Run from anywhere after building Blockbench for web:
#   cd <blockbench root> && npm run build-web
#   bash flutter/blockbench_bridge/tool/sync_web_assets.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
BLOCKBENCH_ROOT="$(cd "$PACKAGE_DIR/../.." && pwd)"
DEST="$PACKAGE_DIR/assets/blockbench_web"

if [ ! -f "$BLOCKBENCH_ROOT/dist/bundle.js" ]; then
    echo "dist/bundle.js not found. Run 'npm run build-web' in $BLOCKBENCH_ROOT first." >&2
    exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST/dist"

cp "$BLOCKBENCH_ROOT/index.html" "$DEST/"
cp "$BLOCKBENCH_ROOT/favicon.png" "$DEST/"
cp "$BLOCKBENCH_ROOT/icon_full.png" "$DEST/" 2>/dev/null || true
cp "$BLOCKBENCH_ROOT/manifest.webmanifest" "$DEST/" 2>/dev/null || true
cp "$BLOCKBENCH_ROOT/dist/bundle.js" "$DEST/dist/"

cp -R "$BLOCKBENCH_ROOT/css" "$DEST/css"
cp -R "$BLOCKBENCH_ROOT/font" "$DEST/font"
cp -R "$BLOCKBENCH_ROOT/lib" "$DEST/lib"
cp -R "$BLOCKBENCH_ROOT/assets" "$DEST/assets"

echo "Blockbench web build copied to $DEST"
du -sh "$DEST"
