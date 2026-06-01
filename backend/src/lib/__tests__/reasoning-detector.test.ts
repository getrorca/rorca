/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { detectCapability, OpenRouterModelMetadata } from '../reasoning-detector';
import type { ReasoningCapability } from '../llm-client';

// ─── Helper ───────────────────────────────────────────────────────────────────

function cap(modelId: string, metadata?: OpenRouterModelMetadata): ReasoningCapability {
  return detectCapability(modelId, metadata);
}

// ─── 1. Claude 4.x → anthropic-thinking ──────────────────────────────────────

describe('Claude 4.x models → anthropic-thinking', () => {
  const opusModels = [
    'claude-opus-4-6',
    'claude-opus-4-5-20250929',
    'claude-opus-4-0',
  ];

  const nonOpusModels = [
    'claude-sonnet-4-5-20250929',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
  ];

  test.each(opusModels)('%s → reasoningType anthropic-thinking with max effort', (id) => {
    const result = cap(id);
    expect(result.supportsReasoning).toBe(true);
    expect(result.reasoningType).toBe('anthropic-thinking');
    expect(result.effortLevels).toEqual(['low', 'medium', 'high', 'max']);
    expect(result.defaultEffort).toBe('medium');
    expect(result.budgetTokensSupported).toBe(true);
    expect(result.budgetRange).toEqual([1024, 65536]);
  });

  test.each(nonOpusModels)('%s → reasoningType anthropic-thinking without max effort', (id) => {
    const result = cap(id);
    expect(result.supportsReasoning).toBe(true);
    expect(result.reasoningType).toBe('anthropic-thinking');
    expect(result.effortLevels).toEqual(['low', 'medium', 'high']);
    expect(result.effortLevels).not.toContain('max');
    expect(result.budgetTokensSupported).toBe(true);
    expect(result.budgetRange).toEqual([1024, 65536]);
  });

  test('budgetRange min is 1024 and max is 65536', () => {
    const result = cap('claude-sonnet-4-6');
    expect(result.budgetRange![0]).toBe(1024);
    expect(result.budgetRange![1]).toBe(65536);
  });

  test('Claude 3.x models are NOT matched (no 4-)', () => {
    const result = cap('claude-3-5-sonnet-20241022');
    expect(result.reasoningType).not.toBe('anthropic-thinking');
  });
});

// ─── 2. OpenAI o-series → effort-levels ──────────────────────────────────────

describe('OpenAI o-series models → effort-levels', () => {
  const oModels = [
    'o1',
    'o3',
    'o4-mini',
    'o1-mini',
    'o1-preview',
    'openai/o3',
    'openai/o4-mini',
  ];

  test.each(oModels)('%s → reasoningType effort-levels', (id) => {
    const result = cap(id);
    expect(result.supportsReasoning).toBe(true);
    expect(result.reasoningType).toBe('effort-levels');
    expect(result.effortLevels).toEqual(['low', 'medium', 'high']);
    expect(result.defaultEffort).toBe('medium');
    expect(result.budgetTokensSupported).toBe(false);
    expect(result.budgetRange).toBeNull();
  });

  test('gpt-4o is NOT matched as o-series (starts with g)', () => {
    const result = cap('gpt-4o');
    expect(result.reasoningType).not.toBe('effort-levels');
  });

  test('gpt-4o-mini is NOT matched as o-series', () => {
    const result = cap('gpt-4o-mini');
    expect(result.reasoningType).not.toBe('effort-levels');
  });
});

// ─── 3. Native CoT keyword models → native-cot ───────────────────────────────

describe('Native CoT keyword models → native-cot', () => {
  const nativeCoTModels = [
    'deepseek/deepseek-r1',
    'deepseek-r1-distill-qwen-32b',
    'qwq-32b-preview',
    'qwen/qwq-32b',
    'gemini-2.0-flash-thinking-exp',
    'thinking-llama-70b',
    'some-reasoning-model',
  ];

  test.each(nativeCoTModels)('%s → reasoningType native-cot', (id) => {
    const result = cap(id);
    expect(result.supportsReasoning).toBe(true);
    expect(result.reasoningType).toBe('native-cot');
    expect(result.effortLevels).toEqual([]);
    expect(result.defaultEffort).toBeNull();
    expect(result.budgetTokensSupported).toBe(false);
    expect(result.budgetRange).toBeNull();
  });
});

// ─── 4. Unknown models → none ────────────────────────────────────────────────

describe('Unknown models → no reasoning capability', () => {
  const unknownModels = [
    'gpt-4o',
    'gpt-4-turbo',
    'claude-3-5-sonnet-20241022',
    'claude-2.1',
    'llama-3-70b-instruct',
    'mistral-7b',
    'gemini-1.5-pro',
    'anthropic/claude-3-haiku',
  ];

  test.each(unknownModels)('%s → supportsReasoning false', (id) => {
    const result = cap(id);
    expect(result.supportsReasoning).toBe(false);
    expect(result.reasoningType).toBe('none');
    expect(result.effortLevels).toEqual([]);
    expect(result.defaultEffort).toBeNull();
    expect(result.budgetTokensSupported).toBe(false);
    expect(result.budgetRange).toBeNull();
  });

  test('never throws on empty string', () => {
    expect(() => cap('')).not.toThrow();
    expect(cap('')).toMatchObject({ supportsReasoning: false, reasoningType: 'none' });
  });

  test('never throws on nonsense input', () => {
    expect(() => cap('!!??##')).not.toThrow();
    expect(cap('!!??##')).toMatchObject({ supportsReasoning: false });
  });
});

