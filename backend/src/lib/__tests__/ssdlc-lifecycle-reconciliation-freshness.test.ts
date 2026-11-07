/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockClientQuery = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../../db/index', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

import {
  digestLifecycleReconciliationState,
  type LifecycleReconciliationWatermarks,
} from '../lifecycle-reconciliation-watermarks';
import { getLifecyclePortfolio, getLifecycleReconciliationSnapshot } from '../ssdlc-lifecycle-read';
import { normalizeSsdlcContractJson } from '../ssdlc-contracts';
import { UNRELATED_RECONCILIATION_SPEC_IDS } from './fixtures/lifecycle-reconciliation-adversarial.fixtures';

const workspaceId = 'reconciliation-read-workspace';
const specId = 'spec-a';
const specDocument = { title: 'Spec A' };
let root: string;
const specRevisionHash = `sha256:${crypto.createHash('sha256')
  .update(normalizeSsdlcContractJson(specDocument)).digest('hex')}`;
const baseStates = {
  compiled_plan_state: {},
  evidence_state: { maximumId: null, rowCount: '0' },
  decision_state: [],
  run_state: [],
  mutation_state: {
    planMutations: [],
    decisionRevocations: [],
    effectiveStoryResults: [],
  },
};

function watermarks(states = baseStates): LifecycleReconciliationWatermarks {
  const databaseMutationState = digestLifecycleReconciliationState(states.mutation_state);
  return {
    compiledPlan: digestLifecycleReconciliationState(states.compiled_plan_state),
    evidence: digestLifecycleReconciliationState(states.evidence_state),
    decisions: digestLifecycleReconciliationState(states.decision_state),
    runs: digestLifecycleReconciliationState(states.run_state),
    mutationState: digestLifecycleReconciliationState({
      databaseMutationState,
      approvedSpecDocument: specDocument,
    }),
  };
}

