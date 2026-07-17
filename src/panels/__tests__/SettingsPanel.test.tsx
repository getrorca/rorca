/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';

const routerState = vi.hoisted(() => ({ params: {} as { tab?: string } }));

// ─── Mock react-router-dom (SettingsPanel uses useLocation + useNavigate) ─────
vi.mock('react-router-dom', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-router-dom')>(),
  useNavigate: vi.fn(() => vi.fn()),
  useLocation: vi.fn(() => ({ pathname: '/settings/general', search: '', hash: '', state: null })),
  useParams: vi.fn(() => routerState.params),
}));

vi.mock('../GitHubSettingsPanel', () => ({
  default: () => <div>GitHub integration and autonomous delivery</div>,
}));

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
const mockApiFetch = vi.mocked(apiFetch);

// Import SettingsPanel after mocks are set up
import SettingsPanel from '../SettingsPanel';

const WORKSPACE_ROW = { id: 'ws-1', label: 'My Repo', path: '/tmp/repo', domains: [] };
const WORKSPACE_RESPONSE = { items: [WORKSPACE_ROW], total: 1, hasMore: false };

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  routerState.params = {};
  localStorage.setItem('rorca_workspaceId', 'ws-1');
  sessionStorage.setItem('rorca_workspaceId', 'ws-1');
  mockApiFetch.mockResolvedValue({ items: [], total: 0, hasMore: false });
});

describe('SettingsPanel', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      return {};
    });

    renderWithProviders(<SettingsPanel />);
    expect(document.body).toBeInTheDocument();
  });

  it('routes the GitHub settings tab to integration and autonomous delivery controls', async () => {
    routerState.params = { tab: 'github' };
    renderWithProviders(<SettingsPanel />);

    await waitFor(() => {
      expect(document.body).toHaveTextContent('GitHub integration and autonomous delivery');
    });
  });

  it('renders settings content area', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      return {};
    });

    renderWithProviders(<SettingsPanel />);

    await waitFor(
      () => {
        const panel = document.querySelector('[aria-label="Settings"]');
        expect(panel).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});
