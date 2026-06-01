/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
  onApiFetchError: vi.fn(() => () => {}),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => null),
  getRefreshToken: vi.fn(() => null),
}));

import { apiFetch } from '../../lib/apiFetch';
import BatchForge from '../BatchForge';

const mockApiFetch = vi.mocked(apiFetch);

class MockEventSource {
  url: string;
  onerror: ((this: EventSource, ev: Event) => any) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

describe('BatchForge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('rorca_workspaceId', 'ws-1');
    sessionStorage.setItem('rorca_workspaceId', 'ws-1');
    localStorage.setItem('rorca:forge:model', 'openai-codex/gpt-5.4');
    localStorage.setItem('rorca:reasoning:openai-codex/gpt-5.4', JSON.stringify({ enabled: true, effort: 'high' }));
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);

    mockApiFetch.mockImplementation(async (path, opts) => {
      if (path === '/api/workspaces') {
        return { items: [{ id: 'ws-1', label: 'Workspace One', path: '/tmp/ws-1', domains: [] }], total: 1, hasMore: false };
      }
      if (path === '/api/pipeline/runs?workspaceId=ws-1&limit=10') {
        return { items: [] };
      }
      if (path === '/api/workspaces/ws-1/pipeline-config') {
        return { config: {} };
      }
      if (path === '/api/specs/forge/batch' && opts?.method === 'POST') {
        return { batchId: 'batch-1', briefCount: 1 };
      }
      return {};
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('submits batch forge requests through the shared skill-first endpoint using saved forge preferences', async () => {
    renderWithProviders(<BatchForge />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/spec title/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/spec title/i), {
      target: { value: 'Codex Batch' },
    });
    fireEvent.change(screen.getByPlaceholderText(/describe what this spec builds/i), {
      target: { value: 'Create a batch-migrated forge flow' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate 1 spec/i }));

    await waitFor(() => {
      const forgeCall = mockApiFetch.mock.calls.find(([path, opts]) => path === '/api/specs/forge/batch' && opts?.method === 'POST');
      expect(forgeCall).toBeTruthy();
    });

    const forgeCall = mockApiFetch.mock.calls.find(([path, opts]) => path === '/api/specs/forge/batch' && opts?.method === 'POST');
    const body = JSON.parse(String(forgeCall?.[1]?.body));

    expect(body).toEqual({
      briefs: [
        expect.objectContaining({
          title: 'Codex Batch',
          brief: 'Create a batch-migrated forge flow',
          workspaceId: 'ws-1',
          model: 'openai-codex/gpt-5.4',
          reasoning: { enabled: true, effort: 'high' },
          postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
        }),
      ],
    });
    expect(body.briefs[0].agentOverride).toBeUndefined();
  });
});
