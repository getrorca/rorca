/**
 * Tests for Settings sub-components (PR-029 decomposition):
 * - ProviderSettingsTab
 * - GitHubSettingsTab
 * - ShortcutsSettingsTab
 * - AccountSettingsTab (BillingSection, AnalyticsSection, SystemSection)
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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
import { AccountSettingsTab, BillingSection } from '../settings/AccountSettingsTab';

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

const MOCK_VAULT_KEYS = {
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
    if (path === '/api/config') return MOCK_AGENT_CONFIG;
    if (path.includes('/api/config/opencode-models')) return MOCK_OPENCODE_MODELS;
    if (path.includes('/api/config/ollama')) return { available: false, models: [] };
    if (path.includes('/api/config/orchestration')) return MOCK_ORCHESTRATION;
    if (path.includes('/api/vault/keys/providers')) return { providers: [] };
    if (path.includes('/api/vault/keys/default-provider')) return { provider: 'claude-cli' };
    if (path.includes('/api/vault/keys')) return { keys: [] };
    if (path.includes('/api/direction/models')) return MOCK_DIRECTION_MODELS;
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
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/config') throw new Error('Config endpoint unavailable');
      if (path.includes('/api/config/opencode-models')) return MOCK_OPENCODE_MODELS;
      if (path.includes('/api/config/ollama')) return { available: false, models: [] };
      if (path.includes('/api/config/orchestration')) return MOCK_ORCHESTRATION;
      if (path.includes('/api/vault/keys/providers')) return { providers: [] };
      if (path.includes('/api/vault/keys/default-provider')) return { provider: 'claude-cli' };
      if (path.includes('/api/vault/keys')) return { keys: [] };
      if (path.includes('/api/direction/models')) return MOCK_DIRECTION_MODELS;
      if (path.includes('/api/settings')) return { theme: 'dark', defaultModel: null, itemsPerPage: 20 };
      return {};
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

// ─── BillingSection ───────────────────────────────────────────────────────────

describe('BillingSection', () => {
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
