#!/usr/bin/env node
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * ten-second-mock-engine.ts — 10s fake execution-engine for zero-downtime rolling deploy tests.
 *
 * Behaviour:
 *  1. Parses --json, --cwd, --run-id, --port flags from argv.
 *  2. Sleeps 10 seconds (simulates a long-running story).
 *  3. Reads the spec JSON to discover all userStories that need running.
 *  4. POSTs story_started + story_passed WAL events for each story.
 *  5. POSTs /api/pipeline/story-result for each story.
 *  6. Writes monotonically increasing output lines to stdout (captured as run_output_chunks).
 *  7. Exits 0.
 *
 * Run with: npx tsx ten-second-mock-engine.ts --json /path/to/spec.json --cwd /workspace --run-id 42 --port 3030
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
  process.stderr.write('ten-second-mock-engine: missing required flags --json and --run-id\n');
  process.exit(1);
}

const runId = parseInt(runIdStr, 10);
if (isNaN(runId)) {
  process.stderr.write(`ten-second-mock-engine: invalid --run-id: ${runIdStr}\n`);
  process.exit(1);
}

// ── HTTP helper ────────────────────────────────────────────────────────────────

async function post(urlPath: string, body: unknown): Promise<void> {
  const data = JSON.stringify(body);
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: parseInt(port, 10),
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
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

async function postWithRetry(
  urlPath: string,
  body: unknown,
  maxAttempts = 10,
  delayMs = 500,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await post(urlPath, body);
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.stdout.write(`ten-second-mock-engine: started runId=${runId} port=${port}\n`);

  // Emit output lines with monotonically increasing sequence markers
  // These become run_output_chunks rows — the test checks sequence contiguity
  for (let i = 1; i <= 5; i++) {
    process.stdout.write(`ten-second-mock-engine: line ${i} runId=${runId}\n`);
    await sleep(1_000); // 5 × 1s = 5s (half of the sleep window)
  }

  // Remaining 5s sleep
  await sleep(5_000);

  process.stdout.write(`ten-second-mock-engine: sleep done — posting results runId=${runId}\n`);

  // Read spec JSON
  let specJson: { userStories?: Array<{ id: string; passes?: boolean; excluded?: boolean }> };
  try {
    specJson = JSON.parse(fs.readFileSync(jsonPath!, 'utf8'));
  } catch (err) {
    process.stderr.write(`ten-second-mock-engine: failed to read spec: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const stories = (specJson.userStories ?? []).filter(
    (s) => !s.passes && !s.excluded,
  );

  // Post WAL events + story results
  for (const story of stories) {
    await postWithRetry('/api/wal', {
      event_type: 'story_started',
      payload: { run_id: runId, story_id: story.id },
    });

    await postWithRetry('/api/wal', {
      event_type: 'story_passed',
      payload: { run_id: runId, story_id: story.id },
    });

    await postWithRetry('/api/pipeline/story-result', {
      runId,
      storyId: story.id,
      status: 'pass',
    });
  }

  process.stdout.write(`ten-second-mock-engine: done runId=${runId} stories=${stories.length}\n`);
}

main().catch((err) => {
  process.stderr.write(`ten-second-mock-engine: fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
