/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * RE-006: OpenCode Reasoning Env-Var Injection
 *
 * Integration tests for buildOpenCodeReasoningEnv() — the helper that decides
 * which env vars to pass to an OpenCode child process based on the detected
 * reasoning capability of the selected model.
 *
 * Acceptance criteria:
 *   - effort-levels model + thinkingEnabled → OPENCODE_REASONING_EFFORT set
 *   - anthropic-thinking model + thinkingEnabled → OPENCODE_THINKING_BUDGET set
 *   - reasoning disabled → no extra env vars injected
 *   - reasoningType: 'none' model → no extra env vars injected
 */

import { buildOpenCodeReasoningEnv } from '../execution-engine';

// ─── 1. Effort-levels models (OpenAI o-series) ────────────────────────────────

describe('buildOpenCodeReasoningEnv – effort-levels models', () => {
  const effortModels = ['o3', 'o4-mini', 'openai/o3', 'openai/o4-mini', 'o1', 'o1-mini'];

  test.each(effortModels)(
    '%s + thinkingEnabled=true + effortLevel=medium → OPENCODE_REASONING_EFFORT=medium',
    (model) => {
      const result = buildOpenCodeReasoningEnv(model, true, undefined, 'medium');
      expect(result).toEqual({ OPENCODE_REASONING_EFFORT: 'medium' });
      expect(result).not.toHaveProperty('OPENCODE_THINKING_BUDGET');
    },
  );

  test.each(effortModels)(
    '%s + thinkingEnabled=true + effortLevel=high → OPENCODE_REASONING_EFFORT=high',
    (model) => {
      const result = buildOpenCodeReasoningEnv(model, true, undefined, 'high');
      expect(result).toEqual({ OPENCODE_REASONING_EFFORT: 'high' });
    },
  );

  test.each(effortModels)(
    '%s + thinkingEnabled=true but no effortLevel → no env vars',
    (model) => {
      const result = buildOpenCodeReasoningEnv(model, true, undefined, undefined);
      expect(result).toEqual({});
    },
  );

  test.each(effortModels)(
    '%s + thinkingEnabled=false → no env vars',
    (model) => {
      const result = buildOpenCodeReasoningEnv(model, false, undefined, 'high');
      expect(result).toEqual({});
    },
  );
});

// ─── 2. Anthropic-thinking models (Claude 4.x) ───────────────────────────────

describe('buildOpenCodeReasoningEnv – anthropic-thinking models', () => {
  const anthropicModels = [
    'claude-opus-4-6',
    'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5-20251001',
  ];

  test.each(anthropicModels)(
    '%s + thinkingEnabled=true + thinkingBudget=8192 → OPENCODE_THINKING_BUDGET=8192',
    (model) => {
      const result = buildOpenCodeReasoningEnv(model, true, 8192, undefined);
      expect(result).toEqual({ OPENCODE_THINKING_BUDGET: '8192' });
      expect(result).not.toHaveProperty('OPENCODE_REASONING_EFFORT');
    },
  );

  test.each(anthropicModels)(
    '%s + thinkingEnabled=true + thinkingBudget=1024 → OPENCODE_THINKING_BUDGET=1024',
    (model) => {
      const result = buildOpenCodeReasoningEnv(model, true, 1024, undefined);
      expect(result).toEqual({ OPENCODE_THINKING_BUDGET: '1024' });
    },
  );

  test.each(anthropicModels)(
    '%s + thinkingEnabled=true but no thinkingBudget → no env vars',
    (model) => {
      const result = buildOpenCodeReasoningEnv(model, true, undefined, undefined);
      expect(result).toEqual({});
    },
  );

  test.each(anthropicModels)(
    '%s + thinkingEnabled=true but thinkingBudget=0 → no env vars',
    (model) => {
      const result = buildOpenCodeReasoningEnv(model, true, 0, undefined);
      expect(result).toEqual({});
    },
  );

  test.each(anthropicModels)(
    '%s + thinkingEnabled=false → no env vars',
    (model) => {
      const result = buildOpenCodeReasoningEnv(model, false, 8192, undefined);
      expect(result).toEqual({});
    },
  );
});

// ─── 3. Non-reasoning models → no env vars ───────────────────────────────────

describe('buildOpenCodeReasoningEnv – non-reasoning models', () => {
  const nonReasoningModels = [
    'gpt-4o',
    'gpt-4o-mini',
    'claude-3-5-sonnet-20241022',  // Claude 3.x — not V4
    'mistral-7b',
    'gemini-1.5-pro',
    'llama-3-70b',
  ];

  test.each(nonReasoningModels)(
    '%s + thinkingEnabled=true → no env vars (model has reasoningType none)',
    (model) => {
      const result = buildOpenCodeReasoningEnv(model, true, 8192, 'high');
      expect(result).toEqual({});
    },
  );
});

// ─── 4. Edge cases ────────────────────────────────────────────────────────────

describe('buildOpenCodeReasoningEnv – edge cases', () => {
  test('null model → no env vars', () => {
    expect(buildOpenCodeReasoningEnv(null, true, 8192, 'high')).toEqual({});
  });

  test('thinkingEnabled=undefined → no env vars', () => {
    expect(buildOpenCodeReasoningEnv('o3', undefined, undefined, 'medium')).toEqual({});
  });

  test('native-cot model (deepseek-r1) + thinkingEnabled → no env vars (no effort/budget API)', () => {
    // native-cot models have supportsReasoning=true but no effortLevels/budget
    const result = buildOpenCodeReasoningEnv('deepseek-r1', true, 8192, 'high');
    expect(result).toEqual({});
  });

  test('returns plain object (no prototype pollution)', () => {
    const result = buildOpenCodeReasoningEnv('o3', true, undefined, 'low');
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result).toEqual({ OPENCODE_REASONING_EFFORT: 'low' });
  });

  test('effort-levels model with effortLevel=low → OPENCODE_REASONING_EFFORT=low', () => {
    const result = buildOpenCodeReasoningEnv('o1', true, undefined, 'low');
    expect(result).toEqual({ OPENCODE_REASONING_EFFORT: 'low' });
  });

  test('anthropic-thinking model ignores effortLevel (budget wins)', () => {
    // When both thinkingBudget and effortLevel are provided for an anthropic model,
    // only OPENCODE_THINKING_BUDGET should be set (not OPENCODE_REASONING_EFFORT).
    const result = buildOpenCodeReasoningEnv('claude-opus-4-6', true, 16384, 'high');
    expect(result).toEqual({ OPENCODE_THINKING_BUDGET: '16384' });
    expect(result).not.toHaveProperty('OPENCODE_REASONING_EFFORT');
  });
});
