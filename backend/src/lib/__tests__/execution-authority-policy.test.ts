/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

jest.mock('../../db/execution-authority');
jest.mock('../../db/execution-authority-preflight');
jest.mock('../../db/index', () => ({ transaction: jest.fn() }));

import {
  appendAuthorityWalEvent,
  consumeAuthorityGrant,
  createAuthorityGrant,
  getAuthorityGrant,
  getAuthorityDecisionForRequest,
  getAuthorityGrantForRequest,
  getAuthorityRequest,
  getProviderBindingByReference,
  recordAuthorityDecision,
  transitionOperationIntent,
  type AuthorityDecisionRecord,
  type AuthorityGrantRecord,
  type AuthorityRequestRecord,
  type AuthorityRequestStatus,
  type ProviderBindingRecord,
} from '../../db/execution-authority';
import { getAuthorityRequestBindingHealth } from '../../db/execution-authority-preflight';
import { transaction } from '../../db/index';
import {
  consumeExactAuthorityGrant,
  decidePolicyAuthorityRequest,
  getPolicyAuthorityRequest,
  toAuthorityGrantProjection,
  toExecutionReceiptProjection,
} from '../execution-authority-policy';
import type { ExecutionReceiptRecord } from '../../db/execution-authority';

const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
const INTENT_ID = '10000000-0000-4000-8000-000000000002';
const DECISION_ID = '10000000-0000-4000-8000-000000000003';
const GRANT_ID = '10000000-0000-4000-8000-000000000004';
const BINDING_ID = '10000000-0000-4000-8000-000000000005';
const ATTEMPT_ID = '10000000-0000-4000-8000-000000000006';
const RECEIPT_ID = '10000000-0000-4000-8000-000000000007';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;
const CREATED_AT = new Date('2026-08-23T10:00:00.000Z');
const EXPIRES_AT = new Date('2026-08-23T12:00:00.000Z');
const SECRET_CANARY = 'provider-secret-canary-must-not-project';

function request(status: AuthorityRequestStatus = 'pending'): AuthorityRequestRecord {
  return {
    id: REQUEST_ID,
    schemaVersion: 'rorca.execution-authority.v1',
    workspaceId: 'workspace-1',
    intentId: INTENT_ID,
    runId: 42,
    storyId: 'REA-002',
    requestingPrincipal: 'execution:run-42:story-REA-002',
    capabilityId: 'github.repository.write',
    bindingReference: 'github-main',
    bindingGeneration: 3,
    environment: 'staging',
    providerResourceId: 'getrorca/rorca',
    operation: 'repository.push',
    constraints: { branch: 'run/rea-002' },
    evidenceDigest: OTHER_DIGEST,
    requestDigest: DIGEST,
    idempotencyKey: OTHER_DIGEST,
    status,
    maximumUses: 1,
    expiresAt: EXPIRES_AT,
    provenance: { source: 'test' },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    resolvedAt: status === 'pending' ? null : CREATED_AT,
  };
}

function binding(): ProviderBindingRecord {
  return {
    id: BINDING_ID,
    schemaVersion: 'rorca.execution-authority.v1',
    workspaceId: 'workspace-1',
    bindingReference: 'github-main',
    generation: 3,
    capabilityId: 'github.repository.write',
    provider: 'github',
    environment: 'staging',
    providerResourceId: 'getrorca/rorca',
    secretReference: `vault://${SECRET_CANARY}`,
    secretFingerprint: `sha256:${'c'.repeat(64)}`,
    status: 'active',
    configuration: {},
    provenance: { source: 'test' },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    revokedAt: null,
  };
}

function decision(): AuthorityDecisionRecord {
  return {
    id: DECISION_ID,
    schemaVersion: 'rorca.execution-authority.v1',
    workspaceId: 'workspace-1',
    requestId: REQUEST_ID,
    requestDigest: DIGEST,
    requestingPrincipal: 'execution:run-42:story-REA-002',
    operatorPrincipal: 'local-operator:local-admin',
    decision: 'approved',
    decisionDigest: OTHER_DIGEST,
    idempotencyKey: `sha256:${'d'.repeat(64)}`,
    reasonCode: 'scope_reviewed',
    provenance: { source: 'test' },
    createdAt: CREATED_AT,
  };
}

