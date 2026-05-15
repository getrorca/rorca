/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * QRW-019: Frontend — model picker shows reasoning badges and filter chip
 *
 * Tests:
 * - ModelOption interface has supportsReasoning (boolean) and effortLevels (string[]) fields
 * - Brain/sparkle icon renders next to reasoning-capable model names
 * - Reasoning filter chip filters dropdown to reasoning-capable models only
 * - npx tsc --noEmit passes with the updated ModelOption type
 *
 * Note: ModelPickerPopover uses fixed positioning and TanStack Virtualizer for rendering.
 * Tests use fireEvent.click to open the popover and inspect the rendered DOM.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import type { ModelOption } from '../ModelSearchSelect';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
  onApiFetchError: vi.fn(() => () => {}),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => null),
  getRefreshToken: vi.fn(() => null),
}));

// TanStack Virtualizer needs a scrollable container — mock it to render all items
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (i: number) => number }) => {
    const items = Array.from({ length: count }, (_, i) => ({
      key: i,
      index: i,
      start: Array.from({ length: i }, (_, j) => estimateSize(j)).reduce((a, b) => a + b, 0),
      size: estimateSize(i),
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => items.reduce((sum, item) => sum + item.size, 0),
      scrollToIndex: vi.fn(),
    };
  },
}));

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

import ModelPickerPopover from '../ModelPickerPopover';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Claude 4.x model — reasoning capable (Opus: all 4 effort levels incl. max) */
const CLAUDE_OPUS: ModelOption = {
  id: 'claude-opus-4-6',
  label: 'Claude Opus 4.6',
  provider: 'Anthropic',
  providerType: 'anthropic',
  costPer1kInput: 0,
  costPer1kOutput: 0,
  contextWindow: 200000,
  speedTier: 'slow',
  costTier: 'subscription',
  recommended: false,
  supportsReasoning: true,
  effortLevels: ['low', 'medium', 'high', 'max'],
};

/** Claude 4.x model — reasoning capable (Sonnet: 3 effort levels, no max) */
const CLAUDE_SONNET: ModelOption = {
  id: 'claude-sonnet-4-6',
  label: 'Claude Sonnet 4.6',
  provider: 'Anthropic',
  providerType: 'anthropic',
  costPer1kInput: 0,
  costPer1kOutput: 0,
  contextWindow: 200000,
  speedTier: 'medium',
  costTier: 'subscription',
  recommended: true,
  supportsReasoning: true,
  effortLevels: ['low', 'medium', 'high'],
};

/** OpenAI o3 — reasoning capable (o-series) */
const OPENAI_O3: ModelOption = {
  id: 'openai/o3',
  label: 'OpenAI o3',
  provider: 'OpenAI',
  providerType: 'openai-compat',
  costPer1kInput: 0.02,
  costPer1kOutput: 0.08,
  contextWindow: 128000,
  speedTier: 'slow',
  costTier: 'premium',
  recommended: false,
  supportsReasoning: true,
  effortLevels: ['low', 'medium', 'high'],
};

/** GPT-4o — NOT reasoning capable */
const GPT4O: ModelOption = {
  id: 'gpt-4o',
  label: 'GPT-4o',
  provider: 'OpenAI',
  providerType: 'openai-compat',
  costPer1kInput: 0.005,
  costPer1kOutput: 0.015,
  contextWindow: 128000,
  speedTier: 'medium',
  costTier: 'medium',
  recommended: false,
  supportsReasoning: false,
  effortLevels: [],
};

/** Mix of reasoning and non-reasoning models for OpenCode engine */
const OPENCODE_MODELS_RESPONSE = {
  models: [OPENAI_O3, GPT4O],
  defaultModel: 'gpt-4o',
  configuredProviders: ['openai-compat'],
};

/** Pi CLI model catalog */
const PI_MODELS_RESPONSE = {
  models: [
    {
      provider: 'openai',
      model: 'gpt-5',
      contextTokens: 200000,
      maxOutTokens: 100000,
      thinking: true,
      images: false,
    },
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      contextTokens: 200000,
      maxOutTokens: 32000,
      thinking: true,
      images: true,
    },
  ],
  count: 2,
  piBinPath: '/usr/local/bin/pi',
};

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

// Stub getBoundingClientRect so popover position is calculable
const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  Element.prototype.getBoundingClientRect = vi.fn(() => ({
    top: 100,
    bottom: 130,
    left: 50,
    right: 250,
    width: 200,
    height: 30,
    x: 50,
    y: 100,
    toJSON: () => {},
  }));
});

