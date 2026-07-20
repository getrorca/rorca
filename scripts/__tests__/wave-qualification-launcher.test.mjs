// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQualificationChildEnv } from '../run-wave-qualification.mjs';

const runId = 'qrun_89abcdef0123456789abcdef';
const token = runId.slice('qrun_'.length);
const url = `postgres://rorca_qrole_${token}:test-secret@localhost/rorca_qtest_${token}_test?application_name=${encodeURIComponent(`rorca-qualification:${runId}`)}`;
const base = {
  NODE_ENV: 'production',
  RORCA_QUALIFICATION_RUN_ID: runId,
  RORCA_QUALIFICATION_ISOLATION_MARKER: `rorca-qualification-owned:${runId}`,
  RORCA_QUALIFICATION_DATABASE_URL: url,
};

test('launcher does not inherit application, queue, workspace, repository, cloud, or provider credentials', () => {
  const child = buildQualificationChildEnv({
    ...base,
    DATABASE_URL: 'postgres://prod',
    PGHOST: 'primary',
    RORCA_QUEUE_NAME: 'pipeline:run',
    RORCA_WORKSPACE_PATH: '/private/repo',
    GITHUB_TOKEN: 'secret',
    OPENAI_API_KEY: 'secret',
    AWS_SECRET_ACCESS_KEY: 'secret',
  }, '/synthetic/scenario.ts');

  assert.equal(child.NODE_ENV, 'test');
  assert.equal(child.RORCA_QUALIFICATION_DATABASE_URL, url);
  assert.deepEqual(Object.keys(child).sort(), [
    'NODE_ENV',
    'RORCA_QUALIFICATION_DATABASE_URL',
    'RORCA_QUALIFICATION_ISOLATION_MARKER',
    'RORCA_QUALIFICATION_RUN_ID',
    'RORCA_QUALIFICATION_SCENARIO',
  ]);
});

test('launcher rejects production-like host even when database and role are labelled test', () => {
  const mixed = new URL(url);
  mixed.hostname = 'prod-primary.example';
  assert.throws(
    () => buildQualificationChildEnv({ ...base, RORCA_QUALIFICATION_DATABASE_URL: mixed.toString() }, '/synthetic/scenario.ts'),
    /production-like identity/,
  );
});

test('launcher never falls back when qualification URL or marker is absent', () => {
  assert.throws(
    () => buildQualificationChildEnv({ ...base, RORCA_QUALIFICATION_DATABASE_URL: '', DATABASE_URL: url }, '/synthetic/scenario.ts'),
    /database URL is invalid/,
  );
  assert.throws(
    () => buildQualificationChildEnv({ ...base, RORCA_QUALIFICATION_ISOLATION_MARKER: '' }, '/synthetic/scenario.ts'),
    /isolation marker/,
  );
});
