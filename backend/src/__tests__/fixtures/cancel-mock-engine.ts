#!/usr/bin/env node
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * cancel-mock-engine.ts — 60-second sleep engine for cancel integration tests.
 *
 * Behaviour:
 *  1. Parses --run-id and --sentinel flags from argv.
 *     --sentinel <path>  path to a file that will be created on SIGTERM receipt
 *  2. Writes "cancel-mock-engine: started runId=<runId>" to stdout immediately.
 *  3. Registers a SIGTERM handler that:
 *       a. Writes the sentinel file (so the test can detect SIGTERM independently
 *          of stdout stream state).
 *       b. Writes "cancel-mock-engine: SIGTERM received runId=<runId>" to stdout.
 *       c. Exits 143.
 *  4. Sleeps 60 seconds (simulates a long-running story).
 *  5. If not interrupted, exits 0 normally.
 *
 * Run with: npx tsx cancel-mock-engine.ts --run-id 42 --sentinel /tmp/sigterm-42.txt
 */

import * as fs from 'fs';

// ── Arg parsing ────────────────────────────────────────────────────────────────

function getArg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

const runIdStr = getArg('--run-id');
const sentinelPath = getArg('--sentinel');

if (!runIdStr) {
  process.stderr.write('cancel-mock-engine: missing required flag --run-id\n');
  process.exit(1);
}

const runId = parseInt(runIdStr, 10);
if (isNaN(runId)) {
  process.stderr.write(`cancel-mock-engine: invalid --run-id: ${runIdStr}\n`);
  process.exit(1);
}

// ── SIGTERM handler ────────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  // Write sentinel file so the test can detect SIGTERM independently of stdout
  if (sentinelPath) {
    try {
      fs.writeFileSync(sentinelPath, `SIGTERM runId=${runId} ts=${Date.now()}\n`);
    } catch { /* ignore write errors */ }
  }
  process.stdout.write(`cancel-mock-engine: SIGTERM received runId=${runId}\n`);
  // Exit 143 = 128 + SIGTERM(15)
  process.exit(143);
});

// ── Main ───────────────────────────────────────────────────────────────────────

process.stdout.write(`cancel-mock-engine: started runId=${runId}\n`);

// Sleep 60 seconds — long enough that the test cancels it mid-run
setTimeout(() => {
  process.stdout.write(`cancel-mock-engine: sleep done (not cancelled) runId=${runId}\n`);
  process.exit(0);
}, 60_000);
