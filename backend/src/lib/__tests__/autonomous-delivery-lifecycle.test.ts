/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';

const mockQueryOne = jest.fn();
const mockExecute = jest.fn();
const mockTransaction = jest.fn();
const mockPersistEvidence = jest.fn();
const mockGetLifecycleSpec = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

jest.mock('../ssdlc-evidence', () => ({
  ...jest.requireActual('../ssdlc-evidence'),
  persistCanonicalEvidence: (...args: unknown[]) => mockPersistEvidence(...args),
}));

jest.mock('../ssdlc-lifecycle-read', () => ({
  getLifecycleSpec: (...args: unknown[]) => mockGetLifecycleSpec(...args),
}));

import { bridgeGithubEvidenceToLifecycle } from '../autonomous-delivery-lifecycle';
import { compileLifecyclePlan } from '../ssdlc-plan-compiler';
import type { GithubPrDeliveryEvidence } from '../github-pr-delivery-evidence';

const workspaceId = 'ws-1';
const runId = 20260316000001;
const headSha = 'a'.repeat(40);
const policyId = '10000000-0000-4000-8000-000000000001';
const policyDigest = `sha256:${'d'.repeat(64)}`;

function plan() {
  const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../__tests__/fixtures/ssdlc/frontend-only.json'),
    'utf8',
  ));
  fixture.input.riskAssignments = [{
    workspaceId,
    assignmentId: 'risk-reviewed-delivery',
    scopeReference: fixture.input.canonicalSpec.json.userStories[0].id,
    risk: 'low',
    rationale: 'Explicit reviewed-delivery risk.',
  }];
  fixture.input.workspaceId = workspaceId;
  fixture.input.workspaceTags = [];
  fixture.input.ownerAssignments = [];
  fixture.input.policyAnnotations = [];
  fixture.input.canonicalSpec.specId = 'reviewed-delivery';
  return compileLifecyclePlan(fixture.input).plan;
}

function provider(overrides: Partial<GithubPrDeliveryEvidence> = {}): GithubPrDeliveryEvidence {
  return {
    schemaVersion: 'rorca.github-pr-delivery-evidence.v1',
    id: '20000000-0000-4000-8000-000000000002',
    workspaceId,
    runId,
    specSlug: 'reviewed-delivery',
    policy: { id: policyId, digest: policyDigest },
    repository: { owner: 'getrorca', name: 'rorca' },
    pullRequest: {
      number: 42, url: 'https://github.com/getrorca/rorca/pull/42', state: 'open', draft: false,
      merged: false, headRef: 'run/reviewed-delivery', baseRef: 'main', headSha,
      baseSha: 'b'.repeat(40), mergeCommitSha: null, mergeable: true, mergeableState: 'clean',
    },
    freshness: { comparisonStatus: 'ahead', aheadBy: 1, behindBy: 0, branchFresh: true },
    checks: [], checksTruncated: false, reviews: [], reviewsTruncated: false,
    checkSummary: {
      required: ['Backend Tests'], passing: ['Backend Tests'], pending: [], failing: [], missing: [],
      allRequiredPassed: true, policyAvailable: true, policyScopeMatches: true, truncated: false,
    },
    reviewSummary: {
      minimumApprovals: 1, currentApprovals: 1, approvedReviewers: ['release-owner'],
      requiredReviewers: ['release-owner'], missingRequiredReviewers: [], changesRequestedBy: [],
      requireCodeOwnerReview: false, codeOwnerReviewStatus: 'not_required', reviewSatisfied: true,
      policyAvailable: true, policyScopeMatches: true, truncated: false,
    },
    providerObservedAt: '2026-07-17T00:00:00.000Z',
    observedBy: { principalId: 'steward', displayLabel: 'Autonomous Delivery Steward' },
    payloadHash: `sha256:${'e'.repeat(64)}`,
    createdAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

function lifecycle(status = 'passed') {
  const phases = ['planning', 'requirements', 'design', 'development', 'testing', 'deployment', 'maintenance'];
  return {
    state: 'current',
    phaseTimeline: phases.map((phaseId) => ({
      phaseId,
      status: phaseId === 'deployment' ? status : 'passed',
      disposition: 'required',
      blocker: null,
    })),
    snapshotId: 'snapshot-1',
    evidenceHighWaterMark: 'evidence:102',
    decisionHighWaterMark: 'decision:103:1000',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  const compiled = plan();
  mockQueryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM github_pr_delivery_evidence')) return { id: provider().id };
    if (sql.includes('FROM pipeline_runs r')) return {
      spec_slug: 'reviewed-delivery',
      plan_db_id: '77',
      plan_json: compiled,
      provenance_json: { riskLevel: 'low', riskAssignmentCount: 1, profiles: ['code-change'] },
    };
    if (sql.includes('AS artifact_digest')) return { artifact_digest: `sha256:${'f'.repeat(64)}` };
    if (sql.includes("decision_type = 'deployment_approval'")) return undefined;
    throw new Error(`Unexpected query: ${sql}`);
  });
  let evidenceId = 100;
  mockPersistEvidence.mockImplementation(async (record: any) => ({
    evidence: { ...record, id: String(++evidenceId), createdAt: record.observedAt }, replayed: false,
  }));
  mockExecute.mockResolvedValue({ rowCount: 0 });
  mockTransaction.mockImplementation(async (fn: (client: any) => Promise<unknown>) => fn({
    query: jest.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('INSERT INTO ssdlc_decisions')) return { rows: [{ id: '103' }] };
      if (sql.includes('FROM autonomous_delivery_policies')) return { rows: [{ id: policyId }] };
      if (sql.includes("decision_type = 'policy_approval'")) return { rows: [] };
      if (sql.includes('UPDATE ssdlc_decisions')) return { rows: [] };
      if (sql.includes('INSERT INTO wal_events')) return { rows: [] };
      throw new Error(`Unexpected transaction query: ${sql}`);
    }),
  }));
  mockGetLifecycleSpec.mockResolvedValue(lifecycle());
});

