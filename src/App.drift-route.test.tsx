/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/apiFetch', () => {
  class ApiError extends Error {
    public readonly details: Record<string, unknown> = {};

    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  }
  return {
    apiFetch: vi.fn(),
    ApiError,
    BASE_URL: 'http://localhost:3030',
    onApiFetchError: vi.fn(() => () => {}),
    setTokens: vi.fn(),
    clearTokens: vi.fn(),
    getAccessToken: vi.fn(() => null),
    getRefreshToken: vi.fn(() => null),
  };
});

import { WorkspaceDriftRedirect } from './App';
import { WorkspaceProvider, useWorkspace } from './contexts/WorkspaceContext';
import { apiFetch } from './lib/apiFetch';

const mockApiFetch = vi.mocked(apiFetch);

function DestinationProbe() {
  const { workspaceId } = useWorkspace();
  const location = useLocation();
  return (
    <output aria-label="drift destination">
      {workspaceId}|{location.pathname}{location.search}
    </output>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.setItem('rorca_workspaceId', 'workspace-a');
  localStorage.setItem('rorca_workspaceId', 'workspace-a');
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/workspaces') {
      return {
        items: [
          { id: 'workspace-a', label: 'Workspace A', path: '/repo/a', domains: [] },
          { id: 'workspace-b', label: 'Workspace B', path: '/repo/b', domains: [] },
        ],
        total: 2,
        hasMore: false,
      };
    }
    if (path.startsWith('/api/pipeline/runs?')) return { items: [], total: 0, hasMore: false };
    if (path.endsWith('/pipeline-config')) return { config: {} };
    throw new Error(`Unexpected request: ${path}`);
  });
});

describe('workspace drift compatibility route', () => {
  it('activates the URL workspace before redirecting and preserves safe return context', async () => {
    render(
      <MemoryRouter
        initialEntries={[
          '/workspaces/workspace-b/drift?returnTo=%2Ftoday%3Ffocus%3Dmission-9&lens=drift',
        ]}
      >
        <WorkspaceProvider>
          <Routes>
            <Route path="/workspaces/:workspaceId/drift" element={<WorkspaceDriftRedirect />} />
            <Route path="/settings/direction" element={<DestinationProbe />} />
          </Routes>
        </WorkspaceProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(sessionStorage.getItem('rorca_workspaceId')).toBe('workspace-b'));

    expect(await screen.findByLabelText('drift destination')).toHaveTextContent(
      'workspace-b|/settings/direction?returnTo=%2Ftoday%3Ffocus%3Dmission-9&lens=drift',
    );
  });
});
