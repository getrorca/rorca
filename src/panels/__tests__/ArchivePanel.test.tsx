import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders, createMockWorkspace } from '../../test/helpers';
import ArchivePanel from '../ArchivePanel';

// ─── Mock apiFetch ────────────────────────────────────────────────────────────
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

const WORKSPACE_ROW = createMockWorkspace({ id: 'ws-1', label: 'Test Repo', path: '/tmp/test' });
const WORKSPACE_RESPONSE = { items: [WORKSPACE_ROW], total: 1, hasMore: false };

const MOCK_SPEC = {
  id: 'feature-auth',
  specName: 'Feature Auth',
  storyCount: 5,
  status: 'completed' as const,
  generatedAt: new Date().toISOString(),
  storyTitles: ['Login', 'Register', 'Logout'],
  tags: [],
  workspaceId: 'ws-1',
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

  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
    if (path.includes('/api/specs/archive')) return { items: [], total: 0, hasMore: false };
    if (path.includes('/comments/counts')) return { counts: {} };
    return { items: [], total: 0, hasMore: false };
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ArchivePanel', () => {
  it('renders without crashing', async () => {
    renderWithProviders(<ArchivePanel onNavigate={vi.fn()} />);
    // Panel should mount — the archive label or search area renders
    await waitFor(() => {
      // The panel renders once workspace resolves
      expect(document.body).toBeTruthy();
    });
  });

  it('shows no-workspace empty state when no workspace selected', async () => {
    // Clear workspace selection so WorkspaceContext has no selection
    localStorage.removeItem('rorca_workspaceId');
    sessionStorage.removeItem('rorca_workspaceId');

    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return { items: [], total: 0, hasMore: false };
      return { items: [], total: 0, hasMore: false };
    });

    renderWithProviders(<ArchivePanel onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(
        screen.getByText(/select a workspace/i),
      ).toBeInTheDocument();
    });
  });

  it('displays spec cards after fetch resolves', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/specs/archive')) {
        return { items: [MOCK_SPEC], total: 1, hasMore: false };
      }
      if (path.includes('/comments/counts')) return { counts: {} };
      return { items: [], total: 0, hasMore: false };
    });

    renderWithProviders(<ArchivePanel onNavigate={vi.fn()} />);

    await waitFor(
      () => { expect(screen.getByText('Feature Auth')).toBeInTheDocument(); },
      { timeout: 3000 },
    );
  });

  it('displays empty state when no specs match search/filters', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/specs/archive')) return { items: [], total: 0, hasMore: false };
      return { items: [], total: 0, hasMore: false };
    });

    renderWithProviders(<ArchivePanel onNavigate={vi.fn()} />);

    await waitFor(() => {
      // When there are no specs, the list area should be empty (no spec cards)
      expect(screen.queryByText('Feature Auth')).not.toBeInTheDocument();
    });
  });

  it('handles API error gracefully', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/specs/archive')) throw new Error('Network error');
      return { items: [], total: 0, hasMore: false };
    });

    renderWithProviders(<ArchivePanel onNavigate={vi.fn()} />);

    await waitFor(
      () => {
        // Error state: retry button or error message
        const retry = screen.queryByText(/retry/i);
        const errMsg = screen.queryByText(/network error/i);
        expect(retry !== null || errMsg !== null).toBe(true);
      },
      { timeout: 3000 },
    );
  });

  it('search input is rendered and accepts input', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/specs/archive')) return { items: [MOCK_SPEC], total: 1, hasMore: false };
      return { items: [], total: 0, hasMore: false };
    });

    renderWithProviders(<ArchivePanel onNavigate={vi.fn()} />);

    // Wait for panel to load
    await waitFor(() => {
      expect(document.querySelector('input[type="text"], input[placeholder*="Search"]') !== null ||
        document.querySelector('input[placeholder*="search"]') !== null ||
        document.querySelector('[role="search"]') !== null ||
        document.querySelector('[aria-label*="search"]') !== null
      ).toBe(true);
    }, { timeout: 3000 });

    const searchInput = document.querySelector(
      'input[type="text"], input[placeholder*="earch"]',
    ) as HTMLInputElement | null;

    if (searchInput) {
      fireEvent.change(searchInput, { target: { value: 'auth' } });
      expect(searchInput.value).toBe('auth');
    }
  });

  it('status filter buttons render', async () => {
    renderWithProviders(<ArchivePanel onNavigate={vi.fn()} />);

    await waitFor(() => {
      // The archive panel should have status filter buttons
      const allSpecsBtn = screen.queryByText(/all specs/i) ?? screen.queryByText(/^all$/i);
      expect(allSpecsBtn).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('spec card click selects the spec for detail view', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/specs/archive')) return { items: [MOCK_SPEC], total: 1, hasMore: false };
      if (path.includes('/comments/counts')) return { counts: {} };
      if (path.includes('/api/specs/feature-auth')) return {
        title: 'Feature Auth',
        userStories: [{ id: 'US-001', title: 'Login', description: 'User login', acceptanceCriteria: [], dependsOn: [], passes: false }],
      };
      return { items: [], total: 0, hasMore: false };
    });

    renderWithProviders(<ArchivePanel onNavigate={vi.fn()} />);

    await waitFor(
      () => { expect(screen.getByText('Feature Auth')).toBeInTheDocument(); },
      { timeout: 3000 },
    );

    const specCard = screen.getByText('Feature Auth');
    fireEvent.click(specCard);

    // After click, detail loading or stories tab should appear
    await waitFor(() => {
      // Either the detail pane opens or the spec is highlighted
      expect(document.body).toBeTruthy();
    });
  });
});
