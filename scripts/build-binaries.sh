#!/usr/bin/env bash
#
# DIST-005: Build compiled Rorca binaries for all 4 target platforms.
#
# Produces self-contained binaries with frontend assets embedded:
#   build/rorca-darwin-arm64      (macOS Apple Silicon)
#   build/rorca-darwin-x64        (macOS Intel)
#   build/rorca-linux-x64         (Linux x86_64)
#   build/rorca-win32-x64.exe     (Windows x86_64)
#
# Usage:
#   bash scripts/build-binaries.sh
#   npm run build:binaries
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT/build"
DIST_DIR="$ROOT/dist"
GENERATED_DIR="$ROOT/bin/.generated"
MIGRATIONS_DIR="$ROOT/backend/src/db/pg-migrations"
ENTRY="$ROOT/bin/rorca-bun.ts"

TARGETS=(
  "bun-darwin-arm64:rorca-darwin-arm64"
  "bun-darwin-x64:rorca-darwin-x64"
  "bun-linux-x64:rorca-linux-x64"
  "bun-linux-arm64:rorca-linux-arm64"
  "bun-windows-x64:rorca-win32-x64.exe"
)

# ── Step 0: Clean build directory ──
echo "==> Cleaning build/ directory..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# ── Step 1: Build frontend ──
echo "==> Step 1/3: Building frontend..."
if [ ! -f "$DIST_DIR/index.html" ]; then
  (cd "$ROOT" && npx vite build)
fi
if [ ! -f "$DIST_DIR/index.html" ]; then
  echo "ERROR: Frontend build failed — dist/index.html not found"
  exit 1
fi
echo "    Frontend ready."

# ── Step 2: Generate embedded assets module ──
echo "==> Step 2/3: Generating embedded assets..."
mkdir -p "$GENERATED_DIR"
bun run "$ROOT/scripts/_generate-embedded-assets.ts"
echo "    Embedded assets generated."

# ── Step 3: Compile for each target ──
echo "==> Step 3/3: Compiling binaries..."
echo ""

FAILED=0
for entry in "${TARGETS[@]}"; do
  TARGET="${entry%%:*}"
  OUTNAME="${entry##*:}"
  OUTPATH="$BUILD_DIR/$OUTNAME"

  echo "  Building $OUTNAME (target: $TARGET)..."
  if bun run "$ROOT/scripts/_compile-target.ts" "$TARGET" "$OUTPATH"; then
    # Set executable permissions on Unix binaries
    if [[ "$OUTNAME" != *.exe ]]; then
      chmod +x "$OUTPATH"
    fi

    SIZE=$(ls -la "$OUTPATH" | awk '{print $5}')
    SIZE_MB=$(echo "scale=1; $SIZE / 1048576" | bc)
    echo "    OK — ${SIZE_MB} MB"
  else
    echo "    FAILED"
    FAILED=$((FAILED + 1))
  fi
done

echo ""

# ── Verify binaries ──
echo "==> Verification:"
for entry in "${TARGETS[@]}"; do
  OUTNAME="${entry##*:}"
  OUTPATH="$BUILD_DIR/$OUTNAME"
  if [ -f "$OUTPATH" ]; then
    FILE_INFO=$(file "$OUTPATH" | sed "s|$OUTPATH: ||")
    echo "  $OUTNAME: $FILE_INFO"
  else
    echo "  $OUTNAME: MISSING"
  fi
done

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "All 4 binaries built successfully in build/"
else
  echo "WARNING: $FAILED binary build(s) failed"
  exit 1
fi
