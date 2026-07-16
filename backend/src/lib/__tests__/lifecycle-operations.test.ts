/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockExecute = jest.fn();
const mockPortfolio = jest.fn();

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
}));

jest.mock('../ssdlc-lifecycle-read', () => ({
  getLifecyclePortfolio: (...args: unknown[]) => mockPortfolio(...args),
}));

import { getLifecycleOperationsReport, recordLifecycleEvaluatorError } from '../lifecycle-operations';
import { ValidationError } from '../errors';

let workspacePath: string;

beforeEach(() => {
  jest.clearAllMocks();
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-lifecycle-operations-'));
  const approved = path.join(workspacePath, 'forge', 'specs', 'approved');
  fs.mkdirSync(approved, { recursive: true });
  for (const slug of ['current-spec', 'failed-spec', 'missing-spec', 'stale-spec']) {
    fs.writeFileSync(path.join(approved, `${slug}.json`), '{}');
  }

  mockQueryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM workspaces')) return { id: 'ws-a', path: workspacePath, label: 'Workspace A' };
    if (sql.includes('FROM ssdlc_plan_readiness_reasons')) return { total: 1 };
    if (sql.includes('FROM wal_events')) return {
      adapter_errors: 2,
      evidence_conflicts: 1,
      stale_preview_denials: 3,
      evaluator_errors: 1,
      phase_transitions: 4,
      backfill_pages: 2,
    };
    return undefined;
  });
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM ssdlc_compiled_plans')) return [
      { spec_slug: 'current-spec', has_current: true, has_historical: false },
      { spec_slug: 'stale-spec', has_current: false, has_historical: true },
    ];
    if (sql.includes('FROM ssdlc_plan_readiness_reasons')) return [{
      spec_slug: 'failed-spec', reason_code: 'PLAN_COMPILATION_FAILED', retryable: true, created_at: '2026-07-15T10:00:00.000Z',
    }];
    if (sql.includes("event_type = 'ssdlc_evidence_adapter_error'")) return [{
      adapter: 'github_checks', error_count: 2, last_error_at: '2026-07-15T11:00:00.000Z',
    }];
    return [];
  });
  mockPortfolio.mockResolvedValue({
    items: [
      { phases: [{ phaseId: 'qa', status: 'blocked' }] },
      { phases: [{ phaseId: 'qa', status: 'stale' }] },
    ],
    total: 2,
    kpis: { blockedSpecs: 1 },
  });
  mockExecute.mockResolvedValue({ rowCount: 1 });
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('Lifecycle operational projection', () => {
  test('reports bounded coverage, failures, adapter health, blocked phases, and exact retry actions', async () => {
    const report = await getLifecycleOperationsReport({ workspaceId: 'ws-a' });

    expect(report.safety).toMatchObject({ readOnly: true, adapterFailuresAffectSpecsOrRuns: false, backfillPageLimit: 20 });
    expect(report.rollout.planCoverage).toEqual({
      total: 4,
      current: 1,
      stale: 1,
      compilationFailed: 1,
      needsCompilation: 1,
      percentCurrent: 25,
    });
    expect(report.rollout.backfillProgress).toMatchObject({ processed: 2, remaining: 2, pagesObservedLast24h: 2, complete: false });
    expect(report.rollout.compileFailures).toEqual([expect.objectContaining({ specId: 'failed-spec', retryable: true })]);
    expect(report.rollout.blockedPhases).toEqual({
      items: [{ phaseId: 'qa', count: 2 }],
      inspectedSpecs: 2,
      truncated: false,
    });
    expect(report.rollout.retryableActions).toHaveLength(3);
    expect(report.rollout.retryableActions[0]).toMatchObject({ method: 'POST', requiresIdempotencyKey: true });
    expect(report.health).toMatchObject({
      status: 'degraded',
      counters: { compilerErrors: 1, evaluatorErrors: 1, evidenceConflicts: 1, stalePreviewDenials: 3, phaseTransitions: 4, adapterErrors: 2 },
      payloadPolicy: 'counts_and_identifiers_only',
    });
    expect(report.health.adapters).toContainEqual(expect.objectContaining({ adapter: 'github_checks', availability: 'degraded', errorsLast24h: 2 }));
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('audits only unexpected evaluator errors with a redacted payload', async () => {
    await recordLifecycleEvaluatorError({ workspaceId: 'ws-a', specId: 'safe-spec', operation: 'phase', error: new Error('secret payload') });
    await recordLifecycleEvaluatorError({ workspaceId: 'ws-a', operation: 'portfolio', error: new ValidationError('expected') });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(mockExecute.mock.calls[0][1][2]);
    expect(payload).toMatchObject({ operation: 'phase', errorType: 'Error', retryable: true });
    expect(JSON.stringify(payload)).not.toContain('secret payload');
  });
});
