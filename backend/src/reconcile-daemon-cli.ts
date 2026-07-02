/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * reconcile-daemon-cli.ts — US-031: service entry point for the bounded local
 * repo reconciliation daemon.
 *
 * Run via `npm run reconcile -- --workspace <id> --repo <path> [flags]` or
 * under a service supervisor (systemd, launchd, pm2). Emits structured JSON
 * log lines on stdout/stderr and reconciles SIGINT/SIGTERM into a graceful
 * shutdown that drains any in-flight scan and flushes the offline queue.
 *
 * Flags:
 *   --workspace <id>     (required) Rorca workspace ID
 *   --repo <path>        (default: cwd) local git repo to scan
 *   --api-url <url>      (default: $RORCA_API_URL or http://localhost:3030)
 *   --api-key <key>      (default: $RORCA_API_KEY) optional bearer token
 *   --interval <ms>      (default: 60000) poll interval, floored at 1000ms
 *   --since <policy>     (default: head) head | all | ref:<ref> | count:<n>
 *   --max-commits <n>    (default: 100) max commits ingested per scan
 *   --max-scans <n>      (optional) stop after N scans (bounded operation)
 *   --once               run a single scan and exit
 *   --status             print a status snapshot after the run
 */

import * as path from 'path';
import {
  ReconcileDaemon,
  type SincePolicy,
  type ReconcileDaemonOptions,
} from './lib/reconcile-daemon';

interface CliArgs {
  workspace?: string;
  repo: string;
  apiUrl: string;
  apiKey?: string;
  intervalMs: number;
  since: SincePolicy;
  maxCommits: number;
  maxScans?: number;
  once: boolean;
  status: boolean;
}

/** Parse `--since` value into a {@link SincePolicy}. */
export function parseSince(value: string): SincePolicy {
  if (value === 'head') return { mode: 'head' };
  if (value === 'all') return { mode: 'all' };
  if (value.startsWith('ref:')) {
    const ref = value.slice('ref:'.length);
    if (!ref) throw new Error('--since ref:<ref> requires a ref');
    return { mode: 'ref', ref };
  }
  if (value.startsWith('count:')) {
    const count = Number(value.slice('count:'.length));
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error('--since count:<n> requires a positive integer');
    }
    return { mode: 'count', count };
  }
  throw new Error(`Invalid --since policy: ${value} (expected head|all|ref:<ref>|count:<n>)`);
}

function parsePositiveIntegerFlag(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

/** Parse argv into structured CLI args. Exported for testing. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    repo: process.cwd(),
    apiUrl: process.env.RORCA_API_URL ?? 'http://localhost:3030',
    apiKey: process.env.RORCA_API_KEY,
    intervalMs: 60_000,
    since: { mode: 'head' },
    maxCommits: 100,
    once: false,
    status: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case '--workspace': args.workspace = next(); break;
      case '--repo': args.repo = path.resolve(next()); break;
      case '--api-url': args.apiUrl = next(); break;
      case '--api-key': args.apiKey = next(); break;
      case '--interval': args.intervalMs = parsePositiveIntegerFlag('--interval', next()); break;
      case '--since': args.since = parseSince(next()); break;
      case '--max-commits': args.maxCommits = parsePositiveIntegerFlag('--max-commits', next()); break;
      case '--max-scans': args.maxScans = parsePositiveIntegerFlag('--max-scans', next()); break;
      case '--once': args.once = true; break;
      case '--status': args.status = true; break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.workspace) {
    throw new Error('--workspace <id> is required');
  }
  return args;
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: npm run reconcile -- --workspace <id> [options]',
      '',
      'Options:',
      '  --workspace <id>     (required) Rorca workspace ID',
      '  --repo <path>        local git repo to scan (default: cwd)',
      '  --api-url <url>      Rorca backend URL (default: $RORCA_API_URL or http://localhost:3030)',
      '  --api-key <key>      optional bearer token (default: $RORCA_API_KEY)',
      '  --interval <ms>      poll interval (default: 60000)',
      '  --since <policy>     head | all | ref:<ref> | count:<n> (default: head)',
      '  --max-commits <n>    max commits per scan (default: 100)',
      '  --max-scans <n>      stop after N scans (bounded operation)',
      '  --once               run a single scan and exit',
      '  --status             print a status snapshot after the run',
      '',
    ].join('\n'),
  );
}

/** Build daemon options from parsed CLI args. */
export function toDaemonOptions(args: CliArgs): ReconcileDaemonOptions {
  return {
    workspaceId: args.workspace!,
    repoPath: args.repo,
    apiUrl: args.apiUrl,
    apiKey: args.apiKey,
    intervalMs: args.intervalMs,
    since: args.since,
    maxCommits: args.maxCommits,
    maxScans: args.maxScans,
  };
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n`);
    printUsage();
    process.exit(2);
    return;
  }

  const daemon = new ReconcileDaemon(toDaemonOptions(args));

  // Graceful shutdown on SIGINT/SIGTERM (suitable for systemd/launchd/pm2).
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`\nReceived ${signal}; shutting down gracefully...\n`);
    void daemon.stop({ finalFlush: true }).then(() => {
      if (args.status) process.stdout.write(JSON.stringify(daemon.getStatus()) + '\n');
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (args.once) {
    await daemon.scanOnce();
    if (args.status) process.stdout.write(JSON.stringify(daemon.getStatus()) + '\n');
    return;
  }

  await daemon.start();
  if (args.status) process.stdout.write(JSON.stringify(daemon.getStatus()) + '\n');
}

// Only run when invoked directly (not when imported by tests).
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