test('projects exact provider facts into Validation and Merge and records distinct policy authority', async () => {
  const result = await bridgeGithubEvidenceToLifecycle({
    authority: { deliveryId: '30000000-0000-4000-8000-000000000003', workspaceId, runId, policyId, policyDigest, riskLevel: 'low' },
    evidence: provider(),
  });
  expect(result).toMatchObject({
    testingEvidenceId: '101',
    deploymentEvidenceId: '102',
    mergeDecisionId: '103',
    lifecycleReady: true,
    mergeGateStatus: 'passed',
    planApprovalRequirement: 'policy',
  });
  const records = mockPersistEvidence.mock.calls.map((call) => call[0]);
  expect(records).toEqual([
    expect.objectContaining({ classification: 'testing', status: 'passed', trustLevel: 'provider_verified' }),
    expect.objectContaining({ classification: 'approval', status: 'passed', trustLevel: 'provider_verified' }),
  ]);
  expect(records.map((record) => record.details.deliveryProjectionKind)).toEqual(['testing', 'deployment']);
  expect(records[1].details).toMatchObject({
    providerEvidenceId: provider().id,
    policyId,
    policyDigest,
    checksPassed: true,
    reviewsSatisfied: true,
  });
});

test('same-SHA regression produces warning evidence and revokes only policy authority', async () => {
  mockGetLifecycleSpec.mockResolvedValue(lifecycle('in_progress'));
  const failed = provider({
    checkSummary: {
      ...provider().checkSummary,
      passing: [], failing: ['Backend Tests'], allRequiredPassed: false,
    },
  });
  const result = await bridgeGithubEvidenceToLifecycle({
    authority: { deliveryId: '30000000-0000-4000-8000-000000000003', workspaceId, runId, policyId, policyDigest, riskLevel: 'low' },
    evidence: failed,
  });
  expect(result.mergeDecisionId).toBeNull();
  expect(mockPersistEvidence.mock.calls.map((call) => call[0].status)).toEqual(['unknown', 'unknown']);
  expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining("decision_type = 'policy_approval'"), expect.any(Array));
  expect(mockTransaction).not.toHaveBeenCalled();
});
