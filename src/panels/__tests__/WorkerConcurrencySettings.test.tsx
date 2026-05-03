/**
 * US-004: Worker concurrency Settings UI — Vitest unit tests
 *
 * Tests cover:
 *   (1) Component renders with fetched values from /api/settings/worker
 *   (2) User changes parallel run concurrency and saves
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
  onApiFetchError: vi.fn(() => () => {}),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => null),
  getRefreshToken: vi.fn(() => null),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: vi.fn(() => vi.fn()),
  useLocation: vi.fn(() => ({ pathname: '/settings/providers', search: '', hash: '', state: null })),
  useParams: vi.fn(() => ({})),
}));

vi.mock('../../hooks/useWalSSE', () => ({
  useWalSSE: vi.fn(() => []),
}));

// ─── Import mocked apiFetch ───────────────────────────────────────────────────

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

// ─── Import component under test ─────────────────────────────────────────────

import { WsPipelineSection } from '../WorkspaceSettingsPanel';

// ─── Shared mock data ─────────────────────────────────────────────────────────

const WORKSPACE_RESPONSE = {
  items: [{ id: 'ws-1', label: 'My Repo', path: '/tmp/repo', domains: [] }],
  total: 1,
  hasMore: false,
};

const MOCK_AGENT_CONFIG = {
  agentType: 'claude',
  agentModel: null,
  claudeBin: '/usr/local/bin/claude',
  opencodeBin: null,
  codexBin: null,
  piBin: null,
  opencodeInstalled: false,
  opencodeVersion: null,
  codexInstalled: false,
  codexVersion: null,
  piInstalled: false,
  piVersion: null,
};

const MOCK_OPENCODE_MODELS = {
  models: [],
  grouped: {},
  ollamaAvailable: false,
};

const MOCK_DIRECTION_MODELS = {
  models: [
    {
      id: 'claude-opus-4-6',
      label: 'Claude Opus 4.6',
      provider: 'anthropic',
      providerType: 'claude',
      costPer1kInput: 0.015,
      costPer1kOutput: 0.075,
      contextWindow: 200000,
      speedTier: 'medium',
      costTier: 'premium',
      recommended: true,
    },
  ],
};

const MOCK_ORCHESTRATION = {
  router: 'auto',
  thresholds: { haiku: [0, 40], sonnet: [40, 80], opus: [80, 100] },
  taskCascades: {
    echolocation: '', planning: '', coding: '', lintFix: '', testing: '', documentation: '',
  },
  escalation: { enabled: true, maxRetriesOnTier: 2, chain: ['haiku', 'sonnet', 'opus'], escalateTo: {} },
  tokenBudgetPerStory: 100000,
};

/**
 * Returns mock responses for all endpoints ProviderSettingsTab calls on mount.
 * The /api/settings/worker path must be matched BEFORE the generic /api/settings
 * catch-all, since the component hits both.
 *
 * SemanticEngineSection (a sub-component) independently fetches:
 *   /api/config/embedding-provider → must return { provider: null } not {}
 *   /api/admin/embed-all/status    → must return { embeddings: 0 } not {}
 * If those return {}, embedStatus.embeddingCount?.toLocaleString() throws.
 */
function buildApiMock(workerValue: number) {
  return async (path: string, init?: RequestInit): Promise<unknown> => {
    // Worker settings — must come before generic /api/settings match
    if (path === '/api/settings/worker') {
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body as string);
        return {
          queue_max_concurrent: body.queue_max_concurrent,
          run_now_max_concurrent: body.run_now_max_concurrent,
        };
      }
      return { queue_max_concurrent: 1, run_now_max_concurrent: workerValue };
    }
    if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
    if (path === '/api/workspaces/ws-1/pipeline-config') {
      return { config: { autoWorktree: true, storyTimeoutMin: 45, maxRetries: 0, mergeStrategy: 'direct' } };
    }
    if (path === '/api/config') return MOCK_AGENT_CONFIG;
    if (path.includes('/api/config/opencode-models')) return MOCK_OPENCODE_MODELS;
    if (path.includes('/api/config/embedding-provider')) return { provider: null };
    if (path.includes('/api/config/ollama')) return { available: false, models: [] };
    if (path.includes('/api/config/orchestration')) return MOCK_ORCHESTRATION;
    if (path.includes('/api/admin/embed-all')) return { embeddingCount: 0, specCount: 0, storyCount: 0, memoryCount: 0, running: false, processed: 0, queueDepth: 0 };
    if (path.includes('/api/vault/keys/providers')) return { providers: [] };
    if (path.includes('/api/vault/keys/default-provider')) return { provider: 'claude-cli' };
    if (path.includes('/api/vault/keys')) return { keys: [] };
    if (path.includes('/api/direction/models')) return MOCK_DIRECTION_MODELS;
    if (path.includes('/api/settings/display')) return { theme: 'dark', defaultModel: null };
    if (path.includes('/api/settings')) return { theme: 'dark', defaultModel: null, itemsPerPage: 20 };
    if (path.includes('/api/provider-defaults')) return { items: [] };
    return {};
  };
}

// ─── Silence noise ────────────────────────────────────────────────────────────

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WsPipelineSection — Worker Concurrency section', () => {
  it('renders parallel run concurrency with fetched value 4', async () => {
    mockApiFetch.mockImplementation(buildApiMock(4));

    renderWithProviders(<WsPipelineSection workspaceId="ws-1" showToast={vi.fn()} />);

    await waitFor(
      () => {
        const concurrencyInput = screen.getByLabelText(/parallel run concurrency/i) as HTMLInputElement;
        expect(Number(concurrencyInput.value)).toBe(4);
      },
      { timeout: 3000 },
    );
  });

  it('calls apiFetch PUT with run_now_max_concurrent: 7 when user changes value and saves', async () => {
    mockApiFetch.mockImplementation(buildApiMock(4));

    renderWithProviders(<WsPipelineSection workspaceId="ws-1" showToast={vi.fn()} />);

    await waitFor(
      () => {
        const concurrencyInput = screen.getByLabelText(/parallel run concurrency/i) as HTMLInputElement;
        expect(Number(concurrencyInput.value)).toBe(4);
      },
      { timeout: 3000 },
    );

    const concurrencyInput = screen.getByLabelText(/parallel run concurrency/i) as HTMLInputElement;
    fireEvent.change(concurrencyInput, { target: { value: '7' } });

    fireEvent.click(screen.getByRole('button', { name: /save worker settings/i }));

    await waitFor(() => {
      const putCalls = mockApiFetch.mock.calls.filter(
        ([path, init]) => path === '/api/settings/worker' && (init as RequestInit)?.method === 'PUT',
      );
      expect(putCalls.length).toBeGreaterThan(0);

      const lastPut = putCalls[putCalls.length - 1];
      const body = JSON.parse((lastPut[1] as RequestInit).body as string);
      expect(body.queue_max_concurrent).toBe(1);
      expect(body.run_now_max_concurrent).toBe(7);
    });
  });
});
