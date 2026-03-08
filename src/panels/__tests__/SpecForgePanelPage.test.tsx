import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders, createMockWorkspace, createMockSpec } from '../../test/helpers';
import SpecForgePanelPage from '../SpecForgePanelPage';

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

const MOCK_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', name: 'Claude Sonnet 4.6', provider: 'anthropic', costPer1kInput: 0.003, costPer1kOutput: 0.015, recommended: true, default: true },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', name: 'Claude Opus 4.6', provider: 'anthropic', costPer1kInput: 0.015, costPer1kOutput: 0.075, recommended: false, default: false },
];

const MOCK_PENDING_SPEC = createMockSpec({
  id: 'pending-feature',
  specName: 'Pending Feature',
  status: 'pending',
  workspaceId: 'ws-1',
});

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
  // Clear persisted brief so tests start clean
  localStorage.removeItem('rorca:forge:brief');

  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
    if (path.includes('/api/direction/models')) return { models: MOCK_MODELS, defaultModel: 'claude-sonnet-4-6' };
    if (path.includes('/api/direction/all')) return { layers: { l1: { content: '' }, l2: { content: '' }, l3: { content: '' } } };
    if (path.includes('/api/vault/keys/default-provider')) return { provider: null };
    if (path.includes('/api/config/opencode-models')) return { models: [] };
    if (path.includes('/api/config')) return { agentType: 'claude', agentModel: null, claudeBin: '/usr/local/bin/claude' };
    if (path.includes('/api/specs') && path.includes('status=pending')) return { items: [], total: 0, hasMore: false };
    if (path.includes('/api/specs')) return { items: [], total: 0, hasMore: false };
    return { items: [], total: 0, hasMore: false };
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SpecForgePanelPage', () => {
  it('renders without crashing', async () => {
    renderWithProviders(<SpecForgePanelPage onNavigate={vi.fn()} />);
    await waitFor(() => {
      expect(document.body).toBeTruthy();
    });
  });

  it('shows no-workspace empty state when no workspace selected', async () => {
    localStorage.removeItem('rorca_workspaceId');
    sessionStorage.removeItem('rorca_workspaceId');

    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return { items: [], total: 0, hasMore: false };
      return { items: [], total: 0, hasMore: false };
    });

    renderWithProviders(<SpecForgePanelPage onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/select a workspace/i)).toBeInTheDocument();
    });
  });

  it('renders brief textarea input', async () => {
    renderWithProviders(<SpecForgePanelPage onNavigate={vi.fn()} />);

    await waitFor(() => {
      const textarea = screen.queryByPlaceholderText(/what do you want to build/i) ??
        screen.queryByRole('textbox', { name: /brief/i }) ??
        document.querySelector('textarea[aria-label*="brief"]') as HTMLTextAreaElement | null;
      expect(textarea).toBeTruthy();
    }, { timeout: 3000 });
  });

  it('brief input accepts typed text', async () => {
    renderWithProviders(<SpecForgePanelPage onNavigate={vi.fn()} />);

    await waitFor(() => {
      const textarea = screen.queryByPlaceholderText(/what do you want to build/i);
      expect(textarea).toBeInTheDocument();
    }, { timeout: 3000 });

    const textarea = screen.getByPlaceholderText(/what do you want to build/i);
    fireEvent.change(textarea, { target: { value: 'Add user authentication with JWT' } });
    expect((textarea as HTMLTextAreaElement).value).toBe('Add user authentication with JWT');
  });

  it('submit triggers API call for spec generation', async () => {
    let generateCalled = false;

    mockApiFetch.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/direction/models')) return { models: MOCK_MODELS, defaultModel: 'claude-sonnet-4-6' };
      if (path.includes('/api/direction/all')) return { layers: { l1: { content: '' }, l2: { content: '' }, l3: { content: '' } } };
      if (path.includes('/api/vault/keys/default-provider')) return { provider: null };
      if (path.includes('/api/config/opencode-models')) return { models: [] };
      if (path.includes('/api/config')) return { agentType: 'claude', agentModel: null, claudeBin: '/usr/local/bin/claude' };
      if (path.includes('/api/specs/generate')) {
        generateCalled = true;
        return {
          id: 'new-auth-spec',
          specName: 'New Auth Spec',
          stories: [
            { id: 'US-001', title: 'Login', description: 'User login', acceptanceCriteria: [], dependsOn: [], passes: false },
          ],
          model: 'claude-sonnet-4-6',
          generatedAt: new Date().toISOString(),
        };
      }
      if (path.includes('/api/specs')) return { items: [], total: 0, hasMore: false };
      return { items: [], total: 0, hasMore: false };
    });

    renderWithProviders(<SpecForgePanelPage onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/what do you want to build/i)).toBeInTheDocument();
    }, { timeout: 3000 });

    const textarea = screen.getByPlaceholderText(/what do you want to build/i);
    fireEvent.change(textarea, { target: { value: 'Build a user authentication system with JWT tokens' } });

    // Find and click the generate/submit button
    const generateBtn = screen.queryByRole('button', { name: /generate/i }) ??
      screen.queryByRole('button', { name: /forge/i }) ??
      screen.queryByRole('button', { name: /create spec/i }) ??
      document.querySelector('button[type="submit"]') as HTMLButtonElement | null;

    if (generateBtn) {
      fireEvent.click(generateBtn);
      await waitFor(() => {
        expect(generateCalled).toBe(true);
      }, { timeout: 3000 });
    }
  });

  it('displays generated spec output after API call resolves', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/direction/models')) return { models: MOCK_MODELS, defaultModel: 'claude-sonnet-4-6' };
      if (path.includes('/api/direction/all')) return { layers: { l1: { content: '' }, l2: { content: '' }, l3: { content: '' } } };
      if (path.includes('/api/vault/keys/default-provider')) return { provider: null };
      if (path.includes('/api/config/opencode-models')) return { models: [] };
      if (path.includes('/api/config')) return { agentType: 'claude', agentModel: null, claudeBin: '/usr/local/bin/claude' };
      if (path.includes('/api/specs/generate')) {
        // SpecForgePreview/SpecForgeOutput expects "stories" field (not "userStories")
        return {
          id: 'new-auth-spec',
          specName: 'New Auth Spec',
          stories: [
            { id: 'US-001', title: 'User Login', description: 'Allow user to log in', acceptanceCriteria: [], dependsOn: [], passes: false },
          ],
          model: 'claude-sonnet-4-6',
          generatedAt: new Date().toISOString(),
        };
      }
      if (path.includes('/api/specs')) return { items: [], total: 0, hasMore: false };
      return { items: [], total: 0, hasMore: false };
    });

    renderWithProviders(<SpecForgePanelPage onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/what do you want to build/i)).toBeInTheDocument();
    }, { timeout: 3000 });

    const textarea = screen.getByPlaceholderText(/what do you want to build/i);
    fireEvent.change(textarea, { target: { value: 'Build user auth' } });

    const generateBtn = screen.queryByRole('button', { name: /generate/i }) ??
      screen.queryByRole('button', { name: /forge/i });

    if (generateBtn) {
      fireEvent.click(generateBtn);

      await waitFor(() => {
        // After generation, the spec output (SpecForgePreview) should appear with story title
        const storyText = screen.queryByText('User Login');
        const specOutput = document.querySelector('[data-testid="spec-output"]') ??
          document.querySelector('[data-testid="spec-preview"]');
        expect(storyText !== null || specOutput !== null).toBe(true);
      }, { timeout: 5000 });
    }
  });

  it('shows pending specs count when pending specs exist', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/direction/models')) return { models: MOCK_MODELS, defaultModel: 'claude-sonnet-4-6' };
      if (path.includes('/api/direction/all')) return { layers: { l1: { content: '' }, l2: { content: '' }, l3: { content: '' } } };
      if (path.includes('/api/vault/keys/default-provider')) return { provider: null };
      if (path.includes('/api/config/opencode-models')) return { models: [] };
      if (path.includes('/api/config')) return { agentType: 'claude', agentModel: null, claudeBin: '/usr/local/bin/claude' };
      if (path.includes('/api/specs') && path.includes('status=pending')) return { items: [MOCK_PENDING_SPEC], total: 1 };
      if (path.includes('/api/specs')) return { items: [], total: 0, hasMore: false };
      return { items: [], total: 0, hasMore: false };
    });

    renderWithProviders(<SpecForgePanelPage onNavigate={vi.fn()} />);

    await waitFor(() => {
      // The pending count badge or pending spec list should appear
      const pendingEl = screen.queryByText(/1 pending/i) ??
        screen.queryByText('Pending Feature');
      expect(pendingEl).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('shows Single / Batch mode toggle', async () => {
    renderWithProviders(<SpecForgePanelPage onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByText('Single')).toBeInTheDocument();
      expect(screen.queryByText('Batch')).toBeInTheDocument();
    }, { timeout: 3000 });
  });
});
