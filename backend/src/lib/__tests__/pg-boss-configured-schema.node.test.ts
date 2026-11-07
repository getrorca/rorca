// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { getPgBossSchemaName, getPgBossTableSql } from '../pg-boss-schema';

const srcRoot = path.resolve(import.meta.dirname, '../..');

function productionTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'pg-migrations') continue;
      files.push(...productionTypeScriptFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

test('configured schema is validated and rendered through a closed table set', () => {
  const previous = process.env.RORCA_PGBOSS_SCHEMA;
  try {
    process.env.RORCA_PGBOSS_SCHEMA = 'pgboss_cert_alt';
    assert.equal(getPgBossSchemaName(), 'pgboss_cert_alt');
    assert.equal(getPgBossTableSql('job'), '"pgboss_cert_alt".job');
    assert.throws(
      () => getPgBossTableSql('job; DROP SCHEMA public' as 'job'),
      /unsupported internal table reference/,
    );
    process.env.RORCA_PGBOSS_SCHEMA = 'pgboss_cert_alt;DROP';
    assert.throws(() => getPgBossSchemaName(), /bounded pgboss_/);
  } finally {
    if (previous === undefined) delete process.env.RORCA_PGBOSS_SCHEMA;
    else process.env.RORCA_PGBOSS_SCHEMA = previous;
  }
});

test('production SQL and pg-boss clients never bypass the validated configured schema', () => {
  const violations: string[] = [];
  const directPgBossSql = /\b(?:FROM|JOIN|UPDATE|INTO|DELETE\s+FROM)\s+pgboss\.[a-z_]+/g;
  const hardcodedClientSchema = /\bschema\s*:\s*['"]pgboss['"]/g;

  for (const file of productionTypeScriptFiles(srcRoot)) {
    const source = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const pattern of [directPgBossSql, hardcodedClientSchema]) {
      for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index).split('\n').length;
        violations.push(`${path.relative(srcRoot, file)}:${line}:${match[0]}`);
      }
    }
  }

  assert.deepEqual(violations, [], `literal default-schema pg-boss bypasses:\n${violations.join('\n')}`);
});

test('backend startup initializes transport, recovers application publications, then reconciles orphans', () => {
  const source = fs.readFileSync(path.join(srcRoot, 'server.ts'), 'utf8');
  const initialization = source.indexOf('initBoss()');
  const publicationRecovery = source.indexOf('await recoverPendingDispatchPublications()', initialization);
  const cleanup = source.indexOf('await cleanupOrphanRuns()', publicationRecovery);
  const failureBoundary = source.indexOf(".catch(err => logger.error({ err }, '[pg-boss] startup init/recovery/cleanup failed'))", cleanup);

  assert.ok(initialization >= 0, 'configured pg-boss initialization is missing');
  assert.ok(publicationRecovery > initialization, 'application publication recovery must follow transport initialization');
  assert.ok(cleanup > publicationRecovery, 'orphan reconciliation must follow publication recovery');
  assert.ok(failureBoundary > cleanup, 'the complete startup authority sequence must share one failure boundary');
  assert.equal(source.slice(0, initialization).includes('cleanupOrphanRuns();'), false);
  assert.equal(source.slice(0, initialization).includes('recoverPendingDispatchPublications();'), false);
});

test('post-save recovery preserves the legacy TEXT-to-UUID schema boundary safely', () => {
  const stageMigration = fs.readFileSync(
    path.join(srcRoot, 'db/pg-migrations/20260618150000_spec_post_save_workflows.sql'),
    'utf8',
  );
  const jobMigration = fs.readFileSync(
    path.join(srcRoot, 'db/pg-migrations/20260503183000_add_boss_job_id_to_spec_jobs.sql'),
    'utf8',
  );
  const source = fs.readFileSync(path.join(srcRoot, 'lib/spec-post-save-workflow.ts'), 'utf8');
  const recoveryStart = source.indexOf('export async function recoverBoundPostSaveWorkflowPublications');
  const recoveryEnd = source.indexOf('async function blockStageAndDependents', recoveryStart);
  const recoverySource = source.slice(recoveryStart, recoveryEnd);

  assert.match(stageMigration, /boss_job_id TEXT,/);
  assert.match(jobMigration, /ADD COLUMN IF NOT EXISTS boss_job_id UUID;/);
  assert.match(recoverySource, /stage\.boss_job_id=job\.boss_job_id::text/);
  assert.doesNotMatch(recoverySource, /stage\.boss_job_id\s*::\s*uuid/i);
});

test('worker startup recovers bound post-save publications before registering handlers', () => {
  const source = fs.readFileSync(path.join(srcRoot, 'worker.ts'), 'utf8');
  const startup = source.indexOf('async function start(): Promise<void>');
  const initialization = source.indexOf('await initBoss()', startup);
  const publicationRecovery = source.indexOf(
    'const postSaveRecovery = await recoverBoundPostSaveWorkflowPublications()',
    initialization,
  );
  const failureBoundary = source.indexOf(
    "[worker] pipeline dispatch publication recovery failed closed",
    publicationRecovery,
  );
  const failureExit = source.indexOf('process.exit(1)', publicationRecovery);
  const handlerRegistration = source.indexOf('await registerRunQueueConsumers(boss', publicationRecovery);

  assert.ok(startup >= 0, 'worker startup is missing');
  assert.ok(initialization > startup, 'worker must initialize pg-boss during startup');
  assert.ok(publicationRecovery > initialization, 'post-save recovery must follow transport initialization');
  assert.ok(failureBoundary > publicationRecovery, 'post-save recovery must remain inside the fail-closed startup boundary');
  assert.ok(failureExit > publicationRecovery && failureExit < handlerRegistration, 'startup recovery failure must exit before handlers poll');
  assert.ok(handlerRegistration > failureBoundary, 'worker handlers must register only after publication recovery');
});
