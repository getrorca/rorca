/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import GitHubSettingsPanel from '../GitHubSettingsPanel';

vi.mock('../../components/AutonomousDeliverySettings', () => ({
  default: ({ connected }: { connected: boolean }) => (
    <div data-testid="autonomous-delivery-settings">Autonomous delivery {connected ? 'connected' : 'disconnected'}</div>
  ),
}));

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  apiFetchProviderMutation: vi.fn(),
  clearOperatorCapability: vi.fn(),
  hasOperatorCapability: vi.fn(() => true),
  onOperatorCapabilityLocked: vi.fn(() => () => {}),
  setOperatorCapability: vi.fn(),
  BASE_URL: 'http://localhost:3030',
  onApiFetchError: vi.fn(() => () => {}),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => null),
  getRefreshToken: vi.fn(() => null),
}));

import {
  apiFetch,
  apiFetchProviderMutation,
  hasOperatorCapability,
  setOperatorCapability,
} from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);
const mockProviderMutation = vi.mocked(apiFetchProviderMutation);
const mockHasOperatorCapability = vi.mocked(hasOperatorCapability);
const mockSetOperatorCapability = vi.mocked(setOperatorCapability);

const WORKSPACE_ROW = { id: 'ws-1', label: 'My Repo', path: '/tmp/repo', domains: [] };
const WORKSPACE_RESPONSE = { items: [WORKSPACE_ROW], total: 1, hasMore: false };

const MOCK_GITHUB_STATUS = {
  connected: false,
};

const MOCK_GITHUB_ACCOUNT = {
  connected: false,
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
  mockHasOperatorCapability.mockReturnValue(false);
  window.history.replaceState({}, '', '/');
  localStorage.setItem('rorca_workspaceId', 'ws-1');
  sessionStorage.setItem('rorca_workspaceId', 'ws-1');
});

function mockWorkspaceApi(overrides?: {
  status?: Record<string, unknown>;
  account?: Record<string, unknown>;
  workflowConfig?: Record<string, unknown> | null;
  app?: Record<string, unknown>;
  throwGithub?: boolean;
  onRequest?: (path: string, init?: RequestInit) => unknown | Promise<unknown>;
}) {
  const implementation = async (path: string, init?: RequestInit) => {
    const extra = await overrides?.onRequest?.(path, init);
    if (extra !== undefined) return extra;
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
  };
  mockApiFetch.mockImplementation(implementation);
  mockProviderMutation.mockImplementation(implementation);
}

