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

const migration = fs.readFileSync(path.join(
  __dirname,
  '..',
  'pg-migrations',
  '20260823100000_authority_release_intents.sql',
), 'utf8');

const intentTable = migration.slice(
  migration.indexOf('CREATE TABLE IF NOT EXISTS rorca.authority_operation_intents'),
  migration.indexOf('CREATE TABLE IF NOT EXISTS rorca.authority_operation_intent_grants'),
);
const grantGuard = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION rorca.guard_authority_operation_intent_grant'),
  migration.indexOf('CREATE OR REPLACE FUNCTION rorca.protect_authority_operation_intent_grant'),
);

test('core OperationIntent stores canonical release material and provenance without provider-specific fields', () => {
  assert.match(intentTable, /intent_kind TEXT NOT NULL CHECK \(intent_kind = 'release'\)/);
  assert.match(intentTable, /intent_payload JSONB NOT NULL/);
  assert.match(intentTable, /provenance_payload JSONB NOT NULL/);
  assert.match(intentTable, /canonical_payload TEXT NOT NULL/);
  assert.match(intentTable, /intent_digest TEXT NOT NULL/);
  assert.match(intentTable, /ci_evidence_digest TEXT NOT NULL/);
  assert.doesNotMatch(migration, /coolify|control_token|environment_secret/i);
});

test('database recomputes canonical intent and CI evidence digests and rejects secret-shaped material', () => {
  assert.match(migration, /rorca:rorca\.release-intent\.v1:intent/);
  assert.match(migration, /rorca:rorca\.release-intent\.v1:ci-evidence/);
  assert.match(migration, /NEW\.canonical_payload::JSONB IS DISTINCT FROM expected_payload/);
  assert.match(migration, /NEW\.canonical_ci_evidence::JSONB IS DISTINCT FROM NEW\.provenance_payload->'ciEvidence'/);
  assert.match(migration, /control\.\?token\|secret\|credential\|password\|private\.\?key\|access\.\?token\|api\.\?key/);
});

test('intent and grant records are immutable and grants bind both exact digests', () => {
  assert.match(migration, /authority operation intents are immutable after persistence and approval/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON rorca\.authority_operation_intents/);
  assert.match(migration, /authority operation intent grants are immutable/);
  assert.match(migration, /intent_row\.intent_digest <> NEW\.intent_digest/);
  assert.match(migration, /intent_row\.ci_evidence_digest <> NEW\.ci_evidence_digest/);
  assert.match(grantGuard, /authorization grant does not bind the exact operation intent and CI evidence/);
});
