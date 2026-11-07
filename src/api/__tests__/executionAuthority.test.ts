/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/apiFetch', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  apiFetch: vi.fn(),
  apiFetchAuthorityMutation: vi.fn(),
}));

import { apiFetch, apiFetchAuthorityMutation } from '../../lib/apiFetch';
import {
  AuthorityUiBoundaryError,
  assertAuthorityUiRedactedValue,
  getAuthorityRequestDetail,
  getExecutionAuthorityProfile,
  listAuthorityRequests,
  mutateAuthorityRequest,
  transitionExecutionAuthorityProfile,
} from '../executionAuthority';

const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
const INTENT_ID = '10000000-0000-4000-8000-000000000002';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const EVIDENCE_DIGEST = `sha256:${'b'.repeat(64)}`;

function request(workspaceId = 'workspace-1') {
  return {
    schemaVersion: 'rorca.execution-authority.v1',
    id: REQUEST_ID,
    intentId: INTENT_ID,
    workspaceId,
    runId: 42,
    storyId: 'REA-006',
    requestingPrincipal: 'execution:run:42',
    capabilityId: 'github.branch.write',
    bindingReference: 'binding://github/repository',
    bindingGeneration: 7,
    environment: 'staging',
    providerResourceId: 'repository:rorca/core',
    operation: 'create_branch',
    constraints: { branch: 'run/42', protected: false },
    evidenceDigest: EVIDENCE_DIGEST,
    requestDigest: DIGEST,
    status: 'pending',
    maximumUses: 1,
    expiresAt: '2099-08-24T12:00:00.000Z',
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-24T10:00:00.000Z',
    resolvedAt: null,
  };
}
function profile() {
  return {
    schemaVersion: 'rorca.execution-authority-profile.v1',
    policyVersion: 'rorca.execution-authority-rollout.v1',
    workspaceId: 'workspace-1',
    state: 'disabled',
    generation: 1,
    transitionPrincipal: 'system:migration',
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-24T10:00:00.000Z',
    enabledAt: null,
    disabledAt: '2026-08-24T10:00:00.000Z',
    readyToEnable: false,
    missingEvidenceKinds: ['migration', 'api', 'ui', 'crash_recovery', 'redaction', 'disposable_fixture_smoke'],
    evidence: [],
    evidenceHistoryCount: 0,
    mutationProviderAdapterIds: [],
  };
}


beforeEach(() => {
  vi.clearAllMocks();
});

describe('Execution Authority UI API boundary', () => {
  it('rejects credential-shaped fields and values before projection', () => {
    expect(() => assertAuthorityUiRedactedValue({ nested: { credential: 'opaque' } }))
      .toThrow(AuthorityUiBoundaryError);
    expect(() => assertAuthorityUiRedactedValue({ value: 'Bearer abcd1234' }))
      .toThrow(AuthorityUiBoundaryError);
    expect(() => assertAuthorityUiRedactedValue({ value: 'rea-006-secret-canary-value' }))
      .toThrow(AuthorityUiBoundaryError);
  });

  it('retains only requests owned by the selected workspace', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      items: [request('workspace-1'), { ...request('workspace-2'), id: '20000000-0000-4000-8000-000000000001' }],
      total: 2,
      hasMore: false,
    });

    const page = await listAuthorityRequests('workspace-1');

    expect(page.items).toHaveLength(1);
    expect(page.items[0].workspaceId).toBe('workspace-1');
    expect(page.total).toBe(1);
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/admin/execution-authority/workspaces/workspace-1/requests?limit=250',
      expect.objectContaining({ silent: true }),
    );
  });

  it('fails a detail response containing unsafe nested material', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      request: { ...request(), constraints: { access_token: 'not-admitted' } },
      decision: null,
      grant: null,
    });

    await expect(getAuthorityRequestDetail('workspace-1', REQUEST_ID))
      .rejects.toThrow(AuthorityUiBoundaryError);
  });

  it('sends only the exact digest and reason through the bounded authority mutation transport', async () => {
    vi.mocked(apiFetchAuthorityMutation).mockResolvedValue({ ok: true });

    await mutateAuthorityRequest({
      workspaceId: 'workspace-1',
      requestId: REQUEST_ID,
      requestDigest: DIGEST,
      action: 'approve',
      reasonCode: 'scope_reviewed',
    });

    expect(apiFetchAuthorityMutation).toHaveBeenCalledWith(
      `/api/admin/execution-authority/workspaces/workspace-1/requests/${REQUEST_ID}/approve`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ requestDigest: DIGEST, reasonCode: 'scope_reviewed' }),
      }),
    );
  });
  it('parses only the selected workspace rollout profile and rejects unsafe evidence', async () => {
    vi.mocked(apiFetch).mockResolvedValue(profile());
    const parsed = await getExecutionAuthorityProfile('workspace-1');
    expect(parsed.state).toBe('disabled');
    expect(parsed.mutationProviderAdapterIds).toEqual([]);

    vi.mocked(apiFetch).mockResolvedValue({
      ...profile(),
      evidence: [{
        id: 'evidence-1',
        schemaVersion: 'rorca.execution-authority-rollout-evidence.v1',
        evidenceKind: 'api',
        result: 'passed',
        artifactReference: 'fixture://rea-008/api',
        evidenceDigest: DIGEST,
        observedAt: '2026-08-24T10:00:00.000Z',
        operatorPrincipal: 'local-operator:admin',
        createdAt: '2026-08-24T10:00:00.000Z',
        access_token: 'not-admitted',
      }],
    });
    await expect(getExecutionAuthorityProfile('workspace-1')).rejects.toThrow(AuthorityUiBoundaryError);
  });

  it('fences profile transitions by generation through the operator transport', async () => {
    vi.mocked(apiFetchAuthorityMutation).mockResolvedValue({
      profile: {
        ...profile(),
        state: 'disabled',
        generation: 2,
      },
      revokedLeases: 1,
      receiptsPreserved: true,
      auditHistoryPreserved: true,
    });

    const result = await transitionExecutionAuthorityProfile({
      workspaceId: 'workspace-1',
      enabled: false,
      expectedGeneration: 1,
    });

    expect(result.generation).toBe(2);
    expect(apiFetchAuthorityMutation).toHaveBeenCalledWith(
      '/api/admin/execution-authority/workspaces/workspace-1/profile',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ enabled: false, expectedGeneration: 1 }),
      }),
    );
  });

});
