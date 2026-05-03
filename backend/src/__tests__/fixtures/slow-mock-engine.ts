#!/usr/bin/env node
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * slow-mock-engine.ts — Slow fake execution-engine for restart resilience tests.
 *
 * Behaviour:
 *  1. Parses --json, --cwd, --run-id, --port flags from argv.
 *  2. Sleeps 15 seconds (simulates a long-running story).
 *  3. Reads the spec JSON to discover all userStories that need running.
 *  4. POSTs story_started + story_passed WAL events to the backend for each story.
 *  5. POSTs a /api/pipeline/story-result for each story.
 *  6. Prints "slow-mock-engine: done" to stdout (becomes a run_output_chunk).
 *  7. Exits 0.
 *
 * The 15-second sleep window is used by the restart test to kill/restart the
 * Express server mid-run while the worker (which spawned this process) stays alive.
 *
 * Run with: npx tsx slow-mock-engine.ts --json /path/to/spec.json --cwd /workspace --run-id 42 --port 3030
 */

import * as fs from 'fs';
import * as http from 'http';

// ── Arg parsing ────────────────────────────────────────────────────────────────

function getArg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

const jsonPath = getArg('--json');
const runIdStr = getArg('--run-id');
const port = getArg('--port') ?? '3030';

if (!jsonPath || !runIdStr) {
  process.stderr.write('slow-mock-engine: missing required flags --json and --run-id\n');
  process.exit(1);
}

const runId = parseInt(runIdStr, 10);
if (isNaN(runId)) {
  process.stderr.write(`slow-mock-engine: invalid --run-id: ${runIdStr}\n`);
  process.exit(1);
}

// ── HTTP helper ────────────────────────────────────────────────────────────────

async function post(path: string, body: unknown): Promise<void> {
  const data = JSON.stringify(body);
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: parseInt(port, 10),
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        // Consume response body to free the socket
        res.resume();
        res.on('end', resolve);
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/** Retry a post up to maxAttempts times with delayMs between attempts. */
async function postWithRetry(
  path: string,
  body: unknown,
  maxAttempts = 15,
  delayMs = 1000,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await post(path, body);
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      process.stderr.write(
        `slow-mock-engine: POST ${path} attempt ${attempt} failed: ${(err as Error).message} — retrying in ${delayMs}ms\n`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/** Sleep for ms milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.stdout.write(`slow-mock-engine: started runId=${runId} port=${port}\n`);

  // Sleep 15 seconds — this is the window during which the Express server is killed and restarted
  await sleep(15_000);

  process.stdout.write(`slow-mock-engine: sleep done — posting results runId=${runId}\n`);

  // 1. Read spec JSON
  let specJson: { userStories?: Array<{ id: string; passes?: boolean; excluded?: boolean }> };
  try {
    specJson = JSON.parse(fs.readFileSync(jsonPath!, 'utf8'));
  } catch (err) {
    process.stderr.write(`slow-mock-engine: failed to read spec: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const stories = (specJson.userStories ?? []).filter(
    (s) => !s.passes && !s.excluded,
  );

  // 2. Emit WAL events + story results for each story.
  //    Use retry because the Express server may have just restarted.
  for (const story of stories) {
    // story_started
    await postWithRetry('/api/wal', {
      event_type: 'story_started',
      payload: { run_id: runId, story_id: story.id },
    });

    // story_passed
    await postWithRetry('/api/wal', {
      event_type: 'story_passed',
      payload: { run_id: runId, story_id: story.id },
    });

    // Record story result so story_results table gets a row
    await postWithRetry('/api/pipeline/story-result', {
      runId,
      storyId: story.id,
      status: 'pass',
    });
  }

  // 3. Emit some stdout so run_output_chunks gets at least one row
  process.stdout.write(`slow-mock-engine: done runId=${runId} stories=${stories.length}\n`);
}

main().catch((err) => {
  process.stderr.write(`slow-mock-engine: fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
