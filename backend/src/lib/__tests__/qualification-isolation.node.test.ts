/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  activateQualificationBoundary,
  buildQualificationEvidence,
  buildQualificationIdentity,
  buildSanitizedQualificationEnv,
  cleanupQualificationArtifacts,
  createQualificationQueue,
  deleteOwnedQualificationRows,
  deleteQualificationQueue,
  qualificationIsolationMarker,
  QUALIFICATION_OWNER_MARKER,
  QUALIFICATION_REPOSITORY_MARKER,
  registerQualificationWorktree,
  verifyQualificationDatabase,
  type QualificationQueryable,
} from '../qualification-isolation';

const RUN_ID = 'qrun_0123456789abcdef01234567';
const TOKEN = RUN_ID.slice('qrun_'.length);
// Jest's dedicated-DB guard requires the final _test suffix.
const DATABASE = `rorca_qtest_${TOKEN}_test`;
const ROLE = `rorca_qrole_${TOKEN}`;
const APPLICATION_NAME = `rorca-qualification:${RUN_ID}`;
const DATABASE_URL = `postgres://${ROLE}:qualification-secret@localhost:5432/${DATABASE}?application_name=${encodeURIComponent(APPLICATION_NAME)}`;
const MARKER = qualificationIsolationMarker(RUN_ID);
const gitEnvironment = {
  PATH: process.env.PATH ?? '',
  HOME: os.tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
};

function runtimeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    RORCA_QUALIFICATION_RUN_ID: RUN_ID,
    RORCA_QUALIFICATION_ISOLATION_MARKER: MARKER,
    RORCA_QUALIFICATION_DATABASE_URL: DATABASE_URL,
    ...extra,
  };
}

function databaseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    database: DATABASE,
    role: ROLE,
    owner: ROLE,
    application_name: APPLICATION_NAME,
    isolation_marker: MARKER,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    ...overrides,
  };
}

function fakeClient(row = databaseRow()): QualificationQueryable & { calls: Array<{ sql: string; values?: unknown[] }> } {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  return {
    calls,
    async query<T>(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [row as T] };
    },
  };
}

function directorySentinel(directory: string): string {
  return createHash('sha256').update(JSON.stringify(fs.readdirSync(directory).sort())).digest('hex');
}

test('sanitized launch env keeps only qualification identity and non-secret process basics', () => {
  const sanitized = buildSanitizedQualificationEnv({
    ...runtimeEnv(),
    PATH: process.env.PATH,
    DATABASE_URL: 'postgres://operator:production-secret@prod-primary/rorca',
    PGHOST: 'prod-primary',
    RORCA_QUEUE_NAME: 'pipeline:run',
    RORCA_WORKSPACE_PATH: '/private/operator/repository',
    GITHUB_TOKEN: 'production-token',
    OPENAI_API_KEY: 'production-provider-key',
    AWS_SECRET_ACCESS_KEY: 'production-cloud-key',
  });

  assert.equal(sanitized.RORCA_QUALIFICATION_DATABASE_URL, DATABASE_URL);
  assert.equal(sanitized.NODE_ENV, 'test');
  for (const key of ['DATABASE_URL', 'PGHOST', 'RORCA_QUEUE_NAME', 'RORCA_WORKSPACE_PATH', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY']) {
    assert.equal(sanitized[key], undefined);
  }
});

test('server truth is read exactly once and rejects owner, marker, identity, or elevated role mismatch', async () => {
  const accepted = fakeClient();
  const verified = await verifyQualificationDatabase(accepted, runtimeEnv());
  assert.equal(verified.identity.database, DATABASE);
  assert.equal(accepted.calls.length, 1);
  assert.match(accepted.calls[0].sql, /^\s*SELECT /);

  for (const mismatch of [
    { owner: 'operator' },
    { isolation_marker: null },
    { application_name: 'rorca-server' },
    { rolsuper: true },
    { rolcreatedb: true },
  ]) {
    const rejected = fakeClient(databaseRow(mismatch));
    await assert.rejects(verifyQualificationDatabase(rejected, runtimeEnv()), /qualification-isolation/);
    assert.equal(rejected.calls.length, 1);
  }
});

test('activation creates only synthetic namespaced fixtures after preflight and guarded cleanup removes them', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wpe-parent-'));
  try {
    const client = fakeClient();
    const { boundary } = await activateQualificationBoundary(client, runtimeEnv(), parent);
    assert.equal(client.calls.length, 1);
    for (const value of [
      boundary.workspaceId,
      boundary.repositoryId,
      boundary.branchPrefix,
      boundary.specId,
      boundary.syntheticRunId,
      boundary.queuePrefix,
      path.basename(boundary.artifactRoot),
    ]) {
      assert.ok(value.includes(RUN_ID));
    }
    assert.ok(boundary.artifactRoot.startsWith(`${fs.realpathSync(parent)}${path.sep}`));
    const worktree = registerQualificationWorktree(boundary, 'story-001');
    assert.ok(path.basename(worktree).startsWith(RUN_ID));
    cleanupQualificationArtifacts(boundary, parent);
    assert.equal(fs.existsSync(boundary.artifactRoot), false);
  } finally {
    fs.rmdirSync(parent);
  }
});

