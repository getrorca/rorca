/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveTestDatabaseUrl } from '../test-db-safety';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('test target is pinned to the authorized certification identity', () => {
  assert.throws(
    () => resolveTestDatabaseUrl({
      RORCA_TEST_DATABASE_URL: 'postgresql://other_runner:secret@localhost:5432/other_test',
      RORCA_TEST_DB_ENV_FILE: '/definitely/missing/rorca-test-db.env',
    }),
    /rorca_test_runner@rorca_cert_test/,
  );
});

test('Jest setup verifies pre-provisioned authority objects without mutating them', () => {
  const source = fs.readFileSync(path.join(backendRoot, 'jest.setup.ts'), 'utf8');
  assert.doesNotMatch(source, /\bCREATE\s+(?:ROLE|SCHEMA|EXTENSION)\b/i);
  assert.doesNotMatch(source, /\bGRANT\b/i);
  assert.doesNotMatch(source, /\bALTER\s+TABLE\b/i);
  assert.doesNotMatch(source, /\bCREATE\s+TABLE\b/i);
});

test('shared harness never performs global data cleanup around test cases or suites', () => {
  const source = fs.readFileSync(path.join(backendRoot, 'jest.pool-cleanup.ts'), 'utf8');
  assert.match(source, /\bbeforeAll\s*\(/);
  assert.match(source, /\bafterAll\s*\(/);
  assert.doesNotMatch(source, /\bbeforeEach\s*\(/);
  assert.doesNotMatch(source, /\bafterEach\s*\(/);
  assert.doesNotMatch(source, /\bTRUNCATE\b/i);
  assert.doesNotMatch(source, /\bDELETE\s+FROM\b/i);
});
