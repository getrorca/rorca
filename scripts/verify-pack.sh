#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMPDIR=$(mktemp -d)
INSTALL_DIR=""

cleanup() {
  rm -rf "$TMPDIR"
  if [[ -n "$INSTALL_DIR" ]]; then
    rm -rf "$INSTALL_DIR"
  fi
}

trap cleanup EXIT

cd "$ROOT_DIR"

git clean -fdx -e .env.local -e scripts/verify-pack.sh -e .rorca/proposed_memories.json

npm install
(
  cd backend
  npm install
)

npm pack --pack-destination="$TMPDIR"

TARBALL=$(find "$TMPDIR" -maxdepth 1 -name 'rorca-*.tgz' -print -quit)
if [[ -z "$TARBALL" ]]; then
  echo "✗ Failed to locate packed tarball"
  exit 1
fi

TARBALL_BYTES=$(wc -c < "$TARBALL" | tr -d ' ')
TARBALL_HUMAN=$(du -h "$TARBALL" | cut -f1)
echo "Tarball: $TARBALL ($TARBALL_HUMAN, ${TARBALL_BYTES} bytes)"

tar tzf "$TARBALL" | sort > "$TMPDIR/contents.txt"

for required in \
  "package/dist/index.html" \
  "package/backend/dist/server.js" \
  "package/backend/dist/worker.js" \
  "package/backend/dist/lib/supervisor.js" \
  "package/cli.js" \
  "package/bin/rorca.js"
do
  grep -qx "$required" "$TMPDIR/contents.txt" || { echo "✗ MISSING: $required"; exit 1; }
done

grep -Eq '^package/dist/assets/.*\.js$' "$TMPDIR/contents.txt" || {
  echo "✗ MISSING: package/dist/assets/*.js"
  exit 1
}

grep -Eq '^package/backend/src/db/pg-migrations/.+\.sql$' "$TMPDIR/contents.txt" || {
  echo "✗ MISSING: backend/src/db/pg-migrations/*.sql"
  exit 1
}

if [[ -d "$ROOT_DIR/backend/src/db/migrations" ]]; then
  grep -Eq '^package/backend/src/db/migrations/.+\.sql$' "$TMPDIR/contents.txt" || {
    echo "✗ MISSING: backend/src/db/migrations/*.sql"
    exit 1
  }
fi

if [[ -d "$ROOT_DIR/supabase/migrations" ]]; then
  grep -Eq '^package/supabase/migrations/.+\.(sql|json)$' "$TMPDIR/contents.txt" || {
    echo "✗ MISSING: supabase/migrations payload"
    exit 1
  }
fi

if grep -E '^package/packages/' "$TMPDIR/contents.txt" | grep -Ev '^package/packages/(rorca-pi-extension|rorca-capture)/' >/dev/null; then
  echo "✗ Unexpected workspace package content leaked into tarball"
  exit 1
fi

for required_pi_asset in \
  "package/packages/rorca-pi-extension/package.json" \
  "package/packages/rorca-pi-extension/README.md" \
  "package/packages/rorca-pi-extension/skills/rorca-forge/SKILL.md" \
  "package/packages/rorca-pi-extension/skills/rorca-forge-run/SKILL.md"
do
  grep -qx "$required_pi_asset" "$TMPDIR/contents.txt" || { echo "✗ MISSING: $required_pi_asset"; exit 1; }
done

BASELINE_FILE="$ROOT_DIR/.tarball-size-baseline"
if [[ -f "$BASELINE_FILE" ]]; then
  BASELINE_BYTES=$(tr -d '[:space:]' < "$BASELINE_FILE")
  if [[ "$BASELINE_BYTES" =~ ^[0-9]+$ ]]; then
    THRESHOLD_BYTES=$((BASELINE_BYTES + (BASELINE_BYTES / 2)))
    if (( TARBALL_BYTES > THRESHOLD_BYTES )); then
      echo "⚠ Tarball size regression: ${TARBALL_BYTES} bytes exceeds 150% of baseline ${BASELINE_BYTES}"
    else
      echo "✓ Tarball size within baseline threshold (${BASELINE_BYTES} bytes)"
    fi
  else
    echo "⚠ Ignoring invalid tarball baseline in $BASELINE_FILE"
  fi
else
  echo "⚠ No .tarball-size-baseline present; using this run as the first reference point"
fi

echo "✓ All required artifacts present"

INSTALL_DIR=$(mktemp -d)
npm install --prefix "$INSTALL_DIR" "$TARBALL" >/dev/null

test -x "$INSTALL_DIR/node_modules/.bin/rorca" || {
  echo "✗ rorca binary not executable after install"
  exit 1
}

echo "✓ Smoke install passed"

CLI_PACK_JSON="$TMPDIR/cli-pack.json"
(
  cd "$ROOT_DIR/packages/rorca-cli"
  npm pack --dry-run --json > "$CLI_PACK_JSON"
)

node <<'NODE' "$CLI_PACK_JSON" "$ROOT_DIR"
const fs = require('fs');
const path = require('path');

const [jsonPath, rootDir] = process.argv.slice(2);
const packEntries = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const files = packEntries[0]?.files ?? [];
const headerRegex = /SPDX-License-Identifier:\s*MIT/;

for (const file of files) {
  const packagePath = file.path;

  if (packagePath.startsWith('backend/') || packagePath.startsWith('src/')) {
    console.error(`✗ CLI standalone tarball leaked proprietary path: ${packagePath}`);
    process.exit(1);
  }

  if (!/\.(ts|tsx|js|jsx)$/.test(packagePath)) {
    continue;
  }

  const sourcePath = path.join(rootDir, 'packages/rorca-cli', packagePath);
  const contents = fs.readFileSync(sourcePath, 'utf8');
  if (!headerRegex.test(contents)) {
    console.error(`✗ CLI standalone tarball file missing MIT SPDX header: ${packagePath}`);
    process.exit(1);
  }
}

const hasLicenseFile = files.some((file) => file.path === 'LICENSE');
if (!hasLicenseFile) {
  console.error('✗ CLI standalone tarball is missing LICENSE');
  process.exit(1);
}

console.log('✓ Standalone CLI tarball remains MIT-only');
NODE