function grant(status: AuthorityGrantRecord['status'] = 'active'): AuthorityGrantRecord {
  return {
    id: GRANT_ID,
    schemaVersion: 'rorca.execution-authority.v1',
    workspaceId: 'workspace-1',
    requestId: REQUEST_ID,
    decisionId: DECISION_ID,
    requestDigest: DIGEST,
    runId: 42,
    storyId: 'REA-002',
    capabilityId: 'github.repository.write',
    bindingReference: 'github-main',
    bindingGeneration: 3,
    environment: 'staging',
    providerResourceId: 'getrorca/rorca',
    operation: 'repository.push',
    constraints: { branch: 'run/rea-002' },
    evidenceDigest: OTHER_DIGEST,
    secretReference: `vault://${SECRET_CANARY}`,
    secretFingerprint: `sha256:${'c'.repeat(64)}`,
    maximumUses: 1,
    usesConsumed: status === 'exhausted' ? 1 : 0,
    fencingGeneration: 1,
    status,
    idempotencyKey: `sha256:${'e'.repeat(64)}`,
    provenance: { source: 'test' },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    revokedAt: status === 'revoked' ? CREATED_AT : null,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(transaction).mockImplementation(async (operation) => operation({} as never));
  jest.mocked(getAuthorityRequest).mockResolvedValue(request());
  jest.mocked(getProviderBindingByReference).mockResolvedValue(binding());
  jest.mocked(recordAuthorityDecision).mockResolvedValue(decision());
  jest.mocked(createAuthorityGrant).mockResolvedValue(grant());
  jest.mocked(transitionOperationIntent).mockResolvedValue(true);
  jest.mocked(appendAuthorityWalEvent).mockResolvedValue();
  jest.mocked(getAuthorityDecisionForRequest).mockResolvedValue(null);
  jest.mocked(getAuthorityGrantForRequest).mockResolvedValue(null);
  jest.mocked(getAuthorityRequestBindingHealth).mockResolvedValue('healthy');
});

test('request detail projects the latest adapter binding health without provider material', async () => {
  const result = await getPolicyAuthorityRequest('workspace-1', REQUEST_ID);

  expect(result.bindingHealth).toBe('healthy');
  expect(result.request.requestDigest).toBe(DIGEST);
  expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
  expect(JSON.stringify(result)).not.toContain('secretReference');
});

test('exact approval records distinct principals, binds the whole request scope, and projects no provider secret', async () => {
  const result = await decidePolicyAuthorityRequest({
    workspaceId: 'workspace-1',
    requestId: REQUEST_ID,
    requestDigest: DIGEST,
    operatorPrincipal: 'local-operator:local-admin',
    decision: 'approved',
    reasonCode: 'scope_reviewed',
    idempotencyKey: SECRET_CANARY,
    now: new Date('2026-08-23T10:30:00.000Z'),
  });

  expect(recordAuthorityDecision).toHaveBeenCalledWith(expect.objectContaining({
    requestDigest: DIGEST,
    requestingPrincipal: 'execution:run-42:story-REA-002',
    operatorPrincipal: 'local-operator:local-admin',
    decision: 'approved',
  }));
  expect(createAuthorityGrant).toHaveBeenCalledWith(expect.objectContaining({
    workspaceId: 'workspace-1',
    runId: 42,
    storyId: 'REA-002',
    environment: 'staging',
    providerResourceId: 'getrorca/rorca',
    operation: 'repository.push',
    constraints: { branch: 'run/rea-002' },
    evidenceDigest: OTHER_DIGEST,
    maximumUses: 1,
    expiresAt: EXPIRES_AT,
  }));
  expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
  expect(JSON.stringify(result)).not.toContain('secretReference');
  expect(JSON.stringify(result)).not.toContain('secretFingerprint');
  expect(JSON.stringify(jest.mocked(appendAuthorityWalEvent).mock.calls)).not.toContain(SECRET_CANARY);
});

test('altered digest fails before a decision or grant is written', async () => {
  await expect(decidePolicyAuthorityRequest({
    workspaceId: 'workspace-1', requestId: REQUEST_ID, requestDigest: OTHER_DIGEST,
    operatorPrincipal: 'local-operator:local-admin', decision: 'approved',
    reasonCode: 'scope_reviewed', idempotencyKey: 'approval-1',
  })).rejects.toMatchObject({ code: 'AUTHORITY_REQUEST_ALTERED' });

  expect(recordAuthorityDecision).not.toHaveBeenCalled();
  expect(createAuthorityGrant).not.toHaveBeenCalled();
});

test.each([
  ['denied', 'AUTHORITY_REQUEST_DENIED'],
  ['cancelled', 'AUTHORITY_REQUEST_CANCELLED'],
  ['expired', 'AUTHORITY_REQUEST_EXPIRED'],
  ['approved', 'AUTHORITY_REQUEST_REPLAYED'],
] as const)('%s request returns its typed terminal failure without issuing a grant', async (status, code) => {
  jest.mocked(getAuthorityRequest).mockResolvedValue(request(status));

  await expect(decidePolicyAuthorityRequest({
    workspaceId: 'workspace-1', requestId: REQUEST_ID, requestDigest: DIGEST,
    operatorPrincipal: 'local-operator:local-admin', decision: 'approved',
    reasonCode: 'scope_reviewed', idempotencyKey: `approval-${status}`,
  })).rejects.toMatchObject({ code });

  expect(createAuthorityGrant).not.toHaveBeenCalled();
});

