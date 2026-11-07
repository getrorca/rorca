/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Pool } from 'pg';
import { recomputeFalseZeroStoryAccounting } from '../src/lib/story-accounting-backfill';

export interface BackfillCliOptions {
  runId: string;
  storyId?: string;
  apply: boolean;
}

export function parseBackfillCliArgs(args: string[]): BackfillCliOptions {
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const runId = value('--run');
  const storyId = value('--story');
  if (!runId || !/^[1-9]\d*$/.test(runId)) throw new Error('--run must be one positive canonical run ID');
  if (storyId !== undefined && (!storyId.trim() || storyId.length > 256 || storyId.startsWith('-'))) {
    throw new Error('--story must be one non-empty story ID of at most 256 characters');
  }
  return { runId, ...(storyId ? { storyId } : {}), apply: args.includes('--apply') };
}

export async function runBackfillCli(args: string[], environment = process.env): Promise<unknown> {
  const options = parseBackfillCliArgs(args);
  const connectionString = environment.RORCA_MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error('RORCA_MIGRATION_DATABASE_URL is required');
  const pool = new Pool({
    connectionString,
    max: 1,
    options: '--search_path=rorca,public -c rorca.migration_mode=on',
  });
  try {
    const client = await pool.connect();
    try {
      return await recomputeFalseZeroStoryAccounting(client, options);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void runBackfillCli(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