// ─── 5. metadata parameter accepted without error ────────────────────────────

describe('metadata parameter', () => {
  test('accepted without error for known model', () => {
    const meta: OpenRouterModelMetadata = {
      id: 'claude-opus-4-6',
      name: 'Claude Opus 4.6',
      context_length: 200000,
    };
    expect(() => cap('claude-opus-4-6', meta)).not.toThrow();
  });

  test('accepted without error for unknown model', () => {
    const meta: OpenRouterModelMetadata = { id: 'unknown-model-xyz' };
    expect(() => cap('unknown-model-xyz', meta)).not.toThrow();
    expect(cap('unknown-model-xyz', meta).supportsReasoning).toBe(false);
  });
});

// ─── 6. OpenRouter metadata supported_parameters → reasoning detection ────────

describe('OpenRouter metadata supported_parameters', () => {
  test('model with supported_parameters: ["reasoning"] → supportsReasoning true', () => {
    const meta: OpenRouterModelMetadata = {
      id: 'some-provider/unknown-model-v1',
      name: 'Unknown Reasoning Model',
      context_length: 32000,
      supported_parameters: ['reasoning'],
    };
    const result = cap('some-provider/unknown-model-v1', meta);
    expect(result.supportsReasoning).toBe(true);
    expect(result.reasoningType).toBe('native-cot');
  });

  test('model with supported_parameters: ["thinking"] → supportsReasoning true', () => {
    const meta: OpenRouterModelMetadata = {
      id: 'some-provider/model-with-thinking',
      supported_parameters: ['thinking'],
    };
    const result = cap('some-provider/model-with-thinking', meta);
    expect(result.supportsReasoning).toBe(true);
    expect(result.reasoningType).toBe('native-cot');
  });

  test('model with supported_parameters: ["reasoning_effort"] → supportsReasoning true', () => {
    const meta: OpenRouterModelMetadata = {
      id: 'some-provider/effort-model',
      supported_parameters: ['temperature', 'max_tokens', 'reasoning_effort'],
    };
    const result = cap('some-provider/effort-model', meta);
    expect(result.supportsReasoning).toBe(true);
    expect(result.reasoningType).toBe('native-cot');
  });

  test('model with supported_parameters not containing reasoning keywords → supportsReasoning false', () => {
    const meta: OpenRouterModelMetadata = {
      id: 'some-provider/plain-model',
      supported_parameters: ['temperature', 'max_tokens', 'top_p'],
    };
    const result = cap('some-provider/plain-model', meta);
    expect(result.supportsReasoning).toBe(false);
    expect(result.reasoningType).toBe('none');
  });

  test('model with supported_parameters: [] (empty array) → supportsReasoning false', () => {
    const meta: OpenRouterModelMetadata = {
      id: 'some-provider/no-params-model',
      supported_parameters: [],
    };
    const result = cap('some-provider/no-params-model', meta);
    expect(result.supportsReasoning).toBe(false);
  });

  test('model with supported_parameters missing entirely → supportsReasoning false', () => {
    const meta: OpenRouterModelMetadata = {
      id: 'some-provider/no-meta-params',
      name: 'No Params Model',
    };
    const result = cap('some-provider/no-meta-params', meta);
    expect(result.supportsReasoning).toBe(false);
  });

  test('ID-pattern detection takes priority over metadata for Claude 4.x', () => {
    // Claude 4.x detected by ID → anthropic-thinking, regardless of metadata
    const meta: OpenRouterModelMetadata = {
      id: 'claude-sonnet-4-6',
      supported_parameters: ['reasoning'],
    };
    const result = cap('claude-sonnet-4-6', meta);
    expect(result.reasoningType).toBe('anthropic-thinking');
    expect(result.supportsReasoning).toBe(true);
  });

  test('ID-pattern detection takes priority over metadata for OpenAI o-series', () => {
    const meta: OpenRouterModelMetadata = {
      id: 'openai/o3',
      supported_parameters: ['reasoning'],
    };
    const result = cap('openai/o3', meta);
    expect(result.reasoningType).toBe('effort-levels');
  });

  test('metadata fallback does not throw when metadata is malformed (non-array supported_parameters)', () => {
    const meta = {
      id: 'some-model',
      supported_parameters: 'reasoning' as unknown as string[],
    } as OpenRouterModelMetadata;
    expect(() => cap('some-model', meta)).not.toThrow();
    expect(cap('some-model', meta).supportsReasoning).toBe(false);
  });
});
