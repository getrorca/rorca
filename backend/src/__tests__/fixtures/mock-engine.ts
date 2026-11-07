#!/usr/bin/env node
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * mock-engine.ts — Minimal fake execution-engine for pg-boss integration tests.
 *
 * Behaviour:
 *  1. Parses --json, --cwd, --run-id, --port flags from argv.
 *  2. Reads the spec JSON to discover all userStories that need running.
 *  3. POSTs story_started + story_passed WAL events to the backend for each story.
 *  4. POSTs a /api/pipeline/story-result for each story.
 *  5. Prints "mock-engine: done" to stdout (becomes a run_output_chunk).
 *  6. Exits 0.
 *
 * Run with: npx tsx mock-engine.ts --json /path/to/spec.json --cwd /workspace --run-id 42
 */

import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';

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
  process.stderr.write('mock-engine: missing required flags --json and --run-id\n');
  process.exit(1);
}

const runId = parseInt(runIdStr, 10);
if (isNaN(runId)) {
  process.stderr.write(`mock-engine: invalid --run-id: ${runIdStr}\n`);
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

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Read spec JSON
  let specJson: { userStories?: Array<{ id: string; passes?: boolean; excluded?: boolean }> };
  try {
    specJson = JSON.parse(fs.readFileSync(jsonPath!, 'utf8'));
  } catch (err) {
    process.stderr.write(`mock-engine: failed to read spec: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const stories = (specJson.userStories ?? []).filter(
    (s) => !s.passes && !s.excluded,
  );

  // 2. Emit WAL events + story results for each story
  for (const story of stories) {
    // story_started
    await post('/api/wal', {
      event_type: 'story_started',
      payload: { run_id: runId, story_id: story.id },
    });

    // story_passed
    await post('/api/wal', {
      event_type: 'story_passed',
      payload: { run_id: runId, story_id: story.id },
    });

    // Record story result so story_results table gets a row
    await post('/api/pipeline/story-result', {
      runId,
      storyId: story.id,
      status: 'pass',
    });
  }

  // 3. Emit some stdout so run_output_chunks gets at least one row
  process.stdout.write(`mock-engine: done runId=${runId} stories=${stories.length}\n`);
}

main().catch((err) => {
  process.stderr.write(`mock-engine: fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
