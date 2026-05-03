/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

// ─── Model Pricing Table ────────────────────────────────────────────────────
//
// Per-token pricing for cost estimation. Prices are USD per single token.
// Override any model's pricing via .rorca/config.json:
//
//   { "orchestration": { "pricing": { "claude-opus-4-6": { "input": 0.000015, "output": 0.000075 } } } }
//
// The config override takes precedence over the built-in table.

import * as fs from 'fs';
import * as path from 'path';

export interface ModelPricing {
  /** USD per input token */
  input: number;
  /** USD per output token */
  output: number;
}

/** Built-in pricing table (USD per token). Updated manually when providers change prices. */
const BUILTIN_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-opus-4-6':   { input: 0.000015,  output: 0.000075 },
  // Temporary: mirror Opus 4.6 pricing until Anthropic publishes a distinct
  // Opus 4.7 rate and Rorca's built-in pricing table is updated.
  'claude-opus-4-7':   { input: 0.000015,  output: 0.000075 },
  'claude-sonnet-4-6': { input: 0.000003,  output: 0.000015 },
  'claude-haiku-4-5-20251001':  { input: 0.0000008, output: 0.000004 },

  // OpenAI
  'gpt-4o':      { input: 0.0000025, output: 0.00001 },
  'gpt-4o-mini': { input: 0.00000015, output: 0.0000006 },
  'o3':          { input: 0.00001,  output: 0.00004 },
  'o3-mini':     { input: 0.0000011, output: 0.0000044 },

  // Google
  'gemini-2.0-flash':   { input: 0.0000001,  output: 0.0000004 },
  'gemini-2.5-pro':     { input: 0.00000125, output: 0.00001 },

  // Aliases (provider/model format used by OpenCode)
  'openai/gpt-4o':       { input: 0.0000025, output: 0.00001 },
  'openai/gpt-4o-mini':  { input: 0.00000015, output: 0.0000006 },
  'openai/o3':           { input: 0.00001,  output: 0.00004 },
  'openai/o3-mini':      { input: 0.0000011, output: 0.0000044 },
  'google/gemini-2.0-flash':  { input: 0.0000001,  output: 0.0000004 },
  'google/gemini-2.5-pro':    { input: 0.00000125, output: 0.00001 },
  'anthropic/claude-opus-4-6':           { input: 0.000015,  output: 0.000075 },
  'anthropic/claude-opus-4-7':           { input: 0.000015,  output: 0.000075 },
  'anthropic/claude-sonnet-4-6':         { input: 0.000003,  output: 0.000015 },
  'anthropic/claude-haiku-4-5-20251001': { input: 0.0000008, output: 0.000004 },
};

/** Cache for config overrides */
let cachedOverrides: Record<string, ModelPricing> | null = null;
let cachedOverridePath: string | null = null;

/**
 * Load pricing overrides from .rorca/config.json → orchestration.pricing.
 * Format: { "model-id": { "input": <usd-per-token>, "output": <usd-per-token> } }
 */
function loadPricingOverrides(cwd?: string): Record<string, ModelPricing> {
  if (!cwd) return {};

  const configPath = path.join(cwd, '.rorca', 'config.json');
  if (configPath === cachedOverridePath && cachedOverrides) {
    return cachedOverrides;
  }

  try {
    if (!fs.existsSync(configPath)) return {};
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const pricing = raw?.orchestration?.pricing;
    if (!pricing || typeof pricing !== 'object') return {};

    const overrides: Record<string, ModelPricing> = {};
    for (const [modelId, vals] of Object.entries(pricing)) {
      const v = vals as Record<string, unknown>;
      if (typeof v?.input === 'number' && typeof v?.output === 'number') {
        overrides[modelId] = { input: v.input, output: v.output };
      }
    }

    cachedOverrides = overrides;
    cachedOverridePath = configPath;
    return overrides;
  } catch {
    return {};
  }
}

/**
 * Get pricing for a model ID. Checks .rorca/config.json overrides first,
 * then falls back to the built-in table. Returns null if model is unknown.
 */
export function getModelPricing(modelId: string, cwd?: string): ModelPricing | null {
  const overrides = loadPricingOverrides(cwd);

  // Check overrides first
  if (overrides[modelId]) return overrides[modelId];

  // Check built-in table
  if (BUILTIN_PRICING[modelId]) return BUILTIN_PRICING[modelId];

  // Try stripping provider prefix: "openai/gpt-4o" → "gpt-4o"
  const slashIdx = modelId.indexOf('/');
  if (slashIdx > 0) {
    const bare = modelId.slice(slashIdx + 1);
    if (overrides[bare]) return overrides[bare];
    if (BUILTIN_PRICING[bare]) return BUILTIN_PRICING[bare];
  }

  return null;
}

/**
 * Calculate cost in USD from token counts and model ID.
 * Returns 0 if model pricing is unknown.
 */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  modelId: string,
  cwd?: string,
): number {
  const pricing = getModelPricing(modelId, cwd);
  if (!pricing) return 0;
  return inputTokens * pricing.input + outputTokens * pricing.output;
}

/** Clear the pricing override cache (useful for tests). */
export function clearPricingCache(): void {
  cachedOverrides = null;
  cachedOverridePath = null;
}

/** Get the full built-in pricing table (for diagnostics / UI display). */
export function getBuiltinPricingTable(): Record<string, ModelPricing> {
  return { ...BUILTIN_PRICING };
}
