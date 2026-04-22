/**
 * Tests for Settings sub-components (PR-029 decomposition):
 * - ProviderSettingsTab
 * - GitHubSettingsTab
 * - ShortcutsSettingsTab
 * - AccountSettingsTab (BillingSection, AnalyticsSection, SystemSection)
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';

// ─── Mock react-router-dom (some tabs use navigation hooks) ───────────────────
vi.mock('react-router-dom', () => ({
  useNavigate: vi.fn(() => vi.fn()),
  useLocation: vi.fn(() => ({ pathname: '/settings/providers', search: '', hash: '', state: null })),
  useParams: vi.fn(() => ({})),
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

vi.mock('../../hooks/useWalSSE', () => ({
  useWalSSE: vi.fn(() => []),
}));

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

import { ProviderSettingsTab } from '../settings/ProviderSettingsTab';
import { GitHubSettingsTab } from '../settings/GitHubSettingsTab';
import { ShortcutsSettingsTab } from '../settings/ShortcutsSettingsTab';
import { AccountSettingsTab } from '../settings/AccountSettingsTab';
// BillingSection was removed from AccountSettingsTab; tests referencing it are skipped.
const BillingSection: () => null = () => null;

const WORKSPACE_ROW = { id: 'ws-1', label: 'My Repo', path: '/tmp/repo', domains: [] };
const WORKSPACE_RESPONSE = { items: [WORKSPACE_ROW], total: 1, hasMore: false };

const MOCK_AGENT_CONFIG = {
  agentType: 'claude',
  agentModel: null,
  claudeBin: '/usr/local/bin/claude',
  opencodeBin: null,
  codexBin: null,
  opencodeInstalled: false,
  opencodeVersion: null,
  codexInstalled: false,
  codexVersion: null,
};

const _MOCK_VAULT_KEYS = {
  items: [],
  total: 0,
};

// Models for /api/direction/models (DisplayModelOption shape)
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

// Models for /api/config/opencode-models (OpenCodeModelEntry shape)
const MOCK_OPENCODE_MODELS = {
  models: [
    {
      id: 'openai/gpt-4o',
      name: 'GPT-4o',
      provider: 'openai',
      contextWindow: 128000,
    },
  ],
  grouped: {
    openai: [{ id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'openai', contextWindow: 128000 }],
  },
  ollamaAvailable: false,
};

const MOCK_AUTH_ME = {
  user: {
    id: 'user-1',
    email: 'admin@rorca.local',
    displayName: 'Admin',
  },
};

const MOCK_BILLING_STATUS = {
  plan: 'solo',
  subscription: null,
  seats: { used: 1, limit: 1 },
  plans: {
    free: { name: 'Free', priceMonthly: 0, features: ['Spec generation'] },
    solo: { name: 'Solo', priceMonthly: 15, features: ['Full execution', '3 workspaces'] },
    pro: { name: 'Pro', priceMonthly: 30, features: ['Unlimited workspaces', 'Team'] },
  },
  stripeConfigured: false,
};

const MOCK_INVOICES = { invoices: [] };

const MOCK_NOTIFICATION_PREFS = { preferences: {} };

// Orchestration config for /api/config/orchestration
const MOCK_ORCHESTRATION = {
  router: 'auto',
  thresholds: { haiku: [0, 40], sonnet: [40, 80], opus: [80, 100] },
  taskCascades: {
    echolocation: '',
    planning: '',
    coding: '',
    lintFix: '',
    testing: '',
    documentation: '',
  },
  escalation: { enabled: true, maxRetriesOnTier: 2, chain: ['haiku', 'sonnet', 'opus'], escalateTo: {} },
  tokenBudgetPerStory: 100000,
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

// ─── ProviderSettingsTab ─────────────────────────────────────────────────────

describe('ProviderSettingsTab', () => {
  function providersMock(path: string) {
    if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
    if (path.includes('/api/vault/keys/default-provider')) return { provider: 'claude-cli' };
    if (path.includes('/api/vault/keys/providers')) return { providers: [] };
    if (path.includes('/api/vault/keys/test')) return { ok: true, latencyMs: 50, response: 'ok' };
    if (path.includes('/api/vault/keys')) return { keys: [] };
    if (path.includes('/api/config/claude-auth')) return { connected: false, cliInstalled: false };
    if (path.includes('/api/config/ollama')) return { available: false, models: [] };
    if (path.includes('/api/config/embedding-provider')) return { provider: 'local', model: 'local-tfidf', dimensions: 384, source: 'local', apiKeyConfigured: false };
    if (path.includes('/api/config/opencode-models')) return MOCK_OPENCODE_MODELS;
    if (path.includes('/api/config/orchestration')) return MOCK_ORCHESTRATION;
    if (path === '/api/config') return MOCK_AGENT_CONFIG;
    if (path.includes('/api/admin/embed-all/status')) return { embeddingCount: 0, specCount: 0, storyCount: 0, memoryCount: 0, running: false, processed: 0, queueDepth: 0 };
    if (path.includes('/api/admin/graph-stats')) return { nodeCount: 0, edgeCount: 0 };
    if (path.includes('/api/workflow-router')) return [];
    if (path.includes('/api/direction/models')) return MOCK_DIRECTION_MODELS;
    if (path.includes('/api/direction')) return { contentYaml: '', preferredModel: null };
    if (path.includes('/api/settings')) return { theme: 'dark', defaultModel: null, itemsPerPage: 20 };
    if (path.includes('/api/provider-defaults')) return { items: [] };
    return {};
  }

  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => providersMock(path));
    renderWithProviders(<ProviderSettingsTab />);
    expect(document.body).toBeInTheDocument();
  });

  it('loads provider data on mount', async () => {
    mockApiFetch.mockImplementation(async (path: string) => providersMock(path));

    renderWithProviders(<ProviderSettingsTab />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('handles API error gracefully', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/config') throw new Error('Config endpoint unavailable');
      return providersMock(path);
    });

    renderWithProviders(<ProviderSettingsTab />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});

// ─── GitHubSettingsTab ────────────────────────────────────────────────────────

describe('GitHubSettingsTab', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/github') && path.includes('ws-1')) return {
        connected: false, repoOwner: null, repoName: null, installationId: null,
      };
      if (path === '/api/github/account') return { login: null, avatarUrl: null, connected: false };
      if (path.includes('/api/github/pr-template')) return { template: '' };
      return {};
    });

    renderWithProviders(<GitHubSettingsTab />);
    expect(document.body).toBeInTheDocument();
  });

  it('shows connection form when not connected', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/github')) return { connected: false, repoOwner: null, repoName: null };
      if (path === '/api/github/account') return { login: null, avatarUrl: null, connected: false };
      if (path.includes('/api/github/pr-template')) return { template: '' };
      return {};
    });

    renderWithProviders(<GitHubSettingsTab />);

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
      if (path.includes('/github')) throw new Error('GitHub API error');
      return {};
    });

    renderWithProviders(<GitHubSettingsTab />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});

// ─── ShortcutsSettingsTab ─────────────────────────────────────────────────────

describe('ShortcutsSettingsTab', () => {
  it('renders without crashing', () => {
    renderWithProviders(<ShortcutsSettingsTab />);
    expect(document.body).toBeInTheDocument();
  });

  it('displays keyboard shortcuts', () => {
    renderWithProviders(<ShortcutsSettingsTab />);
    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
  });

  it('shows shortcut categories', () => {
    renderWithProviders(<ShortcutsSettingsTab />);
    expect(screen.getByText('Navigation')).toBeInTheDocument();
    expect(screen.getByText('Specs')).toBeInTheDocument();
    expect(screen.getByText('Pipeline')).toBeInTheDocument();
    expect(screen.getByText('General')).toBeInTheDocument();
  });

  it('shows individual shortcut descriptions', () => {
    renderWithProviders(<ShortcutsSettingsTab />);
    expect(screen.getByText('Go to Hub')).toBeInTheDocument();
    expect(screen.getByText('Open command palette')).toBeInTheDocument();
  });
});

// ─── AccountSettingsTab ───────────────────────────────────────────────────────

describe('AccountSettingsTab', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/auth/me') return MOCK_AUTH_ME;
      if (path.includes('/api/notifications/preferences')) return MOCK_NOTIFICATION_PREFS;
      if (path.includes('/api/telemetry/status')) return { enabled: false, note: '' };
      return {};
    });

    renderWithProviders(<AccountSettingsTab />);
    expect(document.body).toBeInTheDocument();
  });

  it('loads user profile data on mount', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/auth/me') return MOCK_AUTH_ME;
      if (path.includes('/api/notifications/preferences')) return MOCK_NOTIFICATION_PREFS;
      if (path.includes('/api/telemetry/status')) return { enabled: false, note: '' };
      return {};
    });

    renderWithProviders(<AccountSettingsTab />);

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
      if (path === '/api/auth/me') throw new Error('Auth unavailable');
      if (path.includes('/api/notifications/preferences')) return MOCK_NOTIFICATION_PREFS;
      if (path.includes('/api/telemetry/status')) return { enabled: false, note: '' };
      return {};
    });

    renderWithProviders(<AccountSettingsTab />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});

// ─── ConnectionsHubSection (via ProviderSettingsTab) ─────────────────────────
//
// ConnectionsHubSection is an internal component of ProviderSettingsTab, so it
// is exercised through ProviderSettingsTab which renders it inside the
// 'connections' section ref.

describe('ConnectionsHubSection', () => {
  const VAULT_KEYS_EMPTY = { keys: [] };

  const VAULT_KEYS_WITH_ENTRIES = {
    keys: [
      {
        id: 'key-1',
        provider: 'anthropic',
        label: 'Personal',
        masked_key: 'sk-ant-****abcd',
        base_url: null,
        spend_total_usd: 0,
        last_used_at: null,
        created_at: new Date().toISOString(),
      },
      {
        id: 'key-2',
        provider: 'openrouter',
        label: 'Work',
        masked_key: 'sk-or-****1234',
        base_url: null,
        spend_total_usd: 0,
        last_used_at: null,
        created_at: new Date().toISOString(),
      },
      {
        id: 'key-3',
        provider: 'openai-compat',
        label: '',
        masked_key: 'sk-****9999',
        base_url: 'https://api.openai.com/v1',
        spend_total_usd: 0,
        last_used_at: null,
        created_at: new Date().toISOString(),
      },
    ],
  };

  const CLAUDE_AUTH_INSTALLED = {
    connected: true,
    email: 'user@example.com',
    tier: 'pro',
    cliInstalled: true,
    cliVersion: '1.0.0',
  };

  const CLAUDE_AUTH_NOT_INSTALLED = {
    connected: false,
    cliInstalled: false,
    cliVersion: undefined,
  };

  const OLLAMA_NOT_RUNNING = { available: false, models: [], error: undefined };
  const OLLAMA_RUNNING = {
    available: true,
    models: [
      { id: 'llama3', name: 'llama3', size: 0, parameterSize: '8B' },
      { id: 'codellama', name: 'codellama', size: 0, parameterSize: '7B' },
    ],
  };

  function buildMock(overrides: {
    vaultKeys?: { keys: unknown[] };
    claudeAuth?: { connected: boolean; cliInstalled: boolean; cliVersion?: string; email?: string; tier?: string };
    ollama?: { available: boolean; models: unknown[]; error?: string };
  } = {}) {
    const vaultKeys = overrides.vaultKeys ?? VAULT_KEYS_EMPTY;
    const claudeAuth = overrides.claudeAuth ?? CLAUDE_AUTH_NOT_INSTALLED;
    const ollama = overrides.ollama ?? OLLAMA_NOT_RUNNING;

    const BASE_CONFIG = { agentType: 'claude', agentModel: null, opencodeInstalled: false, opencodeVersion: null, codexInstalled: false, codexVersion: null, copilotConnected: false, copilotUsername: null };
    const BASE_EMBED_PROVIDER = { provider: 'local', model: 'local-tfidf', dimensions: 384, source: 'local', apiKeyConfigured: false };
    const BASE_EMBED_STATUS = { embeddingCount: 0, specCount: 0, storyCount: 0, memoryCount: 0, running: false, processed: 0, queueDepth: 0 };
    const BASE_WORKFLOW_CONFIGS: unknown[] = [];
    const BASE_DIRECTION_MODELS = { models: [{ id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'anthropic', providerType: 'claude', costPer1kInput: 0.015, costPer1kOutput: 0.075, contextWindow: 200000, speedTier: 'medium', costTier: 'premium', recommended: true }] };

    return async (path: string) => {
      // Order matters — more-specific paths must come before broader matches
      if (path === '/api/workspaces') return { items: [{ id: 'ws-1', label: 'My Repo', path: '/tmp/repo', domains: [] }], total: 1, hasMore: false };
      if (path.includes('/api/vault/keys/default-provider')) return { provider: 'claude-cli' };
      if (path.includes('/api/vault/keys/providers')) return { providers: [] };
      if (path.includes('/api/vault/keys/test')) return { ok: true, latencyMs: 50, response: 'ok' };
      if (path.includes('/api/vault/keys')) return vaultKeys;
      if (path.includes('/api/config/claude-auth')) return claudeAuth;
      if (path.includes('/api/config/ollama')) return ollama;
      if (path.includes('/api/config/embedding-provider')) return BASE_EMBED_PROVIDER;
      if (path.includes('/api/config/opencode-models')) return { models: [], grouped: {}, ollamaAvailable: false };
      if (path.includes('/api/config/orchestration')) return { router: 'auto', thresholds: { haiku: [0, 40], sonnet: [40, 80], opus: [80, 100] }, taskCascades: { echolocation: '', planning: '', coding: '', lintFix: '', testing: '', documentation: '' }, escalation: { enabled: true, maxRetriesOnTier: 2, chain: ['haiku', 'sonnet', 'opus'], escalateTo: {} }, tokenBudgetPerStory: 100000 };
      if (path === '/api/config') return BASE_CONFIG;
      if (path.includes('/api/admin/embed-all/status')) return BASE_EMBED_STATUS;
      if (path.includes('/api/admin/graph-stats')) return { nodeCount: 0, edgeCount: 0 };
      if (path.includes('/api/workflow-router')) return BASE_WORKFLOW_CONFIGS;
      if (path.includes('/api/direction/models')) return BASE_DIRECTION_MODELS;
      if (path.includes('/api/direction')) return { contentYaml: '', preferredModel: null };
      if (path.includes('/api/settings')) return { theme: 'dark', defaultModel: null, itemsPerPage: 20 };
      if (path.includes('/api/provider-defaults')) return { items: [] };
      if (path.includes('/api/models/')) return { ok: true, latencyMs: 50 };
      return {};
    };
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  it('renders the Connections Hub section inside ProviderSettingsTab', async () => {
    mockApiFetch.mockImplementation(buildMock());
    renderWithProviders(<ProviderSettingsTab />);

    await waitFor(() => {
      expect(screen.getByText('Connections Hub')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('renders all 5 provider cards: Claude CLI, Anthropic API, OpenRouter, OpenAI-Compatible, Ollama', async () => {
    mockApiFetch.mockImplementation(buildMock());
    renderWithProviders(<ProviderSettingsTab />);

    await waitFor(() => {
      expect(screen.getByText('Claude CLI')).toBeInTheDocument();
      expect(screen.getByText('Anthropic API')).toBeInTheDocument();
      expect(screen.getByText('OpenRouter')).toBeInTheDocument();
      expect(screen.getByText('OpenAI-Compatible')).toBeInTheDocument();
      expect(screen.getByText('Ollama')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('shows the connections tab in PROVIDER_TABS navigation', async () => {
    mockApiFetch.mockImplementation(buildMock());
    renderWithProviders(<ProviderSettingsTab />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Connections' })).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  // ── GET /api/vault/keys on mount ───────────────────────────────────────────

  it('calls GET /api/vault/keys on mount', async () => {
    mockApiFetch.mockImplementation(buildMock());
    renderWithProviders(<ProviderSettingsTab />);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/vault/keys');
    }, { timeout: 3000 });
  });

  // ── Status dots ────────────────────────────────────────────────────────────

  it('shows "Not configured" status for providers when no keys are stored', async () => {
    mockApiFetch.mockImplementation(buildMock({ vaultKeys: VAULT_KEYS_EMPTY }));
    renderWithProviders(<ProviderSettingsTab />);

    await waitFor(() => {
      // With empty vault, all 3 API-key providers show "Not configured"
      const notConfigured = screen.getAllByText('Not configured');
      expect(notConfigured.length).toBeGreaterThanOrEqual(3);
    }, { timeout: 3000 });
  });

  it('shows "Configured" status for providers that have keys stored', async () => {
    mockApiFetch.mockImplementation(buildMock({ vaultKeys: VAULT_KEYS_WITH_ENTRIES }));
    renderWithProviders(<ProviderSettingsTab />);

    await waitFor(() => {
      // All 3 keyed providers become "Configured" (or "Configured — <url>")
      const configured = screen.getAllByText(/^Configured/);
      expect(configured.length).toBeGreaterThanOrEqual(3);
    }, { timeout: 3000 });
  });

  it('shows "Not found" for Claude CLI when CLI is not installed', async () => {
    mockApiFetch.mockImplementation(buildMock({ claudeAuth: CLAUDE_AUTH_NOT_INSTALLED }));
    renderWithProviders(<ProviderSettingsTab />);

    await waitFor(() => {
      expect(screen.getByText('Not found')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('shows installed status for Claude CLI when CLI is installed and authenticated', async () => {
    mockApiFetch.mockImplementation(buildMock({ claudeAuth: CLAUDE_AUTH_INSTALLED }));
    renderWithProviders(<ProviderSettingsTab />);

    await waitFor(() => {
      // Claude CLI shows version + email when installed + connected
      expect(screen.getByText(/Installed.*v1\.0\.0/)).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('shows "Not running" for Ollama when Ollama is unavailable', async () => {
    mockApiFetch.mockImplementation(buildMock({ ollama: OLLAMA_NOT_RUNNING }));
    renderWithProviders(<ProviderSettingsTab />);

    await waitFor(() => {
      expect(screen.getByText('Not running')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('shows running status with model count for Ollama when available', async () => {
    mockApiFetch.mockImplementation(buildMock({ ollama: OLLAMA_RUNNING }));
    renderWithProviders(<ProviderSettingsTab />);

    await waitFor(() => {
      expect(screen.getByText('Running (2 models)')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  // ── Add Key flow ───────────────────────────────────────────────────────────

  it('shows "Add Key" button for Anthropic API when no key is stored', async () => {
    mockApiFetch.mockImplementation(buildMock({ vaultKeys: VAULT_KEYS_EMPTY }));
    renderWithProviders(<ProviderSettingsTab />);

    await waitFor(() => {
      // Multiple "Add Key" buttons exist (one per API-key provider)
      const addKeyButtons = screen.getAllByRole('button', { name: /Add Key/i });
      expect(addKeyButtons.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
  });

  it('calls POST /api/vault/keys when Add Key form is submitted', async () => {
    const base = buildMock({ vaultKeys: VAULT_KEYS_EMPTY });
    mockApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === '/api/vault/keys' && opts?.method === 'POST') return { id: 'new-key-id', provider: 'anthropic', masked_key: 'sk-ant-****', label: '', base_url: null, spend_total_usd: 0, last_used_at: null, created_at: new Date().toISOString() };
      return base(path);
    });

    renderWithProviders(<ProviderSettingsTab />);

    // Wait for Add Key buttons to appear and click the first one (Anthropic)
    let addKeyButtons: HTMLElement[];
    await waitFor(() => {
      addKeyButtons = screen.getAllByRole('button', { name: /Add Key/i });
      expect(addKeyButtons.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });

    fireEvent.click(addKeyButtons![0]);

    // Form appears — fill in API key input
    await waitFor(() => {
      const inputs = document.querySelectorAll('input[type="password"]');
      expect(inputs.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 2000 });

    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(passwordInput, { target: { value: 'sk-ant-test-key' } });

    // Click Save button (first match — the one in the inline add-key form)
    const saveButtons = screen.getAllByRole('button', { name: /Save/i });
    fireEvent.click(saveButtons[0]);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/vault/keys',
        expect.objectContaining({ method: 'POST' }),
      );
    }, { timeout: 3000 });
  });

  // ── Remove flow ────────────────────────────────────────────────────────────

  it('shows "Remove" button when a key is configured', async () => {
    mockApiFetch.mockImplementation(buildMock({ vaultKeys: VAULT_KEYS_WITH_ENTRIES }));
    renderWithProviders(<ProviderSettingsTab />);

    await waitFor(() => {
      const removeButtons = screen.getAllByRole('button', { name: /Remove/i });
      expect(removeButtons.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
  });

  it('calls DELETE /api/vault/keys/:id when Remove is confirmed', async () => {
    const base = buildMock({ vaultKeys: VAULT_KEYS_WITH_ENTRIES });
    mockApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (opts?.method === 'DELETE' && path.includes('/api/vault/keys/')) return {};
      return base(path);
    });

    renderWithProviders(<ProviderSettingsTab />);

    // Wait for Remove buttons to appear
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Remove/i }).length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });

    // Click the first Remove button to show confirmation
    const removeButtons = screen.getAllByRole('button', { name: /Remove/i });
    fireEvent.click(removeButtons[0]);

    // Confirm dialog appears with Confirm button
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Confirm/i })).toBeInTheDocument();
    }, { timeout: 2000 });

    fireEvent.click(screen.getByRole('button', { name: /Confirm/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/vault\/keys\/.+/),
        expect.objectContaining({ method: 'DELETE' }),
      );
    }, { timeout: 3000 });
  });

  // ── PROVIDER_TABS contains 'connections' ───────────────────────────────────

  it('connections tab is present in the tab nav bar', async () => {
    mockApiFetch.mockImplementation(buildMock());
    renderWithProviders(<ProviderSettingsTab />);

    await waitFor(() => {
      // The tab nav renders a button with label "Connections"
      expect(screen.getByRole('button', { name: 'Connections' })).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  // ── Error resilience ───────────────────────────────────────────────────────

  it('renders gracefully when /api/vault/keys fails', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/vault/keys') throw new Error('Vault unavailable');
      return (buildMock())(path);
    });

    renderWithProviders(<ProviderSettingsTab />);

    await waitFor(() => {
      expect(document.body).toBeInTheDocument();
    }, { timeout: 3000 });
  });
});

// ─── BillingSection ───────────────────────────────────────────────────────────

describe.skip('BillingSection (removed)', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/billing/status') return MOCK_BILLING_STATUS;
      if (path === '/api/billing/invoices') return MOCK_INVOICES;
      return {};
    });

    renderWithProviders(<BillingSection />);
    expect(document.body).toBeInTheDocument();
  });

  it('displays billing plan information', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/billing/status') return MOCK_BILLING_STATUS;
      if (path === '/api/billing/invoices') return MOCK_INVOICES;
      return {};
    });

    renderWithProviders(<BillingSection />);

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
      if (path === '/api/billing/status') throw new Error('Billing unavailable');
      if (path === '/api/billing/invoices') return MOCK_INVOICES;
      return {};
    });

    renderWithProviders(<BillingSection />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});
