#!/usr/bin/env node
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Guard: no tracked executable script may carry an inline database password.
 *
 * This exists because `scripts/monitor-run-journey.sh` shipped a real
 * `postgres://<user>:<password>@localhost:5432/rorca` connection string. The
 * default gitleaks ruleset does not match that shape, and a shape-based secret
 * rule produced 51 hits — 50 of them documentation/example URLs — so the
 * control lives here instead: precise scope (executable files only), no noise,
 * and it fails the PR contract lane.
 *
 * Documentation, examples, and tests are deliberately out of scope: they are
 * expected to contain illustrative connection strings.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SCOPES = ['scripts/', 'bin/'];
const EXECUTABLE_EXTENSIONS = new Set(['.sh', '.bash', '.mjs', '.cjs', '.js', '.ts']);
const EXCLUDED_SEGMENTS = ['__tests__/', '.test.', '.spec.'];
const PASSWORD_SHAPE = /postgres(?:ql)?:\/\/[^:\s/'"]+:([^@\s'"]+)@/g;

function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

function inScope(file) {
  if (!SCOPES.some((scope) => file.startsWith(scope))) return false;
  if (EXCLUDED_SEGMENTS.some((segment) => file.includes(segment))) return false;
  return EXECUTABLE_EXTENSIONS.has(path.extname(file));
}

const MIN_CREDENTIAL_LENGTH = 8;

function isPlaceholder(password) {
  // `***`, `<redacted>`, `${VAR}`, `…` and empty values are not credentials.
  if (!password) return true;
  if (password.length < MIN_CREDENTIAL_LENGTH) return true; // e.g. the `rorca` local docker default
  if (/^[*<]/.test(password)) return true;
  if (/^\$\{?[A-Za-z_]/.test(password)) return true;
  if (/[^\x20-\x7e]/.test(password)) return true; // ellipsis / non-ASCII placeholders
  return false;
}

test('no tracked executable script embeds an inline database password', () => {
  const offenders = [];

  for (const file of trackedFiles()) {
    if (!inScope(file)) continue;
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) continue;

    const lines = fs.readFileSync(absolute, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(PASSWORD_SHAPE)) {
        if (isPlaceholder(match[1])) continue;
        offenders.push(`${file}:${index + 1}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `inline database credentials found in executable files: ${offenders.join(', ')}\n`
      + 'Read the connection string from the environment instead '
      + '(e.g. RORCA_DATABASE_URL) — never commit a password.',
  );
});