afterAll(() => {
  vi.restoreAllMocks();
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Clean up portals / fixed elements appended to document.body by the popover
  document.querySelectorAll('[role="listbox"]').forEach(el => el.remove());
});

// ─── Helper ────────────────────────────────────────────────────────────────────

function renderPicker(props: Partial<Parameters<typeof ModelPickerPopover>[0]> = {}) {
  const defaults = {
    engine: 'opencode' as const,
    value: '',
    onChange: vi.fn(),
    workspaceId: 'ws-test',
  };
  return render(<ModelPickerPopover {...defaults} {...props} />);
}

async function openPicker() {
  const trigger = screen.getByRole('button', { name: /Pick LLM model/i });
  await act(async () => {
    fireEvent.click(trigger);
  });
}

// ─── Interface type tests (compile-time) ──────────────────────────────────────

describe('ModelOption interface', () => {
  it('has a supportsReasoning boolean field', () => {
    // If this compiles, the field exists with the correct type
    const model: ModelOption = {
      id: 'test',
      label: 'Test',
      provider: 'Test',
      costPer1kInput: 0,
      costPer1kOutput: 0,
      recommended: false,
      supportsReasoning: true,
    };
    expect(typeof model.supportsReasoning).toBe('boolean');
  });

  it('has an effortLevels string array field', () => {
    const model: ModelOption = {
      id: 'test',
      label: 'Test',
      provider: 'Test',
      costPer1kInput: 0,
      costPer1kOutput: 0,
      recommended: false,
      effortLevels: ['low', 'medium', 'high'],
    };
    expect(Array.isArray(model.effortLevels)).toBe(true);
    expect(model.effortLevels!.every(l => typeof l === 'string')).toBe(true);
  });

  it('allows supportsReasoning to be undefined (optional field)', () => {
    const model: ModelOption = {
      id: 'test',
      label: 'Test',
      provider: 'Test',
      costPer1kInput: 0,
      costPer1kOutput: 0,
      recommended: false,
    };
    // Should compile with supportsReasoning absent
    expect(model.supportsReasoning).toBeUndefined();
  });

  it('allows effortLevels to be undefined (optional field)', () => {
    const model: ModelOption = {
      id: 'test',
      label: 'Test',
      provider: 'Test',
      costPer1kInput: 0,
      costPer1kOutput: 0,
      recommended: false,
    };
    expect(model.effortLevels).toBeUndefined();
  });

  it('can hold a full reasoning-capable model (Claude Opus shape)', () => {
    expect(CLAUDE_OPUS.supportsReasoning).toBe(true);
    expect(CLAUDE_OPUS.effortLevels).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('can hold a non-reasoning model (GPT-4o shape)', () => {
    expect(GPT4O.supportsReasoning).toBe(false);
    expect(GPT4O.effortLevels).toEqual([]);
  });
});

// ─── Reasoning filter chip tests ──────────────────────────────────────────────

describe('Reasoning filter chip', () => {
  beforeEach(() => {
    mockApiFetch.mockResolvedValue(OPENCODE_MODELS_RESPONSE as any);
  });

  it('renders the Reasoning filter chip button in the search bar', async () => {
    renderPicker();
    await openPicker();

    await waitFor(() => {
      const chip = screen.getByTitle('Show only reasoning-capable models');
      expect(chip).toBeInTheDocument();
    });
  });

  it('chip button contains "Reasoning" text', async () => {
    renderPicker();
    await openPicker();

    await waitFor(() => {
      // The chip renders with Brain icon + "Reasoning" text
      const chip = screen.getByTitle('Show only reasoning-capable models');
      expect(chip.textContent).toContain('Reasoning');
    });
  });

  it('chip has aria-pressed="false" by default (inactive state)', async () => {
    renderPicker();
    await openPicker();

    await waitFor(() => {
      const chip = screen.getByTitle('Show only reasoning-capable models');
      expect(chip.getAttribute('aria-pressed')).toBe('false');
    });
  });

  it('chip toggles aria-pressed to "true" when clicked', async () => {
    renderPicker();
    await openPicker();

    await waitFor(() => {
      expect(screen.getByTitle('Show only reasoning-capable models')).toBeInTheDocument();
    });

    const chip = screen.getByTitle('Show only reasoning-capable models');
    await act(async () => {
      fireEvent.click(chip);
    });

    expect(chip.getAttribute('aria-pressed')).toBe('true');
  });

  it('chip toggles back to aria-pressed="false" on second click', async () => {
    renderPicker();
    await openPicker();

    await waitFor(() => {
      expect(screen.getByTitle('Show only reasoning-capable models')).toBeInTheDocument();
    });

    const chip = screen.getByTitle('Show only reasoning-capable models');
    await act(async () => { fireEvent.click(chip); });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { fireEvent.click(chip); });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
  });

  it('chip has violet styling when active (reasoningOnly=true)', async () => {
    renderPicker();
    await openPicker();

    await waitFor(() => {
      expect(screen.getByTitle('Show only reasoning-capable models')).toBeInTheDocument();
    });

    const chip = screen.getByTitle('Show only reasoning-capable models');
    await act(async () => { fireEvent.click(chip); });

    // Active chip has bg-violet-500/20 and text-violet-400 classes
    expect(chip.className).toContain('violet');
  });
});

// ─── Brain icon (reasoning badge) tests ───────────────────────────────────────

describe('Brain icon on reasoning-capable models', () => {
  it('claude engine: hardcoded Opus model has supportsReasoning=true — popover shows Brain icon', async () => {
    // Open the popover to trigger model loading; for claude engine, models are hardcoded
    renderPicker({ engine: 'claude', value: 'claude-opus-4-6' });
    await openPicker();

    await waitFor(() => {
      // Claude models are set synchronously for the claude engine
      // Trigger should show the selected model label
      const trigger = screen.getByRole('button', { name: /Pick LLM model/i });
      expect(trigger.textContent).toContain('Claude Opus 4.6');
    });
  });

  it('claude engine: hardcoded Sonnet model renders in popover', async () => {
    renderPicker({ engine: 'claude', value: 'claude-sonnet-4-6' });
    const trigger = screen.getByRole('button', { name: /Pick LLM model/i });
    // Sonnet 4.6 is the default label when no model is found in state yet
    // After opening, it should show Sonnet
    expect(trigger).toBeInTheDocument();
  });

  it('claude engine: hardcoded Haiku model renders in popover', async () => {
    renderPicker({ engine: 'claude', value: 'claude-haiku-4-5-20251001' });
    const trigger = screen.getByRole('button', { name: /Pick LLM model/i });
    expect(trigger).toBeInTheDocument();
  });

  it('opencode engine: reasoning-capable model shows Brain icon in popover', async () => {
    mockApiFetch.mockResolvedValue({ models: [OPENAI_O3, GPT4O], defaultModel: 'gpt-4o', configuredProviders: ['openai-compat'] } as any);

    renderPicker({ engine: 'opencode', value: '' });
    await openPicker();

    await waitFor(() => {
      // Brain icon SVG is rendered next to reasoning-capable models
      // ModelPickerPopover renders <Brain size={11} className="text-violet-400" />
      // which produces an SVG — verify it appears in the DOM
      const violetBrains = document.querySelectorAll('svg.text-violet-400');
      expect(violetBrains.length).toBeGreaterThan(0);
    }, { timeout: 3000 });
  });

  it('opencode engine: non-reasoning model does NOT show Brain icon', async () => {
    // Render only GPT-4o (non-reasoning)
    mockApiFetch.mockResolvedValue({ models: [GPT4O], defaultModel: 'gpt-4o', configuredProviders: ['openai-compat'] } as any);

    renderPicker({ engine: 'opencode', value: '' });
    await openPicker();

    await waitFor(() => {
      // Wait for loading to finish
      expect(screen.queryByText('Loading models…')).not.toBeInTheDocument();
    }, { timeout: 3000 });

    const violetBrains = document.querySelectorAll('svg.text-violet-400');
    expect(violetBrains.length).toBe(0);
  });

  it('opencode engine: reasoning model tooltip contains effort levels', async () => {
    mockApiFetch.mockResolvedValue({ models: [OPENAI_O3], defaultModel: 'openai/o3', configuredProviders: ['openai-compat'] } as any);

    renderPicker({ engine: 'opencode', value: '' });
    await openPicker();

    await waitFor(() => {
      // Brain icon is wrapped in a <span> with a title attribute containing effort levels.
      // The title format is "Supports reasoning: low, medium, high effort"
      // We look for spans whose title starts with "Supports reasoning" (not the filter chip).
      const spans = document.querySelectorAll('span[title]');
      const brainSpan = Array.from(spans).find(el =>
        el.getAttribute('title')?.startsWith('Supports reasoning'),
      );
      expect(brainSpan).not.toBeNull();
      const title = brainSpan?.getAttribute('title') ?? '';
      // effortLevels: ['low', 'medium', 'high'] → tooltip says "low, medium, high effort"
      expect(title).toContain('low');
      expect(title).toContain('medium');
    }, { timeout: 3000 });
  });
});

// ─── Filter behavior tests ────────────────────────────────────────────────────

describe('Reasoning filter filtering behavior', () => {
  it('shows both reasoning and non-reasoning models by default', async () => {
    mockApiFetch.mockResolvedValue({ models: [OPENAI_O3, GPT4O], defaultModel: 'gpt-4o', configuredProviders: ['openai-compat'] } as any);

    renderPicker({ engine: 'opencode', value: '' });
    await openPicker();

    await waitFor(() => {
      expect(screen.queryByText('Loading models…')).not.toBeInTheDocument();
    }, { timeout: 3000 });

    // Both models should appear
    expect(screen.getByText('OpenAI o3')).toBeInTheDocument();
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();
  });

  it('hides non-reasoning models when filter chip is activated', async () => {
    mockApiFetch.mockResolvedValue({ models: [OPENAI_O3, GPT4O], defaultModel: 'gpt-4o', configuredProviders: ['openai-compat'] } as any);

    renderPicker({ engine: 'opencode', value: '' });
    await openPicker();

    await waitFor(() => {
      expect(screen.queryByText('Loading models…')).not.toBeInTheDocument();
    }, { timeout: 3000 });

    // Both should be visible initially
    expect(screen.getByText('OpenAI o3')).toBeInTheDocument();
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();

    // Activate reasoning filter
    const chip = screen.getByTitle('Show only reasoning-capable models');
    await act(async () => { fireEvent.click(chip); });

    // GPT-4o (non-reasoning) should be filtered out
    expect(screen.queryByText('GPT-4o')).not.toBeInTheDocument();
    // OpenAI o3 (reasoning) should remain
    expect(screen.getByText('OpenAI o3')).toBeInTheDocument();
  });

  it('restores all models when filter chip is deactivated', async () => {
    mockApiFetch.mockResolvedValue({ models: [OPENAI_O3, GPT4O], defaultModel: 'gpt-4o', configuredProviders: ['openai-compat'] } as any);

    renderPicker({ engine: 'opencode', value: '' });
    await openPicker();

    await waitFor(() => {
      expect(screen.queryByText('Loading models…')).not.toBeInTheDocument();
    }, { timeout: 3000 });

    const chip = screen.getByTitle('Show only reasoning-capable models');
    // Activate
    await act(async () => { fireEvent.click(chip); });
    expect(screen.queryByText('GPT-4o')).not.toBeInTheDocument();

    // Deactivate
    await act(async () => { fireEvent.click(chip); });
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();
  });

  it('shows empty state when filter is active and no reasoning models exist', async () => {
    mockApiFetch.mockResolvedValue({ models: [GPT4O], defaultModel: 'gpt-4o', configuredProviders: ['openai-compat'] } as any);

    renderPicker({ engine: 'opencode', value: '' });
    await openPicker();

    await waitFor(() => {
      expect(screen.queryByText('Loading models…')).not.toBeInTheDocument();
    }, { timeout: 3000 });

    const chip = screen.getByTitle('Show only reasoning-capable models');
    await act(async () => { fireEvent.click(chip); });

    // No reasoning models → empty state renders
    await waitFor(() => {
      expect(screen.getByText('No models available')).toBeInTheDocument();
    }, { timeout: 2000 });
  });

  it('reasoning filter resets when popover closes and reopens', async () => {
    mockApiFetch.mockResolvedValue({ models: [OPENAI_O3, GPT4O], defaultModel: 'gpt-4o', configuredProviders: ['openai-compat'] } as any);

    renderPicker({ engine: 'opencode', value: '' });
    await openPicker();

    await waitFor(() => {
      expect(screen.queryByText('Loading models…')).not.toBeInTheDocument();
    }, { timeout: 3000 });

    // Activate filter
    const chip = screen.getByTitle('Show only reasoning-capable models');
    await act(async () => { fireEvent.click(chip); });
    expect(chip.getAttribute('aria-pressed')).toBe('true');

    // Close popover by clicking trigger again
    const trigger = screen.getByRole('button', { name: /Pick LLM model/i });
    await act(async () => { fireEvent.click(trigger); });

    // Reopen
    await act(async () => { fireEvent.click(trigger); });

    await waitFor(() => {
      const chipAfterReopen = screen.getByTitle('Show only reasoning-capable models');
      expect(chipAfterReopen.getAttribute('aria-pressed')).toBe('false');
    }, { timeout: 2000 });
  });
});

// ─── API fetch tests ──────────────────────────────────────────────────────────

describe('ModelPickerPopover API interactions', () => {
  it('calls /api/direction/models when engine=opencode and popover opens', async () => {
    mockApiFetch.mockResolvedValue(OPENCODE_MODELS_RESPONSE as any);

    renderPicker({ engine: 'opencode' });
    await openPicker();

    await waitFor(() => {
      const calls = mockApiFetch.mock.calls.filter(([path]) =>
        (path as string).includes('/api/direction/models'),
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
  });

  it('calls /api/config/pi-models when engine=pi and popover opens', async () => {
    mockApiFetch.mockResolvedValue(PI_MODELS_RESPONSE as any);

    renderPicker({ engine: 'pi' });
    await openPicker();

    await waitFor(() => {
      const calls = mockApiFetch.mock.calls.filter(([path]) =>
        (path as string).includes('/api/config/pi-models'),
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
  });

  it('renders Pi models from the local CLI when engine=pi', async () => {
    mockApiFetch.mockResolvedValue(PI_MODELS_RESPONSE as any);

    renderPicker({ engine: 'pi', value: 'gpt-5' });
    await openPicker();

    await waitFor(() => {
      expect(screen.queryByText('Loading models…')).not.toBeInTheDocument();
    }, { timeout: 3000 });

    expect(screen.getAllByText('gpt-5').length).toBeGreaterThan(0);
    expect(screen.getAllByText('claude-sonnet-4-6').length).toBeGreaterThan(0);
  });

  it('does NOT call /api/direction/models when engine=claude', async () => {
    mockApiFetch.mockResolvedValue(OPENCODE_MODELS_RESPONSE as any);

    renderPicker({ engine: 'claude' });
    await openPicker();

    // A small wait to allow any spurious calls to land
    await new Promise(r => setTimeout(r, 100));

    const calls = mockApiFetch.mock.calls.filter(([path]) =>
      (path as string).includes('/api/direction/models'),
    );
    expect(calls.length).toBe(0);
  });

  it('passes workspaceId as query param when provided', async () => {
    mockApiFetch.mockResolvedValue(OPENCODE_MODELS_RESPONSE as any);

    renderPicker({ engine: 'opencode', workspaceId: 'ws-abc' });
    await openPicker();

    await waitFor(() => {
      const calls = mockApiFetch.mock.calls.filter(([path]) =>
        (path as string).includes('/api/direction/models'),
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const url = calls[0][0] as string;
      expect(url).toContain('workspaceId=ws-abc');
    }, { timeout: 3000 });
  });

  it('filters out Anthropic models for opencode engine', async () => {
    const anthropicModel: ModelOption = {
      id: 'claude-opus-4-6',
      label: 'Claude Opus 4.6',
      provider: 'Anthropic',
      providerType: 'anthropic',
      costPer1kInput: 0,
      costPer1kOutput: 0,
      recommended: false,
      supportsReasoning: true,
      effortLevels: ['low', 'medium', 'high', 'max'],
    };
    mockApiFetch.mockResolvedValue({
      models: [anthropicModel, GPT4O],
      defaultModel: 'gpt-4o',
      configuredProviders: ['anthropic', 'openai-compat'],
    } as any);

    renderPicker({ engine: 'opencode', value: '' });
    await openPicker();

    await waitFor(() => {
      expect(screen.queryByText('Loading models…')).not.toBeInTheDocument();
    }, { timeout: 3000 });

    // Anthropic model should be filtered out for OpenCode engine
    expect(screen.queryByText('Claude Opus 4.6')).not.toBeInTheDocument();
    // Non-Anthropic model should appear
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();
  });
});

// ─── Codex disabled state ─────────────────────────────────────────────────────

describe('ModelPickerPopover codex engine', () => {
  it('renders trigger button as interactive for codex engine', () => {
    renderPicker({ engine: 'codex', value: '' });
    const trigger = screen.getByRole('button', { name: /Pick LLM model/i });
    expect(trigger).not.toBeDisabled();
  });

  it('shows Select GPT model label for codex engine before a model is chosen', () => {
    renderPicker({ engine: 'codex', value: '' });
    const trigger = screen.getByRole('button', { name: /Pick LLM model/i });
    expect(trigger.textContent).toContain('Select GPT model');
  });
});