async function unlockProviderChanges(capability = 'operator-preimage'): Promise<HTMLInputElement> {
  mockHasOperatorCapability.mockReturnValue(true);
  const input = await screen.findByLabelText('Local operator capability') as HTMLInputElement;
  fireEvent.change(input, { target: { value: capability } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock provider changes' }));
  return input;
}

describe('GitHubSettingsPanel', () => {
  it('renders without crashing', async () => {
    mockWorkspaceApi();

    renderWithProviders(<GitHubSettingsPanel />);

    await waitFor(() => {
      expect(document.body).toBeInTheDocument();
    });
  });

  it('keeps provider changes explicitly locked and never persists the entered preimage', async () => {
    mockWorkspaceApi();
    renderWithProviders(<GitHubSettingsPanel />);

    expect(await screen.findByText('Provider changes lock')).toBeInTheDocument();
    const input = await unlockProviderChanges('memory-only-preimage');
    expect(mockSetOperatorCapability).toHaveBeenCalledWith('memory-only-preimage');
    expect(screen.getByText('Unlocked for this visit')).toBeInTheDocument();
    expect(localStorage.getItem('memory-only-preimage')).toBeNull();
    expect(sessionStorage.getItem('memory-only-preimage')).toBeNull();
    expect(input.value).toBe('');
  });

  it('shows the unbound App-first state when no repository is qualified', async () => {
    mockWorkspaceApi();

    renderWithProviders(<GitHubSettingsPanel />);

    await waitFor(() => {
      expect(document.body.textContent).toContain('Repository binding');
      expect(document.body.textContent).toContain('Not bound');
      expect(document.body.textContent).toContain('Prepare App setup');
      expect(document.body.textContent).toContain('credential values never return to this page');
    });
  });

  it('shows the qualified repository and immutable binding actions', async () => {
    mockWorkspaceApi({
      app: {
        configured: true,
        connected: true,
        credentialReady: true,
        app: { id: 12345, slug: 'rorca' },
        installation: { id: 77, accountId: 88, account: 'acme', type: 'Organization', status: 'active' },
        repository: { id: 99, owner: 'testorg', name: 'test-repo' },
        webhookHealth: { configured: true, signedDeliveryObserved: true, lastWebhookAt: '2026-07-18T00:00:00.000Z' },
        capabilities: { repository: true, actions: true, pulls: true, contents: true, statuses: true, checks: true, webhooks: true },
        nextAction: null,
      },
    });

    renderWithProviders(<GitHubSettingsPanel />);

    await waitFor(() => {
      expect(document.body.textContent).toContain('testorg/test-repo');
      expect(document.body.textContent).toContain('Revalidate immutable binding');
      expect(document.body.textContent).toContain('Disable repository binding');
      expect(document.body.textContent).toContain('Preview latest run');
      expect(document.body.textContent).toContain('Autonomous delivery connected');
      expect(document.body.textContent).toContain('Repository-level Auto-PR and workflow-dispatch settings are retired');
    });
  });

  it('shows exact App identity, binding, capability diagnostics, and webhook evidence', async () => {
    mockWorkspaceApi({
      app: {
        configured: true, connected: true, credentialReady: true, source: 'github-app-installation',
        app: { id: 12345, slug: 'rorca' },
        installation: { id: 77, accountId: 88, account: 'acme', type: 'Organization', status: 'active' },
        repository: { id: 99, owner: 'acme', name: 'widgets' },
        binding: { id: 'b1', generation: 1, status: 'active', lastValidatedAt: null, lastWebhookAt: null, validationErrorCode: null },
        providerProfile: { verified: true, verifiedAt: '2026-07-18T00:00:00.000Z' },
        capabilityAvailability: { 'scm.repository.read': true, 'scm.branch.write': true, 'scm.pull_request.write': true, 'scm.checks.read': false, 'scm.review.request': true },
        webhookHealth: { configured: true, signedDeliveryObserved: false, lastWebhookAt: null },
        capabilities: { repository: true, actions: true, pulls: true, contents: true, statuses: true, checks: false, webhooks: true },
        nextAction: null,
      },
    });
    renderWithProviders(<GitHubSettingsPanel />);
    await waitFor(() => {
      expect(document.body.textContent).toContain('rorca · #12345');
      expect(document.body.textContent).toContain('#77 · acme/widgets · #99');
      expect(document.body.textContent).toContain('SCM capability availability');
      expect(document.body.textContent).toContain('checks');
      expect(document.body.textContent).toContain('Provider hook configured');
      expect(document.body.textContent).toContain('Awaiting signed delivery');
    });
  });

  it('posts the exact organization-owned manifest through the CSP-compatible form', async () => {
    const setup = {
      mode: 'manifest' as const,
      state: 'state-value',
      expiresAt: '2026-07-17T13:00:00.000Z',
      createUrl: 'https://github.com/organizations/acme/settings/apps/new?state=state-value',
      manifest: {
        name: 'Rorca',
        redirect_url: 'https://rorca.example/settings/github?github_app_setup=callback',
        default_permissions: { actions: 'read', contents: 'write' },
      },
      nextAction: 'Create the private App in acme.',
    };
    mockWorkspaceApi({
      onRequest: (path, init) => path.endsWith('/github/app/setup/start') && init?.method === 'POST' ? setup : undefined,
    });
    renderWithProviders(<GitHubSettingsPanel />);
    await unlockProviderChanges();

    fireEvent.click(await screen.findByRole('button', { name: 'Prepare App setup' }));
    const continueButton = await screen.findByRole('button', { name: 'Continue to GitHub' });
    const form = continueButton.closest('form');
    expect(form).toHaveAttribute('action', setup.createUrl);
    expect(form).toHaveAttribute('method', 'post');
    expect(form?.querySelector<HTMLInputElement>('input[name="manifest"]')?.value).toBe(JSON.stringify(setup.manifest));
  });

  it('exchanges a callback after reload and removes one-time query material', async () => {
    window.history.replaceState({}, '', '/settings/github?github_app_setup=callback&state=reload-safe-state&code=manifest-code');
    mockWorkspaceApi({
      onRequest: (path, init) => path.endsWith('/github/app/setup/exchange') && init?.method === 'POST'
        ? { registered: true, appId: 123, appSlug: 'rorca' }
        : undefined,
    });
    renderWithProviders(<GitHubSettingsPanel />);

    await unlockProviderChanges();
    fireEvent.click(await screen.findByRole('button', { name: 'Complete one-time App registration' }));
    await waitFor(() => {
      const call = mockProviderMutation.mock.calls.find(([path]) => path === '/api/workspaces/ws-1/github/app/setup/exchange');
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ state: 'reload-safe-state', code: 'manifest-code' });
      expect(window.location.search).toBe('');
    });
  });

  it('renders audited replacement controls and sends the replacement reason', async () => {
    mockWorkspaceApi({
      app: {
        configured: true, connected: false, source: 'github-app-installation',
        app: { id: 12345, slug: 'rorca' },
        installation: { id: 77, accountId: 88, account: 'acme', type: 'Organization', status: 'active' },
        repository: { id: 99, owner: 'acme', name: 'old-repo' },
        capabilities: { repository: false, actions: false, pulls: false, contents: false, statuses: false, checks: false, issues: false, webhooks: false },
        nextAction: 'Replace the invalid binding.',
      },
      onRequest: (path, init) => path.endsWith('/github/app/bind') && init?.method === 'POST' ? { bound: true, replaced: true } : undefined,
    });
    renderWithProviders(<GitHubSettingsPanel />);

    await unlockProviderChanges();
    fireEvent.change(await screen.findByLabelText('Installation ID'), { target: { value: '78' } });
    fireEvent.change(screen.getByLabelText('Repository ID'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'new-repo' } });
    fireEvent.change(screen.getByLabelText('Audited replacement reason'), { target: { value: 'installation moved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and audit-replace exact repository' }));

    await waitFor(() => {
      const call = mockProviderMutation.mock.calls.find(([path]) => path === '/api/workspaces/ws-1/github/app/bind');
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
        installationId: 78, repositoryId: 100, repoOwner: 'acme', repoName: 'new-repo', replacementReason: 'installation moved',
      });
    });
  });

  it('keeps binding disablement locked and refetches authority after the mutation', async () => {
    mockWorkspaceApi({
      app: {
        configured: true, connected: true, credentialReady: true, source: 'github-app-installation', app: { id: 1, slug: 'rorca' },
        installation: { id: 2, accountId: 3, account: 'acme', type: 'Organization', status: 'active' },
        repository: { id: 4, owner: 'acme', name: 'widgets' },
        webhookHealth: { configured: true, signedDeliveryObserved: true, lastWebhookAt: '2026-07-18T00:00:00.000Z' },
        capabilities: { repository: true, actions: true, pulls: true, contents: true, statuses: true, checks: true, webhooks: true },
        nextAction: null,
      },
      onRequest: (path, init) => path.endsWith('/github/app/disable') && init?.method === 'POST'
        ? { disabled: true }
        : undefined,
    });
    renderWithProviders(<GitHubSettingsPanel />);

    const disable = await screen.findByRole('button', { name: 'Disable repository binding' });
    expect(disable).toBeDisabled();
    await unlockProviderChanges();
    expect(disable).toBeEnabled();
    fireEvent.click(disable);

    await waitFor(() => {
      expect(mockProviderMutation).toHaveBeenCalledWith(
        '/api/workspaces/ws-1/github/app/disable',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(mockApiFetch.mock.calls.filter(([path]) => path === '/api/workspaces/ws-1/github/app').length).toBeGreaterThanOrEqual(2);
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
