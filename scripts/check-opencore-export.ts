#!/usr/bin/env -S npx tsx
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type Rule = { path: string; reason: string };
type BoundaryConfig = {
  shareable: Rule[];
  review: Rule[];
  blocked: Rule[];
};

type Classification = 'shareable' | 'review' | 'blocked' | 'unknown';

function loadConfig(): BoundaryConfig {
  const configPath = path.resolve(process.cwd(), 'config/open-core-boundaries.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as BoundaryConfig;
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', cwd: process.cwd() }).trim();
}

function parseArgs(argv: string[]) {
  const options: {
    base?: string;
    head?: string;
    staged?: boolean;
    allowReview?: boolean;
    verbose?: boolean;
    help?: boolean;
  } = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--base':
        options.base = argv[++i];
        break;
      case '--head':
        options.head = argv[++i];
        break;
      case '--staged':
        options.staged = true;
        break;
      case '--allow-review':
        options.allowReview = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage(): string {
  return [
    'Usage: npm run split:check -- [--base <git-ref> --head <git-ref> | --staged] [--allow-review] [--verbose]',
    '',
    'Examples:',
    '  npm run split:check -- --base origin/main --head HEAD',
    '  npm run split:check -- --base HEAD~1 --head HEAD --allow-review',
    '  npm run split:check -- --staged',
  ].join('\n');
}

function matchesRule(file: string, rule: Rule): boolean {
  if (rule.path.endsWith('/')) {
    return file.startsWith(rule.path);
  }
  return file === rule.path;
}

function findMatch(file: string, rules: Rule[]): Rule | undefined {
  return rules.find((rule) => matchesRule(file, rule));
}

function classify(file: string, config: BoundaryConfig): { kind: Classification; reason: string } {
  const blocked = findMatch(file, config.blocked);
  if (blocked) return { kind: 'blocked', reason: blocked.reason };

  const review = findMatch(file, config.review);
  if (review) return { kind: 'review', reason: review.reason };

  const shareable = findMatch(file, config.shareable);
  if (shareable) return { kind: 'shareable', reason: shareable.reason };

  return {
    kind: 'unknown',
    reason: 'No boundary rule matched this path. Update config/open-core-boundaries.json before exporting this change.',
  };
}

function changedFiles(options: { base?: string; head?: string; staged?: boolean }): string[] {
  const output = options.staged
    ? git(['diff', '--cached', '--name-only', '--diff-filter=ACDMR'])
    : git(['diff', '--name-only', '--diff-filter=ACDMR', `${options.base ?? 'HEAD~1'}..${options.head ?? 'HEAD'}`]);

  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function commitsForRange(base: string, head: string): string[] {
  const output = git(['rev-list', '--reverse', `${base}..${head}`]);
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function printGroup(
  title: string,
  rows: Array<{ file: string; reason: string }>,
  options: { verbose?: boolean; limit?: number } = {},
) {
  if (rows.length === 0) return;
  const verbose = options.verbose ?? false;
  const limit = options.limit ?? 20;
  const visibleRows = verbose ? rows : rows.slice(0, limit);
  console.log(`\n${title}`);
  for (const row of visibleRows) {
    console.log(`- ${row.file}`);
    console.log(`  ${row.reason}`);
  }
  if (!verbose && rows.length > visibleRows.length) {
    console.log(`- ... ${rows.length - visibleRows.length} more not shown`);
  }
}

function uniqueRows(rows: Array<{ file: string; reason: string }>) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.file}::${row.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }

  if (!options.staged && (Boolean(options.base) !== Boolean(options.head))) {
    throw new Error('Provide both --base and --head together, or neither.');
  }

  const config = loadConfig();
  const files = changedFiles(options);

  if (files.length === 0) {
    console.error('No changed files found for the requested diff.');
    process.exit(3);
  }

  const shareable: Array<{ file: string; reason: string }> = [];
  const review: Array<{ file: string; reason: string }> = [];
  const blocked: Array<{ file: string; reason: string }> = [];
  const unknown: Array<{ file: string; reason: string }> = [];

  for (const file of files) {
    const result = classify(file, config);
    const row = { file, reason: result.reason };
    if (result.kind === 'shareable') shareable.push(row);
    else if (result.kind === 'review') review.push(row);
    else if (result.kind === 'blocked') blocked.push(row);
    else unknown.push(row);
  }

  console.log('OpenCore export preflight');
  console.log(`- files scanned: ${files.length}`);
  console.log(`- shareable: ${shareable.length}`);
  console.log(`- review: ${review.length}`);
  console.log(`- blocked: ${blocked.length}`);
  console.log(`- unknown: ${unknown.length}`);

  const shareableRows = uniqueRows(shareable);
  const reviewRows = uniqueRows(review);
  const blockedRows = uniqueRows(blocked);
  const unknownRows = uniqueRows(unknown);

  printGroup('Shareable files', shareableRows, { verbose: options.verbose });
  printGroup('Review-sensitive files', reviewRows, { verbose: options.verbose });
  printGroup('Blocked files', blockedRows, { verbose: options.verbose });
  printGroup('Unknown files', unknownRows, { verbose: options.verbose });

  if (!options.verbose && (shareableRows.length > 20 || reviewRows.length > 20 || blockedRows.length > 20 || unknownRows.length > 20)) {
    console.log('\nTip: rerun with --verbose to list every matching file.');
  }

  if (!options.staged) {
    const base = options.base ?? 'HEAD~1';
    const head = options.head ?? 'HEAD';
    const commits = commitsForRange(base, head);
    if (commits.length > 0) {
      console.log('\nSuggested OpenCore import command');
      console.log(`git -C ../rorca-opencore cherry-pick -x ${commits.join(' ')}`);
    }
  }

  if (blockedRows.length > 0 || unknownRows.length > 0) {
    console.error('\nExport is NOT safe yet. Remove blocked files from the export set or extend the boundary manifest deliberately.');
    process.exit(1);
  }

  if (reviewRows.length > 0 && !options.allowReview) {
    console.error('\nExport requires human review because boundary-sensitive files changed. Re-run with --allow-review only after confirming the change belongs in OpenCore too.');
    process.exit(2);
  }

  console.log('\nExport preflight passed.');
}

main();
