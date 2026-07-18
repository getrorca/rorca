/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import GitHubSettingsPanel from '../GitHubSettingsPanel';

vi.mock('../../components/AutonomousDeliverySettings', () => ({
  default: ({ connected }: { connected: boolean }) => (
    <div data-testid="autonomous-delivery-settings">Autonomous delivery {connected ? 'connected' : 'disconnected'}</div>
  ),
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

const WORKSPACE_ROW = { id: 'ws-1', label: 'My Repo', path: '/tmp/repo', domains: [] };
const WORKSPACE_RESPONSE = { items: [WORKSPACE_ROW], total: 1, hasMore: false };

const MOCK_GITHUB_STATUS = {
  connected: false,
};

const MOCK_GITHUB_ACCOUNT = {
  connected: false,
};

const MOCK_CONNECTED_STATUS = {
  connected: true,
  repoOwner: 'testorg',
  repoName: 'test-repo',
  webhookId: 12345,
  autoPr: {
    enabled: false,
    targetBranch: 'main',
    reviewers: [],
  },
};

const MOCK_CONNECTED_ACCOUNT = {
  username: 'testuser',
  avatarUrl: 'https://avatars.githubusercontent.com/u/123456?v=4',
  connected: true,
  scopes: ['repo', 'admin:repo_hook'],
};

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('rorca_workspaceId', 'ws-1');
  sessionStorage.setItem('rorca_workspaceId', 'ws-1');
});

function mockWorkspaceApi(overrides?: {
  status?: Record<string, unknown>;
  account?: Record<string, unknown>;
  workflowConfig?: Record<string, unknown> | null;
  app?: Record<string, unknown>;
  throwGithub?: boolean;
}) {
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
    if (path === '/api/workspaces/ws-1/github') {
      if (overrides?.throwGithub) throw new Error('GitHub API error');
      return overrides?.status ?? MOCK_GITHUB_STATUS;
    }
    if (path === '/api/workspaces/ws-1/github/account') {
      if (overrides?.throwGithub) throw new Error('GitHub API error');
      return overrides?.account ?? MOCK_GITHUB_ACCOUNT;
    }
    if (path === '/api/workspaces/ws-1/github/app') {
      if (overrides?.throwGithub) throw new Error('GitHub API error');
      return overrides?.app ?? { configured: false, registration: null, nextAction: 'Register the canonical GitHub App.' };
    }
    if (path === '/api/workspaces/ws-1/rorca-config') return { config: {} };
    if (path === '/api/workspaces/ws-1/github/workflow-config') {
      return { workflowConfig: overrides?.workflowConfig ?? null };
    }
    return {};
  });
}

describe('GitHubSettingsPanel', () => {
  it('renders without crashing', async () => {
    mockWorkspaceApi();

    renderWithProviders(<GitHubSettingsPanel />);

    await waitFor(() => {
      expect(document.body).toBeInTheDocument();
    });
  });

  it('shows disconnected state when not connected', async () => {
    mockWorkspaceApi();

    renderWithProviders(<GitHubSettingsPanel />);

    await waitFor(() => {
      expect(document.body.textContent).toContain('Workspace Repository');
      expect(document.body.textContent).toContain('Connect GitHub');
      expect(document.body.textContent).toContain('Rorca does not bundle ngrok/localtunnel');
      expect(document.body.textContent).toMatch(/stored locally and encrypted/i);
      expect(document.body.textContent).not.toContain('only used to create the webhook and is not stored');
    });
  });

  it('shows connected state when GitHub is connected', async () => {
    mockWorkspaceApi({
      status: MOCK_CONNECTED_STATUS,
      account: MOCK_CONNECTED_ACCOUNT,
    });

    renderWithProviders(<GitHubSettingsPanel />);

    await waitFor(() => {
      expect(document.body.textContent).toContain('testorg/test-repo');
      expect(document.body.textContent).toContain('@testuser');
      expect(document.body.textContent).toContain('Webhook management');
      expect(document.body.textContent).toContain('Ping webhook');
      expect(document.body.textContent).toContain('Preview latest run');
      expect(document.body.textContent).toContain('Autonomous delivery connected');
    });
  });

  it('shows exact App source, binding, capability diagnostics, and missing capability honestly', async () => {
    mockWorkspaceApi({
      status: { ...MOCK_CONNECTED_STATUS, credentialSource: 'github-app-installation', repositoryId: 99, installationId: 77 },
      account: { connected: true, username: 'rorca[bot]', source: 'github-app-installation' },
      app: {
        configured: true, connected: true, source: 'github-app-installation',
        app: { id: 12345, slug: 'rorca' },
        installation: { id: 77, accountId: 88, account: 'acme', type: 'Organization', status: 'active' },
        repository: { id: 99, owner: 'acme', name: 'widgets' },
        binding: { id: 'b1', status: 'active', lastValidatedAt: null, lastWebhookAt: null, validationErrorCode: null },
        capabilities: { repository: true, actions: true, pulls: true, contents: true, statuses: true, checks: false, webhooks: true },
        nextAction: null,
      },
    });
    renderWithProviders(<GitHubSettingsPanel />);
    await waitFor(() => {
      expect(document.body.textContent).toContain('GitHub App · rorca');
      expect(document.body.textContent).toContain('#77 · acme');
      expect(document.body.textContent).toContain('acme/widgets · #99');
      expect(document.body.textContent).toContain('Capability diagnostics');
      expect(document.body.textContent).toContain('checks');
      expect(document.body.textContent).toContain('PAT/OAuth remains an explicit fallback');
    });
  });

  it('handles API error gracefully', async () => {
    mockWorkspaceApi({ throwGithub: true });

    renderWithProviders(<GitHubSettingsPanel />);

    await waitFor(() => {
      expect(document.body).toBeInTheDocument();
    });
  });
});
