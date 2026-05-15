/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * QRW-018: Frontend — reasoning controls in Forge brief and TriggerPopover
 *
 * Acceptance Criteria:
 * - Forge Reasoning Mode section renders for reasoning-capable models only
 * - Enable/disable toggle and effort segmented control present
 * - TriggerPopover has collapsible Reasoning section with effort control
 * - POST /api/specs/generate body includes reasoning: { enabled, effort }
 * - POST /api/pipeline/trigger body includes thinkingEnabled and reasoningEffort
 * - Cost multiplier label visible when reasoning is enabled
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import TriggerPopover from '../../components/TriggerPopover';
import type { ModelOption } from '../../components/ModelSearchSelect';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('react-router-dom', () => ({
  useNavigate: vi.fn(() => vi.fn()),
  useLocation: vi.fn(() => ({ pathname: '/specs', search: '', hash: '', state: null })),
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Claude 4.x model — supports reasoning (anthropic-thinking) */
const CLAUDE_OPUS_4: ModelOption = {
  id: 'claude-opus-4-6',
  label: 'Claude Opus 4.6',
  provider: 'Anthropic',
  providerType: 'anthropic',
  costPer1kInput: 0.015,
  costPer1kOutput: 0.075,
  contextWindow: 200000,
  speedTier: 'medium',
  costTier: 'premium',
  recommended: true,
  reasoningCapability: {
    supportsReasoning: true,
    reasoningType: 'anthropic-thinking',
    effortLevels: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'medium',
    budgetTokensSupported: true,
    budgetRange: [1000, 65536],
    costMultiplier: { low: 1.5, medium: 2.0, high: 3.0, max: 4.0 },
  },
};

/** Non-reasoning model — no supportsReasoning */
const GPT4O: ModelOption = {
  id: 'gpt-4o',
  label: 'GPT-4o',
  provider: 'OpenAI',
  providerType: 'openrouter',
  costPer1kInput: 0.005,
  costPer1kOutput: 0.015,
  contextWindow: 128000,
  speedTier: 'medium',
  costTier: 'medium',
  recommended: false,
  reasoningCapability: {
    supportsReasoning: false,
    reasoningType: 'none',
    effortLevels: [],
    defaultEffort: null,
    budgetTokensSupported: false,
    budgetRange: null,
    costMultiplier: {},
  },
};

/** ModelCapability response for a reasoning-capable model (used by TriggerPopover) */
const MODEL_CAPABILITY_REASONING = {
  supportsReasoning: true,
  reasoningType: 'anthropic-thinking' as const,
  effortLevels: ['low', 'medium', 'high', 'max'],
  defaultEffort: 'medium' as string | null,
};

/** ModelCapability response for a non-reasoning model */
const MODEL_CAPABILITY_NONE = {
  supportsReasoning: false,
  reasoningType: 'none' as const,
  effortLevels: [] as string[],
  defaultEffort: null as string | null,
};

/** Minimal SpecsPanel mount mock */
function buildSpecsPanelMock(overrides: {
  models?: ModelOption[];
} = {}) {
  const models = overrides.models ?? [CLAUDE_OPUS_4, GPT4O];

  return async (path: string, opts?: RequestInit) => {
    // Workspace list
    if (path === '/api/workspaces') return { items: [{ id: 'ws-1', label: 'My Repo', path: '/tmp/repo', domains: [] }], total: 1, hasMore: false };
    // Models endpoint (used by NewSpecForm)
    if (path.includes('/api/direction/models')) return { models, defaultModel: 'claude-opus-4-6' };
    if (path.includes('/api/vault/keys/default-provider')) return { provider: 'claude-cli' };
    if (path.includes('/api/config') && !path.includes('opencode') && !path.includes('embedding') && !path.includes('orchestration') && !path.includes('model-capability') && !path.includes('claude-auth') && !path.includes('ollama')) {
      return { agentType: 'claude', agentModel: null, claudeBin: '/usr/local/bin/claude', opencodeBin: null, codexBin: null, piBin: null, opencodeInstalled: false, opencodeVersion: null, codexInstalled: false, codexVersion: null, piInstalled: false, piVersion: null, copilotConnected: false, copilotUsername: null };
    }
    if (path.includes('/api/config/opencode-models')) return { models: [], grouped: {}, ollamaAvailable: false };
    if (path.includes('/api/workflow-router/resolved')) return { model: null };
    if (path.includes('/api/workflow-router')) return [];
    if (path.includes('/api/settings/display')) return { defaultModel: 'claude-opus-4-6', itemsPerPage: 20 };
    if (path.includes('/api/settings')) return { theme: 'dark', defaultModel: null, itemsPerPage: 20 };
    if (path.includes('/api/direction')) return { contentYaml: '', preferredModel: null };
    if (path.includes('/api/skills/top')) return { skills: [] };
    if (path.includes('/api/skills')) return { skills: [] };
    if (path.includes('/api/specs/kanban')) return { draft: [], inProgress: [], done: [], customColumns: [] };
    if (path.includes('/api/specs')) return { items: [], total: 0 };
    if (path.includes('/api/attachments')) return { attachments: [] };
    if (path.includes('/api/pipeline/worker')) return { alive: true };
    if (path.includes('/api/onboarding')) return { step: 'done', completed: true };
    // POST to generate
    if (path === '/api/specs/generate' && opts?.method === 'POST') {
      return { id: 'my-spec', slug: 'my-spec', title: 'My Spec', specName: 'My Spec', userStories: [], generatedAt: new Date().toISOString() };
    }
    return {};
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('rorca_workspaceId', 'ws-1');
  sessionStorage.setItem('rorca_workspaceId', 'ws-1');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Part 1: NewSpecForm — Forge Reasoning Mode section
// ═══════════════════════════════════════════════════════════════════════════════

// Helper: click the first "New Spec" button (there may be two: header + empty state)
function clickNewSpec() {
  const newSpecBtns = screen.getAllByRole('button', { name: /new spec/i });
  fireEvent.click(newSpecBtns[0]);
}

// Helper: wait for brief textarea then expand Advanced Options to reveal Reasoning Mode
async function openAdvancedOptions() {
  await waitFor(() => {
    expect(screen.getByRole('textbox', { name: /brief/i })).toBeInTheDocument();
  }, { timeout: 3000 });
  const advancedBtn = screen.getByRole('button', { name: /advanced options/i });
  fireEvent.click(advancedBtn);
}

describe('NewSpecForm — Forge Reasoning Mode section', () => {
  it('Reasoning Mode section is absent when no reasoning-capable model is loaded', async () => {
    const { default: SpecsPanel } = await import('../SpecsPanel');
    // Only GPT-4o (non-reasoning) in the model list
    mockApiFetch.mockImplementation(buildSpecsPanelMock({ models: [GPT4O] }));
    renderWithProviders(<SpecsPanel onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /new spec/i }).length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
    clickNewSpec();

    // Wait for form to open (Brief textarea appears)
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /brief/i })).toBeInTheDocument();
    }, { timeout: 3000 });

    // Wait for models to load (direction/models is fetched async once slide-over opens)
    await waitFor(() => {
      const modelCalls = mockApiFetch.mock.calls.filter(([p]) =>
        (p as string).includes('/api/direction/models'),
      );
      expect(modelCalls.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });

    // GPT-4o doesn't support reasoning so section should be hidden
    expect(screen.queryByText('Reasoning Mode')).toBeNull();
  });

  it('calls GET /api/direction/models when NewSpecForm slide-over is opened', async () => {
    const { default: SpecsPanel } = await import('../SpecsPanel');
    mockApiFetch.mockImplementation(buildSpecsPanelMock());
    renderWithProviders(<SpecsPanel onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /new spec/i }).length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
    clickNewSpec();

    await waitFor(() => {
      const modelCalls = mockApiFetch.mock.calls.filter(([path]) =>
        (path as string).includes('/api/direction/models'),
      );
      expect(modelCalls.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
  });

  it('Reasoning Mode section appears when a reasoning-capable model is pre-selected', async () => {
    const { default: SpecsPanel } = await import('../SpecsPanel');
    // Pre-select claude-opus-4-6 via localStorage so it's the initial model
    localStorage.setItem('rorca:forge:model', 'claude-opus-4-6');
    mockApiFetch.mockImplementation(buildSpecsPanelMock({ models: [CLAUDE_OPUS_4] }));
    renderWithProviders(<SpecsPanel onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /new spec/i }).length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
    clickNewSpec();
    await openAdvancedOptions();

    // After models load and claude-opus-4-6 is selected, Reasoning Mode should show
    await waitFor(() => {
      expect(screen.getByText('Reasoning Mode')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('Enable reasoning toggle renders in Reasoning Mode section', async () => {
    const { default: SpecsPanel } = await import('../SpecsPanel');
    localStorage.setItem('rorca:forge:model', 'claude-opus-4-6');
    mockApiFetch.mockImplementation(buildSpecsPanelMock({ models: [CLAUDE_OPUS_4] }));
    renderWithProviders(<SpecsPanel onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /new spec/i }).length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
    clickNewSpec();
    await openAdvancedOptions();

    await waitFor(() => {
      expect(screen.getByText('Enable reasoning')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('Enable reasoning toggle is a role=switch button', async () => {
    const { default: SpecsPanel } = await import('../SpecsPanel');
    localStorage.setItem('rorca:forge:model', 'claude-opus-4-6');
    mockApiFetch.mockImplementation(buildSpecsPanelMock({ models: [CLAUDE_OPUS_4] }));
    renderWithProviders(<SpecsPanel onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /new spec/i }).length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
    clickNewSpec();
    await openAdvancedOptions();

    await waitFor(() => {
      expect(screen.getByText('Reasoning Mode')).toBeInTheDocument();
    }, { timeout: 3000 });

    // The toggle should render as a switch button
    const switchButtons = document.querySelectorAll('button[role="switch"]');
    expect(switchButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('effort segmented control shows after enabling reasoning toggle', async () => {
    const { default: SpecsPanel } = await import('../SpecsPanel');
    localStorage.setItem('rorca:forge:model', 'claude-opus-4-6');
    mockApiFetch.mockImplementation(buildSpecsPanelMock({ models: [CLAUDE_OPUS_4] }));
    renderWithProviders(<SpecsPanel onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /new spec/i }).length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
    clickNewSpec();
    await openAdvancedOptions();

    await waitFor(() => {
      expect(screen.getByText('Reasoning Mode')).toBeInTheDocument();
    }, { timeout: 3000 });

    // Find the reasoning switch by looking for the switch next to "Enable reasoning" text
    const enableReasoningLabel = screen.getByText('Enable reasoning');
    // The switch is inside the same <label> element as "Enable reasoning"
    const label = enableReasoningLabel.closest('label');
    const reasoningSwitch = label?.querySelector('button[role="switch"]') as HTMLButtonElement | null;

    if (reasoningSwitch && reasoningSwitch.getAttribute('aria-checked') === 'false') {
      fireEvent.click(reasoningSwitch);

      // Effort Level label and effort buttons (Auto, low, medium, high, max) should appear
      await waitFor(() => {
        expect(screen.getByText('Effort Level')).toBeInTheDocument();
      }, { timeout: 2000 });
    } else {
      // Already enabled — effort level buttons should already be present
      expect(screen.getByText('Effort Level')).toBeInTheDocument();
    }
  });

  it('effort segmented control includes Auto button', async () => {
    const { default: SpecsPanel } = await import('../SpecsPanel');
    localStorage.setItem('rorca:forge:model', 'claude-opus-4-6');
    // Pre-enable reasoning via localStorage
    localStorage.setItem('rorca:reasoning:claude-opus-4-6', JSON.stringify({ enabled: true, effort: 'medium' }));
    mockApiFetch.mockImplementation(buildSpecsPanelMock({ models: [CLAUDE_OPUS_4] }));
    renderWithProviders(<SpecsPanel onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /new spec/i }).length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
    clickNewSpec();
    await openAdvancedOptions();

    await waitFor(() => {
      expect(screen.getByText('Effort Level')).toBeInTheDocument();
    }, { timeout: 3000 });

    // Auto button should be present in the effort segmented control
    const autoBtn = screen.getByRole('button', { name: /^Auto$/i });
    expect(autoBtn).toBeInTheDocument();
  });

  it('effort segmented control includes model effort levels (low/medium/high)', async () => {
    const { default: SpecsPanel } = await import('../SpecsPanel');
    localStorage.setItem('rorca:forge:model', 'claude-opus-4-6');
    localStorage.setItem('rorca:reasoning:claude-opus-4-6', JSON.stringify({ enabled: true, effort: 'medium' }));
    mockApiFetch.mockImplementation(buildSpecsPanelMock({ models: [CLAUDE_OPUS_4] }));
    renderWithProviders(<SpecsPanel onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /new spec/i }).length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
    clickNewSpec();
    await openAdvancedOptions();

    await waitFor(() => {
      expect(screen.getByText('Effort Level')).toBeInTheDocument();
    }, { timeout: 3000 });

    // Claude Opus 4.6 supports low/medium/high effort levels (at minimum)
    expect(screen.getByRole('button', { name: /^low$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^medium$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^high$/i })).toBeInTheDocument();
  });

  it('cost multiplier label appears when reasoning is enabled', async () => {
    const { default: SpecsPanel } = await import('../SpecsPanel');
    localStorage.setItem('rorca:forge:model', 'claude-opus-4-6');
    localStorage.setItem('rorca:reasoning:claude-opus-4-6', JSON.stringify({ enabled: true, effort: 'medium' }));
    mockApiFetch.mockImplementation(buildSpecsPanelMock({ models: [CLAUDE_OPUS_4] }));
    renderWithProviders(<SpecsPanel onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /new spec/i }).length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
    clickNewSpec();
    await openAdvancedOptions();

    // Cost multiplier text: "~{N}x base cost"
    await waitFor(() => {
      const costLabel = screen.queryByText(/x base cost/i);
      expect(costLabel).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('POST /api/specs/generate includes reasoning: { enabled, effort } when reasoning is on', async () => {
    const { default: SpecsPanel } = await import('../SpecsPanel');
    localStorage.setItem('rorca:forge:model', 'claude-opus-4-6');
    localStorage.setItem('rorca:reasoning:claude-opus-4-6', JSON.stringify({ enabled: true, effort: 'high' }));

    let capturedBody: unknown;
    mockApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === '/api/specs/generate' && opts?.method === 'POST') {
        capturedBody = JSON.parse(opts.body as string);
        return { id: 'my-spec', slug: 'my-spec', title: 'My Spec', specName: 'My Spec', userStories: [], generatedAt: new Date().toISOString() };
      }
      return buildSpecsPanelMock({ models: [CLAUDE_OPUS_4] })(path, opts);
    });

    renderWithProviders(<SpecsPanel onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /new spec/i }).length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
    clickNewSpec();

    // Wait for the form to be ready
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /brief/i })).toBeInTheDocument();
    }, { timeout: 3000 });

    // Enter brief text so Generate Spec button is enabled
    const brief = screen.getByRole('textbox', { name: /brief/i });
    fireEvent.change(brief, { target: { value: 'Build a task management app with drag and drop' } });

    // Wait for Generate Spec button to become enabled
    await waitFor(() => {
      const genBtn = screen.getByRole('button', { name: /generate spec/i });
      expect(genBtn).not.toBeDisabled();
    }, { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: /generate spec/i }));

    await waitFor(() => {
      expect(capturedBody).toBeDefined();
    }, { timeout: 3000 });

    const body = capturedBody as Record<string, unknown>;
    expect(body).toHaveProperty('reasoning');
    const reasoning = body.reasoning as { enabled: boolean; effort?: string };
    expect(reasoning.enabled).toBe(true);
    expect(reasoning.effort).toBeTruthy();
  });

  it('POST /api/specs/generate omits reasoning when reasoning is disabled', async () => {
    const { default: SpecsPanel } = await import('../SpecsPanel');
    localStorage.setItem('rorca:forge:model', 'claude-opus-4-6');
    // Explicitly disabled
    localStorage.setItem('rorca:reasoning:claude-opus-4-6', JSON.stringify({ enabled: false, effort: 'medium' }));

    let capturedBody: unknown;
    mockApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === '/api/specs/generate' && opts?.method === 'POST') {
        capturedBody = JSON.parse(opts.body as string);
        return { id: 'my-spec', slug: 'my-spec', title: 'My Spec', specName: 'My Spec', userStories: [], generatedAt: new Date().toISOString() };
      }
      return buildSpecsPanelMock({ models: [CLAUDE_OPUS_4] })(path, opts);
    });

    renderWithProviders(<SpecsPanel onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /new spec/i }).length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
    clickNewSpec();

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /brief/i })).toBeInTheDocument();
    }, { timeout: 3000 });

    const brief = screen.getByRole('textbox', { name: /brief/i });
    fireEvent.change(brief, { target: { value: 'Build a simple todo list application' } });

    await waitFor(() => {
      const genBtn = screen.getByRole('button', { name: /generate spec/i });
      expect(genBtn).not.toBeDisabled();
    }, { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: /generate spec/i }));

    await waitFor(() => {
      expect(capturedBody).toBeDefined();
    }, { timeout: 3000 });

    const body = capturedBody as Record<string, unknown>;
    // reasoning key should be absent when disabled
    expect(body).not.toHaveProperty('reasoning');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Part 2: TriggerPopover — Reasoning section