test('filesystem cleanup rejects missing markers, symlinks, and unrelated worktrees without deleting the owned root', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wpe-parent-'));
  try {
    const { boundary } = await activateQualificationBoundary(fakeClient(), runtimeEnv(), parent);
    const ownerMarker = path.join(boundary.artifactRoot, QUALIFICATION_OWNER_MARKER);
    const heldOwnerMarker = `${ownerMarker}.held`;
    fs.renameSync(ownerMarker, heldOwnerMarker);
    assert.throws(() => cleanupQualificationArtifacts(boundary, parent), /ownership marker is missing/);
    assert.equal(fs.existsSync(boundary.artifactRoot), true);
    fs.renameSync(heldOwnerMarker, ownerMarker);

    const repositoryMarker = path.join(boundary.repositoryRoot, QUALIFICATION_REPOSITORY_MARKER);
    const heldRepositoryMarker = `${repositoryMarker}.held`;
    fs.renameSync(repositoryMarker, heldRepositoryMarker);
    assert.throws(() => cleanupQualificationArtifacts(boundary, parent), /repository ownership marker is missing/);
    assert.equal(fs.existsSync(boundary.artifactRoot), true);
    fs.renameSync(heldRepositoryMarker, repositoryMarker);

    const symlink = path.join(boundary.repositoryRoot, 'escape');
    fs.symlinkSync(parent, symlink);
    assert.throws(() => cleanupQualificationArtifacts(boundary, parent), /symlinks are forbidden/);
    assert.equal(fs.existsSync(boundary.artifactRoot), true);
    fs.unlinkSync(symlink);

    const unrelated = path.join(boundary.worktreeRoot, 'operator-worktree');
    fs.mkdirSync(unrelated);
    assert.throws(() => cleanupQualificationArtifacts(boundary, parent), /unrelated worktree/);
    assert.equal(fs.existsSync(boundary.artifactRoot), true);
    fs.rmdirSync(unrelated);
    cleanupQualificationArtifacts(boundary, parent);
  } finally {
    fs.rmdirSync(parent);
  }
});

test('database and pg-boss operations accept only the current namespace and createQueue API', async () => {
  const identity = buildQualificationIdentity(RUN_ID, DATABASE_URL);
  const queueCalls: string[] = [];
  const boss = {
    async createQueue(name: string) { queueCalls.push(`create:${name}`); },
    async deleteQueue(name: string) { queueCalls.push(`delete:${name}`); },
  };
  const queue = await createQualificationQueue(boss, identity, 'pipeline-run');
  await deleteQualificationQueue(boss, identity, queue);
  assert.deepEqual(queueCalls, [`create:${identity.queuePrefix}pipeline-run`, `delete:${identity.queuePrefix}pipeline-run`]);
  await assert.rejects(deleteQualificationQueue(boss, identity, 'pipeline:run'), /qualification queue purpose is invalid/);

  const cleanupClient = fakeClient({});
  await deleteOwnedQualificationRows(cleanupClient, identity, 'qualification_fixtures', 'workspace_id', identity.workspaceId);
  assert.equal(cleanupClient.calls.length, 1);
  assert.equal(cleanupClient.calls[0].sql, 'DELETE FROM qualification_fixtures WHERE workspace_id = $1 RETURNING 1');
  await assert.rejects(deleteOwnedQualificationRows(cleanupClient, identity, 'wal_events', 'workspace_id', identity.workspaceId), /unsafe or immutable/);
  await assert.rejects(deleteOwnedQualificationRows(cleanupClient, identity, 'pgboss.job', 'queue_name', `${identity.queuePrefix}pipeline-run`), /unsafe or immutable/);
  await assert.rejects(deleteOwnedQualificationRows(cleanupClient, identity, 'qualification_fixtures', 'workspace_id', 'operator-workspace'), /not owned/);
  assert.equal(cleanupClient.calls.length, 1);
});

test('production-like mixed identities fail before filesystem, Git, DB, WAL, queue, or run-state mutation', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wpe-negative-'));
  const beforeFilesystem = directorySentinel(parent);
  const beforeGit = execFileSync('git', ['rev-parse', 'HEAD'], { env: gitEnvironment, encoding: 'utf8' }).trim();
  const mutations = { filesystem: 0, git: 0, database: 0, wal: 0, queue: 0, runState: 0 };
  const client: QualificationQueryable = {
    async query<T>() {
      mutations.database += 1;
      return { rows: [databaseRow() as T] };
    },
  };
  const mixedProductionEnv = runtimeEnv({
    DATABASE_URL: 'postgres://operator:secret@prod-primary/rorca',
    RORCA_WORKSPACE_ID: 'operator-primary-workspace',
    RORCA_REPOSITORY: 'company/live-repository',
    RORCA_QUEUE_NAME: 'pipeline:run',
    GITHUB_TOKEN: 'operator-token',
  });

  try {
    await assert.rejects(activateQualificationBoundary(client, mixedProductionEnv, parent), /mixed or inherited identity/);
    assert.equal(directorySentinel(parent), beforeFilesystem);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { env: gitEnvironment, encoding: 'utf8' }).trim(), beforeGit);
    assert.deepEqual(mutations, { filesystem: 0, git: 0, database: 0, wal: 0, queue: 0, runState: 0 });
  } finally {
    fs.rmdirSync(parent);
  }
});

test('evidence contains only redacted identities and sentinel digests', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wpe-evidence-'));
  try {
    const { boundary } = await activateQualificationBoundary(fakeClient(), runtimeEnv(), parent);
    const evidence = buildQualificationEvidence(
      boundary,
      { database: 'private production payload', queue: ['operator-job'] },
      { database: 'private production payload', queue: ['operator-job'] },
    );
    const serialized = JSON.stringify(evidence);
    assert.ok(!serialized.includes('qualification-secret'));
    assert.ok(!serialized.includes(boundary.artifactRoot));
    assert.ok(!serialized.includes('private production payload'));
    assert.ok(!serialized.includes('operator-job'));
    assert.match(serialized, /sha256/);
    cleanupQualificationArtifacts(boundary, parent);
  } finally {
    fs.rmdirSync(parent);
  }
});
