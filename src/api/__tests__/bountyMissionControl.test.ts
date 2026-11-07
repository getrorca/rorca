/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/apiFetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../../lib/apiFetch';
import { getBountyQualificationStatus, loadMissionControl, mutateMissionControl } from '../bountyMissionControl';

const mockApiFetch = vi.mocked(apiFetch);
const identity = {
  workspaceId: 'ws-1',
  programId: '11111111-1111-4111-8111-111111111111',
  missionId: '22222222-2222-4222-8222-222222222222',
};

beforeEach(() => {
  mockApiFetch.mockReset().mockImplementation(async (path: string) => {
    if (path.endsWith('/telemetry?workspaceId=ws-1')) return { dimensions: [] };
    if (path.includes('/events?')) return { events: [{ id: 'event-1', cursor: 1, eventType: 'redacted', payload: { password: 'raw-event-secret' }, sourceHash: 'sha256:event' }], nextCursor: 1, hasMore: false };
    if (path.includes('/evidence?')) return { items: [{ id: 'evidence-1', evidence_identity: 'safe-id', digest: 'sha256:evidence', payload: { authorization: 'raw-evidence-secret' } }] };
    if (path.includes('/drafts?')) return { items: [{ id: 'draft-1', bundle_hash: 'sha256:bundle', markdown_hash: 'sha256:markdown', json_hash: 'sha256:json', markdown_base64: 'raw-draft-secret' }] };
    if (path.includes('/work?') || path.includes('/findings?') || path.includes('/holds?')) return { items: [] };
    return {
      id: identity.missionId, programId: identity.programId, programName: 'Program', programRevision: 1,
      title: 'Mission', state: 'active', epoch: 1, contractHash: 'sha256:contract', scopeHash: 'sha256:scope',
      scopeExpiresAt: '2099-01-01T00:00:00.000Z', budgetRevision: null, budgetLimitCents: null,
      workTotal: 0, workActive: 0, evidenceTotal: 1, findingTotal: 0, draftTotal: 1, holdTotal: 0,
      createdAt: '2026-08-03T00:00:00.000Z', secret: 'raw-status-secret',
    };
  });
});

describe('bounty Mission Control API boundary', () => {
  it('reads qualification metadata through apiFetch without an enable mutation', async () => {
    mockApiFetch.mockResolvedValueOnce({ state: 'requalification-required', releaseEnableAvailable: false });
    await getBountyQualificationStatus();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/admin/bounty/qualification', { silent: true });
    expect(mockApiFetch.mock.calls[0][1]).not.toHaveProperty('method');
  });

  it('never requests raw projections and drops unallowlisted payload and secret fields', async () => {
    const result = await loadMissionControl(identity);
    const requestedPaths = mockApiFetch.mock.calls.map(([path]) => String(path));
    expect(requestedPaths).toHaveLength(8);
    expect(requestedPaths.every((path) => !path.includes('raw=true'))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/raw-event-secret|raw-evidence-secret|raw-draft-secret|raw-status-secret|password|authorization|markdown_base64/i);
    expect(result.evidence[0]).toEqual(expect.objectContaining({ evidenceIdentity: 'safe-id', digest: 'sha256:evidence' }));
    expect(result.sessions.events[0]).not.toHaveProperty('payload');
  });

  it('offers only exact Controller actions with no submission, schedule, target-tool, or capability mutation', async () => {
    mockApiFetch.mockResolvedValueOnce({ receiptId: 'receipt-1', replayed: false });
    await mutateMissionControl(identity, 'approve-readiness', { expectedEpoch: 1, reason: 'Local review only', draftId: 'draft-1' });
    const [path, options] = mockApiFetch.mock.calls[0];
    expect(path).toContain('/drafts/draft-1/release-review');
    expect(path).not.toMatch(/submit|schedule|capabilit|tool/i);
    expect(options?.body).toContain('approve-readiness');
    expect(options?.body).not.toMatch(/target|credential|secret/i);
  });
});
