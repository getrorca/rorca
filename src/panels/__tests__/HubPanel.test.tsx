import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders, mockRouter, createMockRun, createMockSpec } from '../../test/helpers';
import HubPanel from '../HubPanel';

// ─── Mock apiFetch at module level ───────────────────────────────────────────
// Canonical pattern: mock the module, then re-import to get a typed mock ref.
// See BootstrapContextModal.test.tsx for the same pattern.

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

// Workspace row shape WorkspaceContext expects from /api/workspaces
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
  // Default: silence all API calls with minimal valid responses
  mockApiFetch.mockResolvedValue({ items: [], total: 0, hasMore: false });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('HubPanel', () => {
  /**
   * When no workspaces exist, HubPanel shows an empty state
   * with a CTA to add the first workspace.
   */
  it('shows the empty state when no workspace is selected', async () => {
    // WorkspaceContext calls /api/workspaces on mount — return empty list
    mockApiFetch.mockResolvedValue({ items: [], total: 0, hasMore: false });

    const router = mockRouter();
    renderWithProviders(<HubPanel onNavigate={router.onNavigate} />);

    await waitFor(() => {
      expect(screen.getByText('Connect your first repository')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Add Workspace/i })).toBeInTheDocument();
  });

  /**
   * When a workspace is selected and pending specs exist,
   * the Pending Reviews section is rendered.
   */
  it('renders the Pending Reviews section header when specs are awaiting review', async () => {
    const pendingSpec = createMockSpec({
      id: 'feature-auth',
      specName: 'Feature Auth',
      status: 'pending',
      workspaceId: 'ws-1',
    });

    // Seed workspaceId — must happen after beforeEach clears localStorage
    localStorage.setItem('rorca_workspaceId', 'ws-1');
    sessionStorage.setItem('rorca_workspaceId', 'ws-1');

    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      if (path.includes('status=pending')) return { items: [pendingSpec] };
      if (path.includes('status=approved')) return { items: [] };
      if (path.includes('/api/run-queue')) return { queue: [] };
      if (path.includes('/health')) return { score: 80, components: [], scannedAt: new Date().toISOString() };
      if (path.includes('/pipeline-config')) return { config: {} };
      // Default: silent no-op
      return { items: [], total: 0, hasMore: false };
    });

    const router = mockRouter();
    renderWithProviders(<HubPanel onNavigate={router.onNavigate} />);

    await waitFor(
      () => { expect(screen.getByText('Pending Reviews')).toBeInTheDocument(); },
      { timeout: 3000 },
    );
  });

  /**
   * When a workspace has completed runs,
   * the Recent Runs section is rendered.
   */
  it('renders the Recent Runs section with a completed run', async () => {
    const completedRun = createMockRun({
      id: 42,
      status: 'done',
      spec_path: 'forge/specs/approved/my-feature.json',
      workspace_id: 'ws-1',
    });

    localStorage.setItem('rorca_workspaceId', 'ws-1');
    sessionStorage.setItem('rorca_workspaceId', 'ws-1');

    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs')) return { items: [completedRun], total: 1, hasMore: false };
      if (path.includes('status=pending')) return { items: [] };
      if (path.includes('status=approved')) return { items: [] };
      if (path.includes('/api/run-queue')) return { queue: [] };
      if (path.includes('/health')) return { score: 80, components: [], scannedAt: new Date().toISOString() };
      if (path.includes('/pipeline-config')) return { config: {} };
      return { items: [], total: 0, hasMore: false };
    });

    const router = mockRouter();
    renderWithProviders(<HubPanel onNavigate={router.onNavigate} />);

    await waitFor(
      () => { expect(screen.getByText('Recent Runs')).toBeInTheDocument(); },
      { timeout: 3000 },
    );
  });
});
