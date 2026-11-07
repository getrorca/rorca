/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { query, queryOne } from '../../db/index';
import { getLifecyclePortfolio, getLifecycleSpec } from '../ssdlc-lifecycle-read';
import { ActionEnvelopeV1Schema, DeliveryCaseSummaryV1Schema, RunControlProjectionV1Schema } from '../mission-contracts';
import { getDeliveryCaseSummary, getRunControlProjection, getWorkspaceAttention } from '../mission-read-models';
import { NotFoundError, ValidationError } from '../errors';

jest.mock('../../db/index', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('../ssdlc-lifecycle-read', () => ({ getLifecyclePortfolio: jest.fn(), getLifecycleSpec: jest.fn() }));

const portfolioMock = jest.mocked(getLifecyclePortfolio);
const queryMock = jest.mocked(query);
const lifecycleMock = jest.mocked(getLifecycleSpec);
const queryOneMock = jest.mocked(queryOne);
const NOW = new Date('2026-08-06T12:00:00.000Z');
const SNAPSHOT = `sha256:${'a'.repeat(64)}`;

function portfolioItem(overrides: Record<string, unknown>) {
  return {
    specId: 'spec-default', title: 'Default', specStatus: 'approved', state: 'current', overallStatus: 'in_progress', risk: 'low', owner: null,
    storySummary: { total: 1, passed: 0, failed: 0 }, currentPhaseId: 'implementation', blocked: false, blockers: [], liveness: null,
    currentRevision: { specVersion: '7', inputHash: SNAPSHOT, planVersion: 'v1' }, phases: [], snapshotId: SNAPSHOT,
    evidenceHighWaterMark: 'e1', decisionHighWaterMark: 'd1', updatedAt: '2026-08-06T11:59:00.000Z', ...overrides,
  };
}

function detailFixture() {
  return {
    workspaceId: 'ws-a', specId: 'spec-a', title: 'Spec A', state: 'current', stale: false,
    plan: { id: 'plan-a', databaseId: '1', version: '1', specVersion: '7', schemaVersion: 'v1', compilerVersion: 'v1', policyVersion: 'v1', inputHash: SNAPSHOT, compiledAt: '2026-08-06T11:55:00.000Z' },
    provenance: {}, overallReadiness: { ready: false, status: 'in_progress', completionRate: 0.5, counts: {} },
    phaseTimeline: [
      { phaseId: 'intake', status: 'passed' },
      { phaseId: 'requirements', status: 'passed' },
      { phaseId: 'architecture', status: 'awaiting_approval' },
      { phaseId: 'implementation', status: 'not_started' },
    ],
    traceability: {}, currentRun: { id: 17, status: 'running', startedAt: '2026-08-06T11:58:00.000Z', finishedAt: null, queuePosition: null, triggerType: 'manual', agentType: 'pi', stories: { total: 1, passed: 0, failed: 0 }, liveness: { state: 'unknown' } },
    engineeringCanonCoverage: {}, evaluationSnapshot: { snapshotId: SNAPSHOT }, snapshotId: SNAPSHOT,
    evidenceHighWaterMark: 'e1', decisionHighWaterMark: 'd1',
  };
}

beforeEach(() => {
  portfolioMock.mockReset();
  queryMock.mockReset();
  queryMock.mockResolvedValue([]);
  lifecycleMock.mockReset();
  queryOneMock.mockReset();
});

test('attention ranking is deterministic, strict, bounded, and unknown liveness is not reported healthy', async () => {
  portfolioMock.mockResolvedValue({ items: [
    portfolioItem({ specId: 'info', currentPhaseId: 'implementation' }),
    portfolioItem({ specId: 'ready', currentPhaseId: 'qa' }),
    portfolioItem({ specId: 'blocked', blocked: true, overallStatus: 'blocked', blockers: [{ phaseId: 'qa', reason: 'Tests failed' }] }),
    portfolioItem({ specId: 'decision', phases: [{ status: 'awaiting_approval' }] }),
    portfolioItem({ specId: 'safety', risk: 'critical' }),
  ], total: 5 } as never);

  const result = await getWorkspaceAttention('ws-a', NOW);
  expect(result.items.map((item) => item.priority)).toEqual(['safety', 'decision', 'blocked', 'ready', 'informational']);
  expect(result.items.every((item) => ActionEnvelopeV1Schema.safeParse(item).success)).toBe(true);
  expect(result.items.find((item) => item.entity.id === 'info')?.state.liveness).toBe('unknown');
  expect(result.items.every((item) => item.permittedAction.kind === 'view')).toBe(true);
  expect(portfolioMock).toHaveBeenCalledWith(expect.objectContaining({
    workspaceId: 'ws-a',
    candidateSpecIds: [],
    pagination: expect.objectContaining({ limit: 300 }),
  }));
});

test('attention bounds lifecycle hydration before evaluation across 500 specs with stable ranking and constant queries', async () => {
  queryMock.mockResolvedValue(Array.from({ length: 500 }, (_, index) => ({ spec_slug: `spec-${String(index).padStart(3, '0')}` })));
  portfolioMock.mockImplementation(async (input) => {
    const selected = input.candidateSpecIds ?? [];
    const items = selected.map((specId, index) => {
      const bucket = index % 15;
      if (bucket === 0) return portfolioItem({ specId, risk: 'high' });
      if (bucket === 1) return portfolioItem({ specId, phases: [{ status: 'awaiting_approval' }] });
      if (bucket === 2) return portfolioItem({ specId, blocked: true, overallStatus: 'blocked' });
      if (bucket === 3) return portfolioItem({ specId, currentPhaseId: 'qa' });
      return portfolioItem({ specId });
    }).reverse();
    return { items, total: items.length } as never;
  });

  const result = await getWorkspaceAttention('ws-a', NOW);

  expect(portfolioMock).toHaveBeenCalledTimes(1);
  expect(portfolioMock).toHaveBeenCalledWith(expect.objectContaining({
    candidateSpecIds: Array.from({ length: 300 }, (_, index) => `spec-${String(index).padStart(3, '0')}`),
    pagination: expect.objectContaining({ limit: 300 }),
  }));
  expect(result.items).toHaveLength(100);
  expect(result.items.map((item) => item.priority)).toEqual([
    ...Array(20).fill('safety'),
    ...Array(20).fill('decision'),
    ...Array(20).fill('blocked'),
    ...Array(20).fill('ready'),
    ...Array(20).fill('informational'),
  ]);
  expect(result.items.map((item) => item.entity.id)).toEqual([
    ...[0, 1, 2, 3].flatMap((offset) =>
      Array.from({ length: 20 }, (_, index) => `spec-${String(offset + index * 15).padStart(3, '0')}`),
    ),
    ...Array.from({ length: 300 }, (_, index) => index)
      .filter((index) => index % 15 >= 4)
      .slice(0, 20)
      .map((index) => `spec-${String(index).padStart(3, '0')}`),
  ]);
  expect(result.items.every((item) => ActionEnvelopeV1Schema.safeParse(item).success)).toBe(true);
  expect(queryMock).toHaveBeenCalledTimes(1);
  expect(queryMock.mock.calls[0]?.[1]).toEqual(['ws-a', 300]);
  expect(queryOneMock).toHaveBeenCalledTimes(1);
});

test('attention composes DLQ, knowledge review, drift, and stale worker truth in one bounded workspace query', async () => {
  portfolioMock.mockResolvedValue({ items: [], total: 0 } as never);
  queryOneMock.mockResolvedValue({
    dlq_count: 2, dlq_oldest_at: '2026-08-06T11:00:00.000Z',
    knowledge_count: 3, knowledge_oldest_at: '2026-08-06T11:10:00.000Z',
    drift_score: 70, drift_violations: 4, drift_created_at: '2026-08-06T11:20:00.000Z',
    worker_last_seen: '2026-08-06T10:00:00.000Z',
  });
  const result = await getWorkspaceAttention('ws-a', NOW);
  expect(result.items.map((item) => item.entity.id)).toEqual(['webhook-dlq', 'workspace-drift', 'knowledge-review', 'worker-health']);
  expect(result.items.every((item) => ActionEnvelopeV1Schema.safeParse(item).success)).toBe(true);
  expect(result.items.find((item) => item.entity.id === 'worker-health')?.state.liveness).toBe('unknown');
  expect(queryOneMock).toHaveBeenCalledTimes(1);
  expect(queryOneMock.mock.calls[0]?.[1]).toEqual(['ws-a']);
});

test('attention preserves workspace isolation and empty/error states', async () => {
  portfolioMock.mockResolvedValue({ items: [], total: 0 } as never);
  await expect(getWorkspaceAttention('../other', NOW)).rejects.toBeInstanceOf(ValidationError);
  expect(portfolioMock).not.toHaveBeenCalled();
  await expect(getWorkspaceAttention('ws-a', NOW)).resolves.toEqual({ items: [], generatedAt: NOW.toISOString() });
  const missing = new NotFoundError('Workspace', 'ws-missing');
  portfolioMock.mockRejectedValueOnce(missing);
  await expect(getWorkspaceAttention('ws-missing', NOW)).rejects.toBe(missing);
});

test('delivery case binds exact spec revision and lifecycle snapshot without client-authorized actions', async () => {
  lifecycleMock.mockResolvedValue(detailFixture() as never);
  const result = await getDeliveryCaseSummary('ws-a', 'spec-a', NOW);
  expect(DeliveryCaseSummaryV1Schema.safeParse(result).success).toBe(true);
  expect(result.spec.revision).toEqual({ kind: 'spec_version', value: '7' });
  expect(result.mission.revision).toEqual({ kind: 'snapshot', value: SNAPSHOT });
  expect(result.review).toEqual({ state: 'in_review', requiredDecisions: 1, unresolvedDecisions: 1 });
  expect(result.actions).toEqual([expect.objectContaining({ priority: 'decision', permittedAction: expect.objectContaining({ kind: 'view', authority: 'user' }) })]);
  expect(lifecycleMock).toHaveBeenCalledWith({ workspaceId: 'ws-a', specId: 'spec-a' });
});

test('delivery case projects the live drift report instead of trusting persisted provenance', async () => {
  lifecycleMock.mockResolvedValue({
    ...detailFixture(),
    provenance: { sourceContext: { contextState: 'fresh', stale: false, bundleHash: SNAPSHOT, checkedAt: NOW.toISOString(), sources: [] } },
    sourceContext: {
      schemaVersion: 'rorca.source-drift-report.v1', bundleId: 'bundle-a', bundleHash: SNAPSHOT,
      contextState: 'stale', stale: true, checkedAt: NOW.toISOString(),
      sources: [{ sourceId: 'brief', kind: 'local_file', locator: 'brief.md', state: 'changed',
        oldHash: `sha256:${'b'.repeat(64)}`, newHash: `sha256:${'c'.repeat(64)}`,
        detail: 'Live content differs from the frozen hash; frozen content was not replaced.' }],
    },
  } as never);

  const result = await getDeliveryCaseSummary('ws-a', 'spec-a', NOW);

  expect(result.sourceContext).toEqual(expect.objectContaining({ contextState: 'stale', stale: true }));
  expect(result.sourceContext?.sources[0]).toEqual(expect.objectContaining({
    locator: 'brief.md', state: 'changed', oldHash: `sha256:${'b'.repeat(64)}`, newHash: `sha256:${'c'.repeat(64)}`,
  }));
  expect(result.sourceContext).not.toHaveProperty('schemaVersion');
  expect(result.sourceContext?.sources[0]).not.toHaveProperty('kind');
});

test('run control is strict, workspace scoped, bounded to one run query, and excludes raw logs', async () => {
  lifecycleMock.mockResolvedValue(detailFixture() as never);
  queryOneMock.mockResolvedValue({
    id: 17, spec_path: 'forge/specs/approved/spec-a.json', status: 'running', started_at: '2026-08-06T11:58:00.000Z', finished_at: null,
    agent: 'pi', agent_model: 'openai/gpt-5', total_input_tokens: 10, total_output_tokens: 4, total_cost_usd: 0.2, expected_story_ids: ['US-1'],
    stories: [{ story_id: 'US-1', status: 'retry', started_at: '2026-08-06T11:58:00.000Z', finished_at: null, model_used: 'openai/gpt-5', input_tokens: 10, output_tokens: 4, cost_usd: 0.2 }],
  });
  const result = await getRunControlProjection('ws-a', 'spec-a', '17', NOW);
  expect(RunControlProjectionV1Schema.safeParse(result).success).toBe(true);
  expect(result.spec.revision).toEqual({ kind: 'spec_version', value: '7' });
  expect(result.state.liveness).toBe('running');
  expect(result.costTokens.totalTokens).toBe(14);
  expect(result.permittedActions).toEqual([expect.objectContaining({ kind: 'view', authority: 'user' })]);
  expect(JSON.stringify(result)).not.toMatch(/log_path|terminal|rawLog/);
  expect(queryOneMock).toHaveBeenCalledTimes(1);
  expect(queryOneMock.mock.calls[0]?.[1]).toEqual([17, 'ws-a']);
});

test('run control reports unknown status as unknown and rejects cross-workspace or wrong-spec runs', async () => {
  lifecycleMock.mockResolvedValue(detailFixture() as never);
  queryOneMock.mockResolvedValueOnce({ id: 17, spec_path: 'forge/specs/approved/spec-a.json', status: 'mystery', started_at: NOW.toISOString(), finished_at: null, agent: null, agent_model: null, total_input_tokens: null, total_output_tokens: null, total_cost_usd: null, expected_story_ids: [], stories: [] });
  const unknown = await getRunControlProjection('ws-a', 'spec-a', '17', NOW);
  expect(unknown.state.liveness).toBe('unknown');
  expect(unknown.state.risk).toBe('unknown');

  queryOneMock.mockResolvedValueOnce(undefined);
  await expect(getRunControlProjection('ws-b', 'spec-a', '17', NOW)).rejects.toBeInstanceOf(NotFoundError);
  queryOneMock.mockResolvedValueOnce({ id: 17, spec_path: 'forge/specs/approved/other.json', status: 'done', started_at: NOW.toISOString(), finished_at: NOW.toISOString(), agent: null, agent_model: null, total_input_tokens: 0, total_output_tokens: 0, total_cost_usd: 0, expected_story_ids: [], stories: [] });
  await expect(getRunControlProjection('ws-a', 'spec-a', '17', NOW)).rejects.toBeInstanceOf(NotFoundError);
});
