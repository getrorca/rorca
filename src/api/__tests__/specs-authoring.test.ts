/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/apiFetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../../lib/apiFetch';
import {
  confirmSpecAuthoring,
  createSpec,
  getSpecGenerationContext,
  persistSpecBatch,
  preflightSpecAuthoring,
} from '../specs';

const mockApiFetch = vi.mocked(apiFetch);

beforeEach(() => {
  mockApiFetch.mockReset();
  mockApiFetch.mockResolvedValue({});
});

describe('shared spec authoring API adapters', () => {
  it('uses the same generation-context and preflight contract as Pi/MCP callers', async () => {
    await getSpecGenerationContext({ workspaceId: 'ws-1', brief: 'Ship safe login', title: 'Safe login' });
    expect(mockApiFetch.mock.calls[0][0]).toBe('/api/specs/generation-context');

    await preflightSpecAuthoring({
      workspaceId: 'ws-1',
      plannerInput: { schemaVersion: 1 },
      specs: [{ specReference: 'SPEC-1' }],
      attempt: 2,
      priorAttempts: [{ attempt: 1, accepted: false }],
      materialRevisions: ['Added recovery coverage.'],
      callerSurface: 'dashboard.spec-forge',
      model: 'test-model',
    });
    const [path, options] = mockApiFetch.mock.calls[1];
    expect(path).toBe('/api/specs/authoring/preflight');
    expect(JSON.parse((options as RequestInit).body as string)).toEqual({
      schemaVersion: 1,
      workspaceId: 'ws-1',
      plannerInput: { schemaVersion: 1 },
      specs: [{ specReference: 'SPEC-1' }],
      attempt: 2,
      priorAttempts: [{ attempt: 1, accepted: false }],
      materialRevisions: ['Added recovery coverage.'],
      callerSurface: 'dashboard.spec-forge',
      model: 'test-model',
    });
  });

  it('keeps confirmation separate and forwards accepted identity through one-or-batch persistence', async () => {
    await confirmSpecAuthoring({
      workspaceId: 'ws-1',
      acceptedPlanHash: `sha256:${'a'.repeat(64)}`,
      acceptedPreflightHash: `sha256:${'b'.repeat(64)}`,
      actorIdentity: 'user-1',
    });
    expect(mockApiFetch.mock.calls[0][0]).toBe('/api/specs/authoring/preflight/confirm');
    expect(JSON.parse((mockApiFetch.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({
      confirmed: true,
      actor: { type: 'human', identity: 'user-1' },
    });

    const authoringPreflight = { acceptedPlanHash: `sha256:${'a'.repeat(64)}`, preflightReceiptId: 12 };
    await createSpec({
      workspaceId: 'ws-1',
      title: 'Safe login',
      slug: 'safe-login',
      stories: [],
      authoringPreflight,
    });
    expect(mockApiFetch.mock.calls[1][0]).toBe('/api/specs/persist');
    expect(JSON.parse((mockApiFetch.mock.calls[1][1] as RequestInit).body as string).authoringPreflight)
      .toEqual(authoringPreflight);

    await persistSpecBatch({
      workspaceId: 'ws-1',
      authoringPreflight,
      drafts: [{ title: 'Contract', slug: 'contract' }, { title: 'Consumer', slug: 'consumer' }],
      idempotencyKey: 'plan-attempt-1',
    });
    expect(mockApiFetch.mock.calls[2][0]).toBe('/api/specs/persist/batch');
    expect(JSON.parse((mockApiFetch.mock.calls[2][1] as RequestInit).body as string)).toMatchObject({
      workspaceId: 'ws-1',
      authoringPreflight,
      idempotencyKey: 'plan-attempt-1',
    });
  });
});