test.each([
  [{ status: 'exhausted' as const }, 'AUTHORITY_GRANT_OVER_USED'],
  [{ status: 'revoked' as const }, 'AUTHORITY_GRANT_REVOKED'],
  [{ status: 'expired' as const }, 'AUTHORITY_GRANT_EXPIRED'],
  [{ status: 'active' as const, fencingGeneration: 2 }, 'AUTHORITY_GRANT_REPLAYED'],
  [{ status: 'active' as const, workspaceId: 'workspace-2' }, 'AUTHORITY_GRANT_ALTERED'],
  [{ status: 'active' as const, runId: 43 }, 'AUTHORITY_GRANT_ALTERED'],
  [{ status: 'active' as const, storyId: 'REA-007-other' }, 'AUTHORITY_GRANT_ALTERED'],
  [{ status: 'active' as const, environment: 'production' }, 'AUTHORITY_GRANT_ALTERED'],
  [{ status: 'active' as const, providerResourceId: 'other/repository' }, 'AUTHORITY_GRANT_ALTERED'],
  [{ status: 'active' as const, operation: 'release.publish' }, 'AUTHORITY_GRANT_ALTERED'],
])('invalid or cross-scope exact grant returns a typed failure before grant consumption', async (change, code) => {
  jest.mocked(getAuthorityRequest).mockResolvedValue(request('approved'));
  jest.mocked(getAuthorityGrant).mockResolvedValue({ ...grant(change.status), ...change });

  await expect(consumeExactAuthorityGrant({
    workspaceId: 'workspace-1',
    grantId: GRANT_ID,
    requestDigest: DIGEST,
    scope: {
      workspaceId: 'workspace-1', runId: 42, storyId: 'REA-002', environment: 'staging',
      providerResourceId: 'getrorca/rorca', operation: 'repository.push',
    },
    fencingGeneration: 1,
    now: new Date('2026-08-23T10:30:00.000Z'),
  })).rejects.toMatchObject({ code });

  expect(consumeAuthorityGrant).not.toHaveBeenCalled();
});

test('revoked provider binding fails closed before an otherwise active exact grant is consumed', async () => {
  jest.mocked(getAuthorityRequest).mockResolvedValue(request('approved'));
  jest.mocked(getAuthorityGrant).mockResolvedValue(grant('active'));
  jest.mocked(getProviderBindingByReference).mockResolvedValue({
    ...binding(),
    status: 'revoked',
    revokedAt: CREATED_AT,
  });

  await expect(consumeExactAuthorityGrant({
    workspaceId: 'workspace-1',
    grantId: GRANT_ID,
    requestDigest: DIGEST,
    scope: {
      workspaceId: 'workspace-1', runId: 42, storyId: 'REA-002', environment: 'staging',
      providerResourceId: 'getrorca/rorca', operation: 'repository.push',
    },
    fencingGeneration: 1,
    now: new Date('2026-08-23T10:30:00.000Z'),
  })).rejects.toMatchObject({ code: 'AUTHORITY_BINDING_STALE' });

  expect(consumeAuthorityGrant).not.toHaveBeenCalled();
});

test('grant and receipt projections omit reference metadata and provider secret bytes', () => {
  const receipt: ExecutionReceiptRecord = {
    id: RECEIPT_ID,
    schemaVersion: 'rorca.execution-authority.v1',
    workspaceId: 'workspace-1',
    attemptId: ATTEMPT_ID,
    intentId: INTENT_ID,
    grantId: GRANT_ID,
    runId: 42,
    storyId: 'REA-002',
    environment: 'staging',
    providerResourceId: 'getrorca/rorca',
    operation: 'repository.push',
    requestDigest: DIGEST,
    receiptDigest: OTHER_DIGEST,
    idempotencyKey: `sha256:${'d'.repeat(64)}`,
    fencingGeneration: 1,
    outcome: 'succeeded',
    providerReceiptReference: 'provider-receipt-1',
    secretReference: `vault://${SECRET_CANARY}`,
    secretFingerprint: `sha256:${'c'.repeat(64)}`,
    redactedPayload: { result: 'accepted' },
    provenance: { source: 'test' },
    status: 'settled',
    retentionClass: 'standard',
    retainedUntil: null,
    createdAt: CREATED_AT,
    settledAt: CREATED_AT,
  };

  const json = JSON.stringify({ grant: toAuthorityGrantProjection(grant()), receipt: toExecutionReceiptProjection(receipt) });
  expect(json).not.toContain(SECRET_CANARY);
  expect(json).not.toContain('secretReference');
  expect(json).not.toContain('secretFingerprint');
  expect(json).not.toContain('idempotencyKey');
});
