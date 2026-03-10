#!/usr/bin/env bash
#
# DIST-005/007: Build compiled Rorca binaries.
#
# Full build (all 4 platforms):
#   bash scripts/build-binaries.sh
#
# Single target (for CI matrix):
#   bash scripts/build-binaries.sh --target bun-darwin-arm64 --output build/rorca-darwin-arm64
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT/build"
DIST_DIR="$ROOT/dist"
GENERATED_DIR="$ROOT/bin/.generated"

ALL_TARGETS=(
  "bun-darwin-arm64:rorca-darwin-arm64"
  "bun-darwin-x64:rorca-darwin-x64"
  "bun-linux-x64:rorca-linux-x64"
  "bun-windows-x64:rorca-windows-x64.exe"
)

# ── Parse args ──
SINGLE_TARGET=""
SINGLE_OUTPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)  SINGLE_TARGET="$2"; shift 2 ;;
    --output)  SINGLE_OUTPUT="$2"; shift 2 ;;
    *)         echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── Step 0: Prepare build directory ──
mkdir -p "$BUILD_DIR"

# ── Step 1: Build frontend (skip if dist/index.html already present) ──
if [ ! -f "$DIST_DIR/index.html" ]; then
  echo "==> Building frontend..."
  (cd "$ROOT" && npx vite build)
fi
if [ ! -f "$DIST_DIR/index.html" ]; then
  echo "ERROR: Frontend build failed — dist/index.html not found"
  exit 1
fi
echo "==> Frontend ready."

# ── Step 2: Generate embedded assets module ──
echo "==> Generating embedded assets..."
mkdir -p "$GENERATED_DIR"
bun run "$ROOT/scripts/_generate-embedded-assets.ts"
echo "    Embedded assets generated."

# ── Step 3: Compile ──
compile_one() {
  local TARGET="$1"
  local OUTPATH="$2"
  local OUTNAME
  OUTNAME="$(basename "$OUTPATH")"

  echo "  Building $OUTNAME (target: $TARGET)..."
  if bun run "$ROOT/scripts/_compile-target.ts" "$TARGET" "$OUTPATH"; then
    if [[ "$OUTNAME" != *.exe ]]; then
      chmod +x "$OUTPATH"
    fi
    SIZE=$(stat -f%z "$OUTPATH" 2>/dev/null || stat -c%s "$OUTPATH" 2>/dev/null || echo "0")
    SIZE_MB=$(echo "scale=1; $SIZE / 1048576" | bc 2>/dev/null || echo "?")
    echo "    OK — ${SIZE_MB} MB"
    return 0
  else
    echo "    FAILED"
    return 1
  fi
}

if [ -n "$SINGLE_TARGET" ] && [ -n "$SINGLE_OUTPUT" ]; then
  # ── Single target mode (CI matrix) ──
  # Resolve output path to absolute if relative
  if [[ "$SINGLE_OUTPUT" != /* ]]; then
    SINGLE_OUTPUT="$ROOT/$SINGLE_OUTPUT"
  fi
  mkdir -p "$(dirname "$SINGLE_OUTPUT")"

  echo "==> Compiling single target..."
  compile_one "$SINGLE_TARGET" "$SINGLE_OUTPUT"
  echo ""
  echo "Binary built: $SINGLE_OUTPUT"
else
  # ── Full build (all 4 targets) ──
  echo "==> Compiling all binaries..."
  rm -rf "$BUILD_DIR"
  mkdir -p "$BUILD_DIR"

  FAILED=0
  for entry in "${ALL_TARGETS[@]}"; do
    TARGET="${entry%%:*}"
    OUTNAME="${entry##*:}"
    if ! compile_one "$TARGET" "$BUILD_DIR/$OUTNAME"; then
      FAILED=$((FAILED + 1))
    fi
  done

  echo ""
  echo "==> Verification:"
  for entry in "${ALL_TARGETS[@]}"; do
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
fi
