/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertCloseoutReconciliationProjectionProgressForTests } from '../run-closeout-reconciliation';

const accepted = {
  status: 'failed',
  lifecycleStatus: 'failed',
  summary: 'worker_closeout_failed',
  lifecycleDiagnostics: {
    reason: 'one or more integrated passes lack exactly one released host outbox',
    closeout: { source: 'historical-worker', attempt: 1 },
  },
  lifecycleUpdatedAt: '2026-07-26T10:30:00.111Z',
  finishedAt: '2026-07-26T10:30:00.222Z',
};

function assertProgress(
  current: Record<string, unknown>,
  progress: { hostCloseoutCount: number; releaseStatus: string | null; terminalEventCount: number },
): void {
  assertCloseoutReconciliationProjectionProgressForTests({ accepted, current, progress });
}

test('binds every signed original projection field before first host-closeout action', () => {
  expect(() => assertProgress(
    { ...accepted, lifecycleDiagnostics: { ...accepted.lifecycleDiagnostics } },
    { hostCloseoutCount: 0, releaseStatus: null, terminalEventCount: 0 },
  )).not.toThrow();

  expect(() => assertProgress(
    { ...accepted, finishedAt: '2026-07-26T10:30:00.223Z' },
    { hostCloseoutCount: 0, releaseStatus: null, terminalEventCount: 0 },
  )).toThrow('finished_at changed');
  expect(() => assertProgress(
    { ...accepted, lifecycleDiagnostics: { ...accepted.lifecycleDiagnostics, attempt: 2 } },
    { hostCloseoutCount: 0, releaseStatus: null, terminalEventCount: 0 },
  )).toThrow('lifecycle diagnostics changed');
  expect(() => assertProgress(
    { ...accepted, lifecycleUpdatedAt: '2026-07-26T10:30:00.112Z' },
    { hostCloseoutCount: 0, releaseStatus: null, terminalEventCount: 0 },
  )).toThrow('lifecycle_updated_at changed');
  expect(() => assertProgress(
    { ...accepted, summary: 'release_deferred:unexpected' },
    { hostCloseoutCount: 0, releaseStatus: null, terminalEventCount: 0 },
  )).toThrow('summary changed');
});

test('rejects sub-millisecond original timestamp drift rather than truncating signed PostgreSQL precision', () => {
  const microsecondAccepted = {
    ...accepted,
    lifecycleUpdatedAt: '2026-07-26T10:30:00.111222Z',
    finishedAt: '2026-07-26T10:30:00.222333Z',
  };
  expect(() => assertCloseoutReconciliationProjectionProgressForTests({
    accepted: microsecondAccepted,
    current: { ...microsecondAccepted, finishedAt: '2026-07-26T10:30:00.222334Z' },
    progress: { hostCloseoutCount: 0, releaseStatus: null, terminalEventCount: 0 },
  })).toThrow('finished_at changed');
  expect(() => assertCloseoutReconciliationProjectionProgressForTests({
    accepted: microsecondAccepted,
    current: { ...microsecondAccepted, lifecycleUpdatedAt: '2026-07-26T10:30:00.111223Z' },
    progress: { hostCloseoutCount: 0, releaseStatus: null, terminalEventCount: 0 },
  })).toThrow('lifecycle_updated_at changed');
});

test.each([
  {
    name: 'host closeout published',
    current: accepted,
    progress: { hostCloseoutCount: 1, releaseStatus: null, terminalEventCount: 0 },
  },
  {
    name: 'release intent prepared',
    current: { ...accepted, status: 'release_pending' },
    progress: { hostCloseoutCount: 1, releaseStatus: 'pending', terminalEventCount: 0 },
  },
  {
    name: 'terminal intent persisted before public done',
    current: { ...accepted, status: 'release_pending' },
    progress: { hostCloseoutCount: 1, releaseStatus: 'processing', terminalEventCount: 1 },
  },
  {
    name: 'public done before release receipt completion',
    current: { ...accepted, status: 'done', lifecycleStatus: 'finished' },
    progress: { hostCloseoutCount: 1, releaseStatus: 'processing', terminalEventCount: 1 },
  },
  {
    name: 'release completed',
    current: { ...accepted, status: 'done', lifecycleStatus: 'finished' },
    progress: { hostCloseoutCount: 1, releaseStatus: 'completed', terminalEventCount: 1 },
  },
])('allows only documented protocol-owned progression: $name', ({ current, progress }) => {
  expect(() => assertProgress(current, progress)).not.toThrow();
});

test.each([
  ['finished_at', { finishedAt: '2026-07-26T10:30:01.222Z' }],
  ['diagnostics', { lifecycleDiagnostics: { reason: 'drifted-after-host-closeout' } }],
  ['lifecycle timestamp', { lifecycleUpdatedAt: '2026-07-26T10:31:00.111Z' }],
] as const)('rejects signed %s drift after host/release partial progression', (_name, drift) => {
  expect(() => assertProgress(
    { ...accepted, ...drift, status: 'release_pending' },
    { hostCloseoutCount: 1, releaseStatus: 'processing', terminalEventCount: 1 },
  )).toThrow(/changed after owner authorization/);
});

test('host publication and final correction bind projection invariants under SQL row locks', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'run-closeout-reconciliation.ts'), 'utf8');
  const lockedPublication = source.slice(
    source.indexOf('async function persistAuthorizedInitialHostCloseout'),
    source.indexOf('export interface CloseoutOnlySequenceActions'),
  );
  expect(lockedPublication).toContain('FOR UPDATE');
  expect(lockedPublication).toContain('assertProtocolOwnedProjectionProgress');
  expect(lockedPublication.indexOf('assertProtocolOwnedProjectionProgress'))
    .toBeLessThan(lockedPublication.indexOf('insertPreparedHostRunCloseout'));
  expect(source).toContain('finished_at IS NOT DISTINCT FROM $6::timestamptz');
  expect(source).toContain('lifecycle_updated_at IS NOT DISTINCT FROM $7::timestamptz');
  expect(source).toContain('lifecycle_diagnostics = $8::jsonb');
});

test('rejects undocumented status/lifecycle combinations and terminal progression', () => {
  expect(() => assertProgress(
    { ...accepted, status: 'done', lifecycleStatus: 'finished' },
    { hostCloseoutCount: 1, releaseStatus: 'processing', terminalEventCount: 0 },
  )).toThrow('status/lifecycle differs');
  expect(() => assertProgress(
    { ...accepted, status: 'release_pending' },
    { hostCloseoutCount: 1, releaseStatus: 'completed', terminalEventCount: 1 },
  )).toThrow('Completed release intent lacks exact public terminal projection');
  expect(() => assertProgress(
    accepted,
    { hostCloseoutCount: 0, releaseStatus: 'pending', terminalEventCount: 0 },
  )).toThrow();
  expect(() => assertProgress(
    accepted,
    { hostCloseoutCount: 1, releaseStatus: null, terminalEventCount: 1 },
  )).toThrow('Terminal event exists without protocol-owned release authority');
});
