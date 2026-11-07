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
import { retryRun, triggerPipeline, triggerReceiptRunId } from '../pipeline';

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

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const EXPIRES_AT = '2026-08-06T14:10:00.000Z';
const ACCEPTED_AT = '2026-08-06T14:01:00.000Z';

function executionPreview(scheduling: 'run' | 'queue' = 'run') {
  return {
    schemaVersion: 'rorca.execution-preview.v1' as const,
    previewHash: HASH_A,
    expiresAt: EXPIRES_AT,
    workspaceId: 'ws-1',
    spec: {
      schemaVersion: 'rorca.entity-ref.v1' as const,
      workspaceId: 'ws-1',
      kind: 'spec' as const,
      id: 'example',
      revision: { kind: 'spec_version' as const, value: '7' },
      label: 'Example',
    },
    specHash: HASH_B,
    effectiveOptions: {
      agent: 'codex',
      model: 'openai-codex/gpt-5.6-sol',
      effort: 'high' as const,
      mode: 'sequential' as const,
      parallelism: 1,
      storyIds: ['US-001'],
      worktree: { enabled: true },
      merge: { strategy: 'branch-only' as const, autoMerge: false },
    },
    scheduling,
  };
}

function executionReceipt(runId: number, scheduling: 'run' | 'queue' = 'run') {
  const preview = executionPreview(scheduling);
  return {
    schemaVersion: 'rorca.execution-receipt.v1' as const,
    workspaceId: preview.workspaceId,
    spec: preview.spec,
    specHash: preview.specHash,
    effectiveOptions: preview.effectiveOptions,
    scheduling,
    previewHash: preview.previewHash,
    idempotencyKey: 'mission-trigger:ws-1:stable-key',
    returnedEntity: {
      schemaVersion: 'rorca.entity-ref.v1' as const,
      workspaceId: 'ws-1',
      kind: 'run' as const,
      id: String(runId),
      label: scheduling === 'queue' ? `Queued run #${runId}` : `Run #${runId}`,
    },
    acceptedAt: ACCEPTED_AT,
  };
}

describe('triggerPipeline', () => {
  it('dispatches the exact preview with a stable caller idempotency header and parses the receipt', async () => {
    const preview = executionPreview();
    const receipt = executionReceipt(41);
    mockApiFetch.mockResolvedValue({ ok: true, runId: 999, position: 0, receipt });

    const response = await triggerPipeline({
      specPath: 'forge/specs/approved/example.json',
      workspaceId: 'ws-1',
      idempotencyKey: receipt.idempotencyKey,
      preview,
    });

    const [path, opts] = mockApiFetch.mock.calls[0];
    expect(path).toBe('/api/pipeline/trigger');
    expect(opts).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': receipt.idempotencyKey,
      },
    });
    expect(JSON.parse((opts as RequestInit).body as string)).toMatchObject({
      specPath: 'forge/specs/approved/example.json',
      workspaceId: 'ws-1',
      autoWorktree: true,
      autoMerge: false,
      mergeStrategy: 'branch-only',
      terminal_mode: 'ansi-html',
      idempotencyKey: receipt.idempotencyKey,
      previewHash: preview.previewHash,
      previewExpiresAt: preview.expiresAt,
    });
    expect(triggerReceiptRunId(response)).toBe(41);
  });

  it('preflights omitted preview options and dispatches the exact returned binding', async () => {
    const preview = executionPreview('queue');
    const receipt = executionReceipt(444, 'queue');
    mockApiFetch
      .mockResolvedValueOnce({ compatible: true, mismatchMode: 'warn', engine: 'codex', stories: [], preview })
      .mockResolvedValueOnce({ queued: true, runId: 444, position: 3, receipt });

    await triggerPipeline({
      specPath: 'forge/specs/approved/example.json',
      workspaceId: 'ws-1',
      idempotencyKey: receipt.idempotencyKey,
      autoWorktree: true,
      includeGraph: true,
      terminal_mode: 'pty',
      effortLevel: 'high',
      reasoning: { enabled: true, effort: 'high' },
      executionEnvironment: 'remote-rorca',
      queue: true,
    });

    expect(mockApiFetch.mock.calls[0][0]).toBe('/api/pipeline/preflight');
    expect(JSON.parse((mockApiFetch.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({
      queue: true,
      includeGraph: true,
      terminal_mode: 'pty',
      effortLevel: 'high',
      reasoning: { enabled: true, effort: 'high' },
    });
    expect(JSON.parse((mockApiFetch.mock.calls[1][1] as RequestInit).body as string)).toMatchObject({
      queue: true,
      previewHash: preview.previewHash,
      previewExpiresAt: preview.expiresAt,
    });
  });

  it('rejects an accepted dispatch that omits the strict receipt', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, runId: 1 });
    await expect(triggerPipeline({
      specPath: 'forge/specs/approved/example.json',
      workspaceId: 'ws-1',
      idempotencyKey: 'mission-trigger:ws-1:stable-key',
      preview: executionPreview(),
    })).rejects.toThrow();
  });
});

describe('triggerReceiptRunId', () => {
  it('uses the receipt identity instead of compatibility run fields', () => {
    expect(triggerReceiptRunId({
      ok: true,
      runId: 999,
      position: 0,
      receipt: executionReceipt(41),
    })).toBe(41);
    expect(triggerReceiptRunId({
      queued: true,
      runId: 998,
      position: 2,
      receipt: executionReceipt(42, 'queue'),
    })).toBe(42);
    expect(triggerReceiptRunId({ conflict: true, activeRunId: 43 })).toBe(43);
  });
});
