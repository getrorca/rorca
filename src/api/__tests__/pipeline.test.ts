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
import { triggerPipeline } from '../pipeline';

const mockApiFetch = vi.mocked(apiFetch);

beforeEach(() => {
  mockApiFetch.mockReset();
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