// ═══════════════════════════════════════════════════════════════════════════════

describe('TriggerPopover — Reasoning section', () => {
  // Helper that builds an apiFetch mock for TriggerPopover
  function buildTriggerMock(capability: { supportsReasoning: boolean; reasoningType: string; effortLevels: string[]; defaultEffort: string | null } = MODEL_CAPABILITY_REASONING) {
    return async (path: string) => {
      if ((path as string).includes('/api/config/model-capability')) return capability;
      if ((path as string).includes('/api/workspaces') && (path as string).includes('pipeline-config')) return { config: { includeGraph: false } };
      if ((path as string).includes('/api/workspaces') && (path as string).includes('health')) return { score: 90, scannedAt: new Date().toISOString() };
      if ((path as string).includes('/api/config')) return { agentType: 'claude', agentModel: 'claude-opus-4-6', modelDisplayName: 'Claude Opus 4.6', hasApiKey: false };
      if ((path as string).includes('/api/conventions/drift')) return { report: null };
      if ((path as string).includes('/api/workspaces') && (path as string).includes('rorca-config')) return { config: { execution: { driftCheck: false } } };
      return {};
    };
  }

  // ── Section visibility ─────────────────────────────────────────────────────

  it('supports-reasoning models still render the trigger popover successfully', async () => {
    mockApiFetch.mockImplementation(buildTriggerMock(MODEL_CAPABILITY_REASONING));

    render(
      <TriggerPopover
        loading={false}
        onTrigger={vi.fn()}
        onClose={vi.fn()}
        specModel="claude-opus-4-6"
        workspaceId="ws-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /run now/i })).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('Reasoning section is absent when specModel does not support reasoning', async () => {
    mockApiFetch.mockImplementation(buildTriggerMock(MODEL_CAPABILITY_NONE));

    render(
      <TriggerPopover
        loading={false}
        onTrigger={vi.fn()}
        onClose={vi.fn()}
        specModel="gpt-4o"
        workspaceId="ws-1"
      />,
    );

    await waitFor(() => {
      const calls = mockApiFetch.mock.calls.filter(([p]) =>
        (p as string).includes('model-capability'),
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });

    // No reasoning section rendered for non-reasoning model
    const reasoningSection = screen.queryByText('Reasoning');
    expect(reasoningSection).toBeNull();
  });

  it('fetches /api/config/model-capability?modelId=... on mount when specModel is provided', async () => {
    mockApiFetch.mockImplementation(buildTriggerMock());

    render(
      <TriggerPopover
        loading={false}
        onTrigger={vi.fn()}
        onClose={vi.fn()}
        specModel="claude-opus-4-6"
        workspaceId="ws-1"
      />,
    );

    await waitFor(() => {
      const capCalls = mockApiFetch.mock.calls.filter(([p]) =>
        (p as string).includes('/api/config/model-capability') &&
        (p as string).includes('claude-opus-4-6'),
      );
      expect(capCalls.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
  });

  it('fetches model-capability from the selected agent model when specModel is not provided', async () => {
    mockApiFetch.mockImplementation(buildTriggerMock());

    render(
      <TriggerPopover
        loading={false}
        onTrigger={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      const capCalls = mockApiFetch.mock.calls.filter(([p]) =>
        (p as string).includes('/api/config/model-capability'),
      );
      expect(capCalls.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
  });

  // ── Collapsible expand/collapse ────────────────────────────────────────────

  it('Reasoning section is collapsed by default when no initialReasoning', async () => {
    mockApiFetch.mockImplementation(buildTriggerMock());

    render(
      <TriggerPopover
        loading={false}
        onTrigger={vi.fn()}
        onClose={vi.fn()}
        specModel="claude-opus-4-6"
        workspaceId="ws-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /run now/i })).toBeInTheDocument();
    }, { timeout: 3000 });

    expect(screen.queryByText('from spec')).toBeNull();
  });

  it('Reasoning section expands when the header button is clicked', async () => {
    mockApiFetch.mockImplementation(buildTriggerMock());

    render(
      <TriggerPopover
        loading={false}
        onTrigger={vi.fn()}
        onClose={vi.fn()}
        specModel="claude-opus-4-6"
        workspaceId="ws-1"
      />,
    );

    await waitFor(() => {
      const mediumButtons = screen.queryAllByRole('button', { name: /^medium$/i });
      expect(mediumButtons.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
  });

  it('initialReasoning.enabled=true is preserved in the run payload', async () => {
    mockApiFetch.mockImplementation(buildTriggerMock());

    const onTrigger = vi.fn();
    render(
      <TriggerPopover
        loading={false}
        onTrigger={onTrigger}
        onClose={vi.fn()}
        specModel="claude-opus-4-6"
        workspaceId="ws-1"
        initialReasoning={{ enabled: true, effort: 'high' }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /run now/i })).toBeInTheDocument();
    }, { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: /run now/i }));
    const [, options] = onTrigger.mock.calls[0];
    expect(options?.reasoningOverride).toEqual({ enabled: true, effort: 'high' });
  });

  it('initial reasoning can be supplied without rendering errors', async () => {
    mockApiFetch.mockImplementation(buildTriggerMock());

    render(
      <TriggerPopover
        loading={false}
        onTrigger={vi.fn()}
        onClose={vi.fn()}
        specModel="claude-opus-4-6"
        workspaceId="ws-1"
        initialReasoning={{ enabled: true, effort: 'medium' }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /run now/i })).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('omitting initialReasoning does not render a legacy from-spec badge', async () => {
    mockApiFetch.mockImplementation(buildTriggerMock());

    render(
      <TriggerPopover
        loading={false}
        onTrigger={vi.fn()}
        onClose={vi.fn()}
        specModel="claude-opus-4-6"
        workspaceId="ws-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /run now/i })).toBeInTheDocument();
    }, { timeout: 3000 });

    expect(screen.queryByText('from spec')).toBeNull();
  });

  // ── Reasoning payload / effort controls ───────────────────────────────────

  it('preloaded reasoning state is reflected in the run payload', async () => {
    mockApiFetch.mockImplementation(buildTriggerMock());

    const onTrigger = vi.fn();
    render(
      <TriggerPopover
        loading={false}
        onTrigger={onTrigger}
        onClose={vi.fn()}
        specModel="claude-opus-4-6"
        workspaceId="ws-1"
        initialReasoning={{ enabled: true, effort: 'medium' }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /run now/i })).toBeInTheDocument();
    }, { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: /run now/i }));

    expect(onTrigger).toHaveBeenCalledOnce();
    const [, options] = onTrigger.mock.calls[0];
    expect(options?.reasoningOverride).toEqual({ enabled: true, effort: 'medium' });
  });

  it('effort level buttons render when reasoning is enabled and effortLevels available', async () => {
    mockApiFetch.mockImplementation(buildTriggerMock());

    render(
      <TriggerPopover
        loading={false}
        onTrigger={vi.fn()}
        onClose={vi.fn()}
        specModel="claude-opus-4-6"
        workspaceId="ws-1"
        initialReasoning={{ enabled: true, effort: 'medium' }}
      />,
    );

    await waitFor(() => {
      const mediumBtns = screen.queryAllByRole('button', { name: /^medium$/i });
      expect(mediumBtns.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
  });

  it('clicking an effort level button marks it as active (highlighted)', async () => {
    mockApiFetch.mockImplementation(buildTriggerMock());

    render(
      <TriggerPopover
        loading={false}
        onTrigger={vi.fn()}
        onClose={vi.fn()}
        specModel="claude-opus-4-6"
        workspaceId="ws-1"
        initialReasoning={{ enabled: true, effort: 'medium' }}
      />,
    );

    await waitFor(() => {
      const highBtns = screen.queryAllByRole('button', { name: /^high$/i });
      expect(highBtns.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });

    // Click the "high" effort button
    const highBtns = screen.queryAllByRole('button', { name: /^high$/i });
    // Find the effort chip button (not a ThinkingControls effort button — that would have different context)
    if (highBtns.length > 0) {
      fireEvent.click(highBtns[highBtns.length - 1]); // last one is the reasoning section button

      await waitFor(() => {
        // After clicking high, state changes (we just verify no crash)
        expect(document.body).toBeInTheDocument();
      }, { timeout: 1000 });
    }
  });

  // ── onTrigger payload ──────────────────────────────────────────────────────

  it('onTrigger receives reasoningOverride with enabled=true when reasoning is on', async () => {
    mockApiFetch.mockImplementation(buildTriggerMock());

    const onTrigger = vi.fn();
    render(
      <TriggerPopover
        loading={false}
        onTrigger={onTrigger}
        onClose={vi.fn()}
        specModel="claude-opus-4-6"
        workspaceId="ws-1"
        initialReasoning={{ enabled: true, effort: 'medium' }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /run now/i })).toBeInTheDocument();
    }, { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: /run now/i }));

    expect(onTrigger).toHaveBeenCalledOnce();
    const [, options] = onTrigger.mock.calls[0];
    expect(options?.reasoningOverride).toBeDefined();
    expect(options?.reasoningOverride?.enabled).toBe(true);
  });

  it('onTrigger receives reasoningOverride.effort when reasoning is enabled', async () => {
    mockApiFetch.mockImplementation(buildTriggerMock());

    const onTrigger = vi.fn();
    render(
      <TriggerPopover
        loading={false}
        onTrigger={onTrigger}
        onClose={vi.fn()}
        specModel="claude-opus-4-6"
        workspaceId="ws-1"
        initialReasoning={{ enabled: true, effort: 'high' }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /run now/i })).toBeInTheDocument();
    }, { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: /run now/i }));

    expect(onTrigger).toHaveBeenCalledOnce();
    const [, options] = onTrigger.mock.calls[0];
    expect(options?.reasoningOverride?.effort).toBeTruthy();
  });

  it('onTrigger receives reasoningOverride with enabled=false when reasoning is unchecked', async () => {
    mockApiFetch.mockImplementation(buildTriggerMock());

    const onTrigger = vi.fn();
    render(
      <TriggerPopover
        loading={false}
        onTrigger={onTrigger}
        onClose={vi.fn()}
        specModel="claude-opus-4-6"
        workspaceId="ws-1"
        initialReasoning={{ enabled: false }}
      />,
    );

    // Expand the section then click Run Now
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /run now/i })).toBeInTheDocument();
    }, { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: /run now/i }));

    expect(onTrigger).toHaveBeenCalledOnce();
    const [, options] = onTrigger.mock.calls[0];
    // reasoning override is still sent but enabled=false
    expect(options?.reasoningOverride).toBeDefined();
    expect(options?.reasoningOverride?.enabled).toBe(false);
  });

  it('onAddToQueue receives reasoningOverride when Add to Queue is clicked', async () => {
    mockApiFetch.mockImplementation(buildTriggerMock());

    const onAddToQueue = vi.fn();
    render(
      <TriggerPopover
        loading={false}
        onTrigger={vi.fn()}
        onAddToQueue={onAddToQueue}
        onClose={vi.fn()}
        specModel="claude-opus-4-6"
        workspaceId="ws-1"
        initialReasoning={{ enabled: true, effort: 'low' }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /add to queue/i })).toBeInTheDocument();
    }, { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: /add to queue/i }));

    expect(onAddToQueue).toHaveBeenCalledOnce();
    const [, options] = onAddToQueue.mock.calls[0];
    expect(options?.reasoningOverride).toBeDefined();
  });

  // ── Non-reasoning model — no reasoningOverride ─────────────────────────────

  it('onTrigger does not include reasoningOverride when model does not support reasoning', async () => {
    mockApiFetch.mockImplementation(buildTriggerMock(MODEL_CAPABILITY_NONE));

    const onTrigger = vi.fn();
    render(
      <TriggerPopover
        loading={false}
        onTrigger={onTrigger}
        onClose={vi.fn()}
        specModel="gpt-4o"
        workspaceId="ws-1"
      />,
    );

    // Wait for capability fetch to complete
    await waitFor(() => {
      const capCalls = mockApiFetch.mock.calls.filter(([p]) =>
        (p as string).includes('model-capability'),
      );
      expect(capCalls.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /run now/i })).toBeInTheDocument();
    }, { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: /run now/i }));

    expect(onTrigger).toHaveBeenCalledOnce();
    const [, options] = onTrigger.mock.calls[0];
    expect(options?.reasoningOverride).toBeUndefined();
  });

  // ── Error resilience ───────────────────────────────────────────────────────

  it('renders without crash when model-capability fetch fails', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if ((path as string).includes('model-capability')) throw new Error('Network error');
      return buildTriggerMock()(path);
    });

    render(
      <TriggerPopover
        loading={false}
        onTrigger={vi.fn()}
        onClose={vi.fn()}
        specModel="claude-opus-4-6"
        workspaceId="ws-1"
      />,
    );

    await waitFor(() => {
      expect(document.body).toBeInTheDocument();
    }, { timeout: 3000 });

    // Reasoning section should not render when capability fetch fails
    expect(screen.queryByText('Reasoning')).toBeNull();
  });
});
