/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../lib/apiFetch';
import {
  getLifecycleEvidence,
  getLifecyclePhase,
  getLifecyclePortfolio,
  recordLifecycleDecision,
} from '../lifecycle';

vi.mock('../../lib/apiFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/apiFetch')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockApiFetch = vi.mocked(apiFetch);

describe('lifecycle API clients', () => {
  beforeEach(() => { mockApiFetch.mockReset(); });

  it('encodes workspace, filters, sort, and pagination through apiFetch', async () => {
    mockApiFetch.mockResolvedValue({});
    await getLifecyclePortfolio('workspace A', {
      sort: 'risk_desc',
      search: 'release proof',
      blocked: false,
      phase: 'production',
    }, { page: 3, limit: 50 });

    const [path] = mockApiFetch.mock.calls[0];
    const url = new URL(path, 'https://rorca.test');
    expect(url.pathname).toBe('/api/lifecycle');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      workspaceId: 'workspace A', search: 'release proof', blocked: 'false',
      phase: 'production', sort: 'risk_desc', page: '3', limit: '50',
    });
  });

  it('sends the selected snapshot and evidence page to phase detail', async () => {
    mockApiFetch.mockResolvedValue({});
    await getLifecyclePhase('ws-1', 'spec/a', 'qa', { page: 2, limit: 10 }, 'sha256:snapshot');

    const [path] = mockApiFetch.mock.calls[0];
    expect(path).toContain('/api/lifecycle/specs/spec%2Fa/phases/qa?');
    expect(path).toContain('snapshotId=sha256%3Asnapshot');
    expect(path).toContain('page=2');
  });

  it('pins evidence detail to the caller snapshot', async () => {
    mockApiFetch.mockResolvedValue({});
    await getLifecycleEvidence('ws-1', '7', 'sha256:pinned');

    const [path] = mockApiFetch.mock.calls[0];
    expect(path).toContain('/api/lifecycle/evidence/7?');
    expect(path).toContain('workspaceId=ws-1');
    expect(path).toContain('snapshotId=sha256%3Apinned');
  });

  it('preserves typed ApiError failures from mutations', async () => {
    const error = new ApiError(409, 'STALE_REVISION', 'Refresh required', { currentSnapshotId: 'new' });
    mockApiFetch.mockRejectedValue(error);

    let caught: unknown;
    try {
      await recordLifecycleDecision({
        workspaceId: 'ws-1',
        specSlug: 'spec-a',
        phaseId: 'qa',
        decisionType: 'qa_approval',
        rationale: 'Reviewed current evidence.',
      }, 'decision-key-123');
    } catch (failure) {
      caught = failure;
    }
    expect(caught).toBe(error);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('STALE_REVISION');

    expect(mockApiFetch).toHaveBeenCalledWith('/api/lifecycle/decisions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'Idempotency-Key': 'decision-key-123' }),
    }));
  });
});