function installReadModel(
  currentStates: Readonly<Record<string, unknown>> = baseStates,
  populateUnrelated = false,
  databaseCandidateContent: Record<string, unknown> = specDocument,
): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-reconciliation-read-'));
  const approved = path.join(root, 'forge', 'specs', 'approved');
  fs.mkdirSync(approved, { recursive: true });
  fs.writeFileSync(path.join(approved, `${specId}.json`), JSON.stringify(specDocument));

  const candidate = {
    spec_slug: specId,
    title: 'Spec A',
    spec_status: 'approved',
    generated_at: new Date('2026-08-12T00:00:00.000Z'),
    content_json: databaseCandidateContent,
    plan_db_id: null,
    spec_version: null,
    compiler_version: null,
    normalized_input_hash: null,
    plan_json: null,
    provenance_json: null,
    plan_created_at: null,
    plan_updated_at: null,
    plan_is_current: null,
    owner_id: null,
    owner_label: null,
  };
  const receipt = {
    spec_slug: specId,
    spec_revision_hash: specRevisionHash,
    compiled_plan_id: null,
    reconciliation_watermarks: watermarks(),
    result_hash: `sha256:${'9'.repeat(64)}`,
    delivery_status: 'completed',
    assurance_status: 'complete',
    unresolved_gaps: [],
    operator_attestation: null,
    created_at: new Date('2026-08-12T00:01:00.000Z'),
  };

  mockClientQuery.mockImplementation(async (sqlValue: string, params?: unknown[]) => {
    const sql = String(sqlValue);
    if (sql.includes('FROM workspaces')) return { rows: [{ id: workspaceId, path: root, label: 'Workspace' }] };
    if (sql.includes('WITH indexed AS')) {
      if (populateUnrelated && params?.[2] === null) {
        return {
          rows: UNRELATED_RECONCILIATION_SPEC_IDS.slice(0, 501).map((unrelatedSpecId) => ({
            ...candidate,
            spec_slug: unrelatedSpecId,
            title: unrelatedSpecId,
            content_json: { title: unrelatedSpecId },
          })),
        };
      }
      return { rows: [candidate] };
    }
    if (sql.includes('WITH exact_revisions')) return { rows: [receipt] };
    if (sql.includes('WITH requested AS')) return {
      rows: [{ spec_slug: specId, ...currentStates }],
    };
    if (sql.includes('COUNT(*)::int AS total') && sql.includes('FROM wal_events')) {
      return { rows: [{ total: 0 }] };
    }
    return { rows: [] };
  });
  mockTransaction.mockImplementation(async (
    callback: (client: { query: typeof mockClientQuery }) => Promise<unknown>,
  ) => callback({ query: mockClientQuery }));
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('projects an unchanged receipt as current delivery', async () => {
  installReadModel();
  const portfolio = await getLifecyclePortfolio({
    workspaceId,
    sort: 'current_view',
    pagination: { limit: 25, offset: 0, cursor: null, usedCursor: false },
  });

  expect(portfolio.items[0]).toMatchObject({
    delivery: { status: 'completed' },
    reconciliation: { assuranceStatus: 'complete', unresolvedGaps: [] },
  });
  expect(portfolio.kpis.deliveredSpecs).toBe(1);

  expect(mockClientQuery).toHaveBeenNthCalledWith(
    1,
    'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
  expect(mockClientQuery).toHaveBeenNthCalledWith(
    2,
    `SELECT set_config('rorca.workspace_id',$1,TRUE)`,
    [workspaceId],
  );
});

test('uses current canonical workspace bytes before stale database candidate content', async () => {
  installReadModel(baseStates, false, { title: 'Stale database candidate' });

  const portfolio = await getLifecyclePortfolio({
    workspaceId,
    sort: 'current_view',
    pagination: { limit: 25, offset: 0, cursor: null, usedCursor: false },
  });

  expect(portfolio.items[0]).toMatchObject({
    specId,
    delivery: { status: 'completed' },
  });
});

test.each([
  ['compiled plan', { ...baseStates, compiled_plan_state: { id: '42' } }],
  ['evidence', { ...baseStates, evidence_state: { maximumId: '1', rowCount: '1' } }],
  ['decision', { ...baseStates, decision_state: [{ id: '1' }] }],
  ['run', { ...baseStates, run_state: [{ id: 1, status: 'running' }] }],
  ['mutation/revocation', {
    ...baseStates,
    mutation_state: {
      ...baseStates.mutation_state,
      decisionRevocations: [['1', '2026-08-12T00:02:00.000Z']],
    },
  }],
] as const)('projects a complete receipt as stale and incomplete after the %s source advances', async (
  _source,
  currentStates,
) => {
  installReadModel(currentStates);
  const portfolio = await getLifecyclePortfolio({
    workspaceId,
    sort: 'current_view',
    pagination: { limit: 25, offset: 0, cursor: null, usedCursor: false },
  });

  expect(portfolio.items[0]).toMatchObject({
    delivery: { status: 'superseded' },
    reconciliation: {
      assuranceStatus: 'stale',
      unresolvedGaps: [expect.objectContaining({ code: 'RECONCILIATION_INPUTS_CHANGED' })],
    },
  });
  expect(portfolio.kpis.deliveredSpecs).toBe(0);
});


test('loads one exact spec without scanning more than 500 unrelated workspace candidates', async () => {
  installReadModel(baseStates, true);

  const snapshot = await getLifecycleReconciliationSnapshot(
    { workspaceId, specId },
    { query: mockClientQuery } as never,
  );

  expect(snapshot).toMatchObject({ state: 'needs_compilation', plan: null });
  const candidateRead = mockClientQuery.mock.calls.find(([sql]) => String(sql).includes('WITH indexed AS'));
  expect(candidateRead?.[1]?.[2]).toEqual([specId]);
});

test('returns an actionable typed error for a malformed exact canonical spec', async () => {
  installReadModel();
  fs.writeFileSync(path.join(root, 'forge', 'specs', 'approved', `${specId}.json`), '{\"title\":');

  await expect(getLifecycleReconciliationSnapshot(
    { workspaceId, specId },
    { query: mockClientQuery } as never,
  )).rejects.toEqual(expect.objectContaining({
    code: 'LIFECYCLE_SPEC_MALFORMED',
    statusCode: 422,
    details: expect.objectContaining({
      specId,
      remediation: expect.any(String),
    }),
  }));
});

test('fails closed with a typed bound error instead of truncating authoritative evidence', async () => {
  installReadModel();
  const baseImplementation = mockClientQuery.getMockImplementation()!;
  mockClientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (String(sql).includes('WITH source_rows AS')) {
      return {
        rows: Array.from({ length: 501 }, (_, index) => ({
          spec_slug: specId,
          id: String(index + 1),
          bounded_rank: index + 1,
        })),
      };
    }
    return baseImplementation(sql, params);
  });

  await expect(getLifecycleReconciliationSnapshot(
    { workspaceId, specId },
    { query: mockClientQuery } as never,
  )).rejects.toEqual(expect.objectContaining({
    code: 'CONFLICT',
    statusCode: 409,
    details: expect.objectContaining({
      type: 'lifecycle_evidence_bound_exceeded',
      specId,
      maximumEffectiveEvidence: 500,
      remediation: expect.any(String),
    }),
  }));
});