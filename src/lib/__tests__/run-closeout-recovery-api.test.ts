/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../apiFetch', () => ({ apiFetch }));

import { fetchExactRunCloseoutPreview } from '../run-closeout-reconciliation';

describe('exact run closeout recovery API projection', () => {
  beforeEach(() => apiFetch.mockReset());

  it('uses apiFetch for one encoded read-only exact-run preview', async () => {
    const expected = {
      schemaVersion: 'rorca.run-closeout-reconciliation-preview.v1',
      eligible: true,
      canonicalTargetHash: `sha256:${'a'.repeat(64)}`,
      target: {
        runId: 20260316000550,
        workspaceId: 'workspace/one',
        specId: 'proof-spec',
        expiresAt: '2026-07-27T12:00:00.000Z',
        immutableAuthorityHash: `sha256:${'b'.repeat(64)}`,
      },
    };
    apiFetch.mockResolvedValueOnce(expected);

    await expect(fetchExactRunCloseoutPreview(20260316000550, 'workspace/one')).resolves.toBe(expected);
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/recovery/runs/20260316000550/closeout-reconciliation/preview?workspaceId=workspace%2Fone',
      { silent: true },
    );
  });

  it('does not add mutation options or infer success', async () => {
    apiFetch.mockRejectedValueOnce(new Error('WAVE_1_INTAKE_BLOCKED'));
    await expect(fetchExactRunCloseoutPreview(20260316000550, 'workspace'))
      .rejects.toThrow('WAVE_1_INTAKE_BLOCKED');
    // Silent: the Wave-1 guard makes 409 the expected answer for ordinary runs.
    expect(apiFetch.mock.calls[0]).toEqual([
      '/api/recovery/runs/20260316000550/closeout-reconciliation/preview?workspaceId=workspace',
      { silent: true },
    ]);
  });
});
