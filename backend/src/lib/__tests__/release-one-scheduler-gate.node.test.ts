/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertReleaseOneCapabilityEnabled,
  isReleaseOneCapabilityEnabled,
} from '../release-one-capability-profile';
import { UnprocessableError } from '../errors';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

test('Release-1 scheduled implementation is disabled with a typed fail-closed result', () => {
  assert.equal(isReleaseOneCapabilityEnabled('scheduled_autonomy'), false);
  assert.throws(
    () => assertReleaseOneCapabilityEnabled('scheduled_autonomy'),
    (error: unknown) => error instanceof UnprocessableError
      && error.code === 'RELEASE_ONE_CAPABILITY_DISABLED'
      && error.details?.capabilityId === 'scheduled_autonomy',
  );
});

test('scheduler trigger, scanner, and pg-boss registration all consult the immutable gate before effects', () => {
  const source = readFileSync(path.join(repositoryRoot, 'backend/src/lib/scheduler.ts'), 'utf8');
  const occurrences = source.match(/isReleaseOneCapabilityEnabled\(['"]scheduled_autonomy['"]\)/g) ?? [];
  assert.equal(occurrences.length, 3);

  const triggerGate = source.indexOf("isReleaseOneCapabilityEnabled('scheduled_autonomy')", source.indexOf('export async function triggerScheduledRun'));
  const triggerFetch = source.indexOf('await fetch(', source.indexOf('export async function triggerScheduledRun'));
  assert.ok(triggerGate >= 0 && triggerGate < triggerFetch);

  const scannerStart = source.indexOf('export async function checkAndFireDueSchedules');
  const scannerGate = source.indexOf("isReleaseOneCapabilityEnabled('scheduled_autonomy')", scannerStart);
  const scannerQuery = source.indexOf('query<ScheduleOccurrenceRow>', scannerStart);
  assert.ok(scannerGate >= 0 && scannerGate < scannerQuery);

  const registrationStart = source.indexOf('export async function registerSchedulesWithBoss');
  const registrationGate = source.indexOf("isReleaseOneCapabilityEnabled('scheduled_autonomy')", registrationStart);
  const queueRegistration = source.indexOf('await boss.createQueue', registrationStart);
  assert.ok(registrationGate >= 0 && registrationGate < queueRegistration);
});
