/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../lib/apiFetch';
import { retryRun, triggerPipeline } from '../pipeline';

const mockApiFetch = vi.mocked(apiFetch);

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('retryRun', () => {
  it('dispatches the exact governed preview without leaking frontend-only workspace scope', async () => {
    const preview = {
      previewHash: `sha256:${'a'.repeat(64)}`,
      requiresApproval: false,
      forceSequential: true,
      scope: {
        requested: [{ storyId: 'SPK-005', reasonCode: 'requested' }],
        requiredDependency: [], copiedPassed: [], skipped: [],
        executable: [{ storyId: 'SPK-005', reasonCode: 'failed' }],
        remaining: [], excluded: [],
      },
      options: { terminalMode: 'pty' },
    };
    const previewIdentity = {
      schemaVersion: 'retry-preview-identity.v1' as const,
      previewHash: preview.previewHash,
      originalRunId: 533,
      expiresAt: '2026-07-20T23:00:00.000Z',
      signature: `sha256:${'b'.repeat(64)}`,
    };
    mockApiFetch
      .mockResolvedValueOnce({ ok: true, preview, previewIdentity, worktreePreflight: null })
      .mockResolvedValueOnce({ ok: true, runId: 534, originalRunId: 533, retriedStories: [], copiedStories: [] });

    await retryRun(533, { storyIds: ['SPK-005'] });

    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse((mockApiFetch.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      storyIds: ['SPK-005'],
      safeMode: true,
    });
    expect(JSON.parse((mockApiFetch.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      storyIds: ['SPK-005'],
      safeMode: true,
      forceSequential: true,
      previewHash: preview.previewHash,
      approvedPreview: preview,
      previewIdentity,
    });
  });
});

describe('triggerPipeline', () => {
  it('omits terminal_mode when callers do not explicitly request a terminal mode', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, runId: 1 });

    await triggerPipeline({
      specPath: 'forge/specs/approved/example.json',
      workspaceId: 'ws-1',
    });

    const [, opts] = mockApiFetch.mock.calls[0];
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({
      specPath: 'forge/specs/approved/example.json',
      workspaceId: 'ws-1',
    });
  });

  it('sends terminal_mode=pty when a live terminal caller requests PTY mode', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, runId: 2, terminal_mode: 'pty' });

    await triggerPipeline({
      specPath: 'forge/specs/approved/example.json',
      workspaceId: 'ws-1',
      terminal_mode: 'pty',
    });

    const [path, opts] = mockApiFetch.mock.calls[0];
    expect(path).toBe('/api/pipeline/trigger');
    expect(opts).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse((opts as RequestInit).body as string)).toMatchObject({
      specPath: 'forge/specs/approved/example.json',
      workspaceId: 'ws-1',
      terminal_mode: 'pty',
    });
  });
});
