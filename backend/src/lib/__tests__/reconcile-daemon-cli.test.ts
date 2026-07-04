/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-031: reconcile daemon CLI arg parsing — tests.
 */

import { parseArgs, parseSince, toDaemonOptions } from '../../reconcile-daemon-cli';

describe('parseSince', () => {
  test('parses head and all', () => {
    expect(parseSince('head')).toEqual({ mode: 'head' });
    expect(parseSince('all')).toEqual({ mode: 'all' });
  });

  test('parses ref:<ref> and count:<n>', () => {
    expect(parseSince('ref:main')).toEqual({ mode: 'ref', ref: 'main' });
    expect(parseSince('count:5')).toEqual({ mode: 'count', count: 5 });
  });

  test('rejects malformed policies', () => {
    expect(() => parseSince('ref:')).toThrow();
    expect(() => parseSince('count:0')).toThrow();
    expect(() => parseSince('count:-1')).toThrow();
    expect(() => parseSince('bogus')).toThrow();
  });
});

describe('parseArgs', () => {
  test('requires --workspace', () => {
    expect(() => parseArgs([])).toThrow(/--workspace/);
  });

  test('parses a full flag set', () => {
    const args = parseArgs([
      '--workspace', 'ws-1',
      '--repo', '/tmp/repo',
      '--api-url', 'http://localhost:9999',
      '--api-key', 'secret',
      '--interval', '5000',
      '--since', 'ref:develop',
      '--max-commits', '50',
      '--max-scans', '3',
      '--once',
      '--status',
    ]);
    expect(args.workspace).toBe('ws-1');
    expect(args.repo).toBe('/tmp/repo');
    expect(args.apiUrl).toBe('http://localhost:9999');
    expect(args.apiKey).toBe('secret');
    expect(args.intervalMs).toBe(5000);
    expect(args.since).toEqual({ mode: 'ref', ref: 'develop' });
    expect(args.maxCommits).toBe(50);
    expect(args.maxScans).toBe(3);
    expect(args.once).toBe(true);
    expect(args.status).toBe(true);
  });

  test('applies defaults', () => {
    const args = parseArgs(['--workspace', 'ws-1']);
    expect(args.intervalMs).toBe(60_000);
    expect(args.maxCommits).toBe(100);
    expect(args.since).toEqual({ mode: 'head' });
    expect(args.once).toBe(false);
    expect(args.maxScans).toBeUndefined();
  });

  test('rejects unknown flags and missing values', () => {
    expect(() => parseArgs(['--workspace', 'w', '--nope'])).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--workspace'])).toThrow(/Missing value/);
  });

  test('rejects malformed numeric flags', () => {
    expect(() => parseArgs(['--workspace', 'w', '--interval', 'abc'])).toThrow(/--interval/);
    expect(() => parseArgs(['--workspace', 'w', '--max-commits', '0'])).toThrow(/--max-commits/);
    expect(() => parseArgs(['--workspace', 'w', '--max-scans', '-1'])).toThrow(/--max-scans/);
  });

  test('toDaemonOptions maps args through', () => {
    const opts = toDaemonOptions(parseArgs(['--workspace', 'ws-1', '--max-commits', '7']));
    expect(opts.workspaceId).toBe('ws-1');
    expect(opts.maxCommits).toBe(7);
  });
});
