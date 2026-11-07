/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/apiFetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../../lib/apiFetch';
import {
  createLocalReviewBundle,
  deriveLocalReviewBundleIdempotencyKey,
  getDeliveryAdapters,
  getLocalReviewBundle,
  listLocalReviewBundles,
} from '../delivery';

const mockApiFetch = vi.mocked(apiFetch);

beforeEach(() => mockApiFetch.mockReset());

describe('provider-neutral delivery API', () => {
  it('uses apiFetch for the bounded adapter and bundle read models', async () => {
    mockApiFetch.mockResolvedValue({});
    await getDeliveryAdapters();
    await listLocalReviewBundles({ workspaceId: 'workspace one', runId: 42, limit: 5 });
    await getLocalReviewBundle('workspace one', 42, `lrb-${'a'.repeat(64)}`);

    expect(mockApiFetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/delivery/adapters',
      '/api/delivery/review-bundles?workspaceId=workspace+one&runId=42&limit=5',
      `/api/delivery/review-bundles/lrb-${'a'.repeat(64)}?workspaceId=workspace%20one&runId=42`,
    ]);
  });

  it('derives collision-safe idempotency from exact attempt, generation, and envelope identity', async () => {
    const identity = {
      workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', attempt: 2,
      generation: '22222222-2222-4222-8222-222222222222',
      hostAttemptEnvelopeId: '11111111-1111-4111-8111-111111111111',
    };
    const first = await deriveLocalReviewBundleIdempotencyKey(identity);
    const replay = await deriveLocalReviewBundleIdempotencyKey(identity);
    const nextAttempt = await deriveLocalReviewBundleIdempotencyKey({ ...identity, attempt: 3 });
    const nextGeneration = await deriveLocalReviewBundleIdempotencyKey({
      ...identity, generation: '33333333-3333-4333-8333-333333333333',
    });
    expect(first).toBe(replay);
    expect(first).toMatch(/^local-review:42:2:[0-9a-f]{64}$/);
    expect(new Set([first, nextAttempt, nextGeneration])).toHaveProperty('size', 3);
  });

  it('creates through the exact-attempt idempotency boundary without caller-authored outcomes', async () => {
    mockApiFetch.mockResolvedValue({});
    await createLocalReviewBundle({
      workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', attempt: 2,
      generation: '22222222-2222-4222-8222-222222222222',
      hostAttemptEnvelopeId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: 'local-review:42:abcdef12',
    });
    expect(mockApiFetch).toHaveBeenCalledWith('/api/delivery/review-bundles', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'local-review:42:abcdef12',
      },
      body: JSON.stringify({
        workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', attempt: 2,
        generation: '22222222-2222-4222-8222-222222222222',
        hostAttemptEnvelopeId: '11111111-1111-4111-8111-111111111111',
      }),
      signal: undefined,
    });
    const body = String((mockApiFetch.mock.calls[0][1] as RequestInit).body);
    expect(body).not.toMatch(/validation|pass|evidence|path|merge|deploy|credential|transcript/i);
  });
});
