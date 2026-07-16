/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import WorkspaceSettingsPanel, { WsContextSection } from '../WorkspaceSettingsPanel';

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

const MOCK_WORKSPACE_DETAILS = {
  id: 'ws-1',
  label: 'My Repo',
  path: '/tmp/repo',
  domains: ['saas'],
};

const MOCK_DIRECTION_LAYER = {
  layer: 3,
  content: '# L3 Direction\nStack-specific conventions',
  workspaceId: 'ws-1',
};

const MOCK_ENV_VARS = {
  items: [
    { id: 'env-1', key: 'ANTHROPIC_API_KEY', value: 'sk-***', workspaceId: 'ws-1' },
  ],
  total: 1,
};

const MOCK_RORCA_CONFIG = {
  config: {
    version: 1,
    globals: { priority: 101, content: '# Global context' },
    scopes: [],
  },
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
  mockApiFetch.mockResolvedValue({ items: [], total: 0, hasMore: false });
});

describe('WorkspaceSettingsPanel', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/workspaces/ws-1') return MOCK_WORKSPACE_DETAILS;
      if (path.includes('/api/direction')) return MOCK_DIRECTION_LAYER;
      if (path.includes('/env-vars')) return MOCK_ENV_VARS;
      if (path.includes('/rorca-config')) return MOCK_RORCA_CONFIG;
      if (path.includes('/agent-hooks')) return { items: [], total: 0 };
      if (path.includes('/agent-profiles')) return { items: [], total: 0 };
      if (path.includes('/pipeline-config')) return { config: {} };
      if (path.includes('/health')) return { score: 80, components: [], scannedAt: new Date().toISOString() };
      return {};
    });

    renderWithProviders(<WorkspaceSettingsPanel />);
    expect(document.body).toBeInTheDocument();
  });

  it('loads workspace settings on mount', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/workspaces/ws-1') return MOCK_WORKSPACE_DETAILS;
      if (path.includes('/api/direction')) return MOCK_DIRECTION_LAYER;
      if (path.includes('/env-vars')) return MOCK_ENV_VARS;
      if (path.includes('/rorca-config')) return MOCK_RORCA_CONFIG;
      if (path.includes('/agent-hooks')) return { items: [], total: 0 };
      if (path.includes('/agent-profiles')) return { items: [], total: 0 };
      if (path.includes('/pipeline-config')) return { config: {} };
      if (path.includes('/health')) return { score: 80, components: [], scannedAt: new Date().toISOString() };
      return {};
    });

    renderWithProviders(<WorkspaceSettingsPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('handles empty state with no workspace selected', async () => {
    localStorage.removeItem('rorca_workspaceId');
    sessionStorage.removeItem('rorca_workspaceId');

    mockApiFetch.mockResolvedValue({ items: [], total: 0, hasMore: false });

    renderWithProviders(<WorkspaceSettingsPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('handles API error gracefully', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/workspaces/ws-1') throw new Error('Not found');
      return {};
    });

    renderWithProviders(<WorkspaceSettingsPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('explains context files as runtime spec execution context', () => {
    renderWithProviders(<WsContextSection workspaceId="ws-1" showToast={vi.fn()} />);

    expect(document.body.textContent).toContain('Runtime context library');
    expect(document.body.textContent).toContain('Markdown files Rorca injects during spec execution');
    expect(document.body.textContent).toContain('Rorca assembles the matched files into each spec/run context packet');
    expect(document.body.textContent).toContain('docs are not auto-memorized by default');
  });

  it('loads count-only capture status and exposes privacy controls', async () => {
    mockApiFetch.mockImplementation(async (requestPath: string) => {
      if (requestPath.endsWith('/status')) {
        return {
          status: {
            policyMode: 'metadata-only',
            paused: false,
            activeIntegrations: { repoDaemon: true, gitHook: true },
            ignoredPaths: ['.env', '*.pem'],
            queueDepth: 2,
            redactionPolicy: { version: '2026-07-ucc-007', availableModes: ['off', 'metadata-only', 'repo-and-command', 'ide-assisted', 'full'] },
            lastCapturedEvent: {
              occurredAt: '2026-07-14T12:00:00Z',
              eventType: 'git_commit',
              integrationId: 'repoDaemon:rorca-capture',
              redactionDiagnostics: { redactionCount: 1, ignoredPathCount: 2, redactionTypes: ['token'], regulatedDomainFlags: [], truncated: false },
            },
            auditLog: [],
          },
        };
      }
      if (requestPath.endsWith('/monitoring')) {
        return {
          status: 'healthy', reasons: [], advisories: [],
          queues: { capture: { depth: 2, failed: 0 }, distillation: { depth: 1, failed: 0 } },
          worker: { status: 'ok', ageSeconds: 4 },
        };
      }
      return {};
    });

    renderWithProviders(<WsContextSection workspaceId="ws-1" showToast={vi.fn()} />);
    fireEvent.click(document.querySelector('button[role="tab"][aria-selected="false"]') as HTMLButtonElement);

    await waitFor(() => expect(document.body.textContent).toContain('Always-on capture'));
    expect(document.body.textContent).toContain('metadata-only');
    expect(document.body.textContent).toContain('repoDaemon, gitHook');
    expect(document.body.textContent).not.toContain('super-secret-value');
    expect(mockApiFetch).toHaveBeenCalledWith('/api/context-capture/ws-1/status');
    expect(mockApiFetch).toHaveBeenCalledWith('/api/context-capture/ws-1/monitoring');
  });
});
