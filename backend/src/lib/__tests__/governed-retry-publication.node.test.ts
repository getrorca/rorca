/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import {
  GovernedRetryPublicationPendingError,
  classifyGovernedRetryPublication,
  waitForGovernedRetryPublication,
  type GovernedRetryPublicationSnapshot,
} from '../governed-retry-publication';

function prepared(): GovernedRetryPublicationSnapshot {
  return {
    previewStatus: 'approved',
    preparationState: 'outbox_ready',
    dispatchState: 'prepared',
    runStatus: 'queued',
    bossJobId: null,
  };
}

test('a fast worker waits for atomic publication and never maps prepared/approved to failure', async () => {
  const values = [prepared(), prepared(), {
    ...prepared(),
    previewStatus: 'dispatched',
    preparationState: 'published' as const,
    dispatchState: 'dispatched',
    bossJobId: 'c426d632-8b3d-48c1-a899-4b064b540ced',
  }];
  let index = 0;
  const result = await waitForGovernedRetryPublication({
    read: async () => values[Math.min(index++, values.length - 1)],
    attempts: 3,
    delayMs: 0,
    sleep: async () => undefined,
  });
  assert.equal(result.outcome, 'published');
  assert.equal(classifyGovernedRetryPublication(prepared()), 'pending');
});

test('bounded publication wait asks pg-boss to retry without changing durable run state', async () => {
  await assert.rejects(
    waitForGovernedRetryPublication({
      read: async () => prepared(),
      attempts: 2,
      delayMs: 0,
      sleep: async () => undefined,
    }),
    GovernedRetryPublicationPendingError,
  );
  assert.equal(prepared().runStatus, 'queued');
});

test('cancelled and published replay classifications are stable', () => {
  const cancelled: GovernedRetryPublicationSnapshot = {
    previewStatus: 'cancelled', preparationState: 'cancelled', dispatchState: 'cancelled',
    runStatus: 'cancelled', bossJobId: null,
  };
  const published: GovernedRetryPublicationSnapshot = {
    previewStatus: 'dispatched', preparationState: 'published', dispatchState: 'claimed',
    runStatus: 'running', bossJobId: 'c426d632-8b3d-48c1-a899-4b064b540ced',
  };
  assert.equal(classifyGovernedRetryPublication(cancelled), 'cancelled');
  assert.equal(classifyGovernedRetryPublication(cancelled), 'cancelled');
  assert.equal(classifyGovernedRetryPublication(published), 'published');
  assert.equal(classifyGovernedRetryPublication(published), 'published');
});

test('forward migration makes cancellation terminal and never manages pg-boss tables', () => {
  const root = fs.existsSync(path.resolve(process.cwd(), 'backend', 'src'))
    ? path.resolve(process.cwd(), 'backend', 'src')
    : path.resolve(process.cwd(), 'src');
  const migration = fs.readFileSync(
    path.join(root, 'db', 'pg-migrations', '20260719107000_governed_retry_publication_cancellation.sql'),
    'utf8',
  );
  assert.match(migration, /WHEN 'prepared' THEN NEW\.state IN \('dispatched', 'failed', 'cancelled'\)/);
  assert.match(migration, /WHEN 'dispatched' THEN NEW\.state IN \('claimed', 'failed', 'cancelled'\)/);
  assert.match(migration, /WHEN 'pending' THEN NEW\.state IN \('executing', 'failed', 'cancelled'\)/);
  assert.match(migration, /terminal governed retry evidence is immutable/);
  assert.match(migration, /terminal governed retry attempt evidence is immutable/);
  assert.doesNotMatch(migration, /(?:CREATE|ALTER|DROP|DELETE FROM|UPDATE)\s+(?:TABLE\s+)?pgboss\./i);
});

test('terminalizer migration permits cancellation and manual-review convergence without managing pg-boss', () => {
  const root = fs.existsSync(path.resolve(process.cwd(), 'backend', 'src'))
    ? path.resolve(process.cwd(), 'backend', 'src')
    : path.resolve(process.cwd(), 'src');
  const migration = fs.readFileSync(
    path.join(root, 'db', 'pg-migrations', '20260720148000_governed_retry_terminalization.sql'),
    'utf8',
  );
  assert.match(migration, /WHEN 'claimed' THEN NEW\.state IN \('executing', 'failed', 'cancelled'\)/);
  assert.match(migration, /WHEN 'executing' THEN NEW\.state IN \('committed', 'failed', 'cancelled'\)/);
  assert.match(migration, /WHEN 'committed' THEN NEW\.state IN \('integrating', 'failed', 'manual_review_required'\)/);
  assert.doesNotMatch(migration, /(?:CREATE|ALTER|DROP|DELETE FROM|UPDATE)\s+(?:TABLE\s+)?pgboss\./i);
});
