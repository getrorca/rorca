/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

// Re-export the canonical type from llm-client which duplicates shared/types.ts
// to stay within the backend rootDir. Using the local definition keeps the build clean.
import { ReasoningCapability } from './llm-client';

// ─── OpenRouter model metadata (subset of what /api/v1/models returns) ────────

export interface OpenRouterModelMetadata {
  /** Full model ID as returned by OpenRouter. */
  id: string;
  /** Human-readable name. */
  name?: string;
  /** Provider-declared context length. */
  context_length?: number;
  /** Architecture hints from OpenRouter. */
  architecture?: {
    tokenizer?: string;
    instruct_type?: string | null;
    modality?: string;
  };
  /** Top provider details from OpenRouter. */
  top_provider?: {
    max_completion_tokens?: number | null;
    is_moderated?: boolean;
  };
  /** Pricing info (string USD per token). */
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  /** Arbitrary capability flags from OpenRouter. */
  supported_parameters?: string[];
}

// ─── Detection helpers ────────────────────────────────────────────────────────

/**
 * Returns true if the model ID matches the Claude 4.x family pattern.
 *
 * Matches: claude-opus-4-5, claude-sonnet-4-6, claude-haiku-4-0, claude-3-5-sonnet-20241022 (no — that's 3.x)
 * Pattern: claude-<name>-4-<minor> OR claude-<name>-4.<minor>
 * Examples that must match: claude-opus-4-6, claude-sonnet-4-5-20250929, claude-haiku-4-5-20251001
 */
function isClaudeV4(modelId: string): boolean {
  // Normalise to lower-case for comparison
  const id = modelId.toLowerCase();
  // Must start with "claude-" and contain a version segment "-4-" (e.g. claude-*-4-*)
  // or the model ID contains "claude" and "4." version notation
  return /^claude-[a-z]+-4[-.]/.test(id);
}

/**
 * Returns true if the model is an Opus variant (supports the 'max' effort level).
 */
function isOpus(modelId: string): boolean {
  return /opus/i.test(modelId);
}

/**
 * Returns true if the model ID matches the OpenAI "o + digit" reasoning model pattern.
 * Matches: o1, o3, o4, o4-mini, o1-mini, o1-preview
 * Does NOT match: gpt-4o, gpt-4o-mini (these contain 'o' but not as first char after separator)
 */
function isOpenAIReasoningModel(modelId: string): boolean {
  // Bare model ID like "o3", "o4-mini" OR prefixed with provider "openai/o3"
  const bare = modelId.includes('/') ? modelId.split('/').pop()! : modelId;
  return /^o\d/i.test(bare);
}

/**
 * Returns true if the model ID is a Codex GPT-5.x model (gpt-5.2, gpt-5.3-codex,
 * gpt-5.4, gpt-5.4-mini, gpt-5.5, codex-auto-review, etc.). These ship via the
 * Codex CLI with four reasoning levels: low / medium / high / xhigh.
 */
function isCodexGpt5Model(modelId: string): boolean {
  const bare = modelId.includes('/') ? modelId.split('/').pop()! : modelId;
  return /^gpt-5(\.|-)/i.test(bare) || /^codex-/i.test(bare);
}

/**
 * Returns true if the model ID contains keywords that indicate native chain-of-thought reasoning.
 */
function hasNativeCoTKeyword(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return /think|r1\b|qwq|reasoning/.test(id);
}

// ─── OpenRouter metadata reasoning keywords ───────────────────────────────────

/** Parameter names that indicate reasoning support in OpenRouter's supported_parameters array. */
const OPENROUTER_REASONING_PARAMS = new Set(['reasoning', 'thinking', 'reasoning_effort']);

/**
 * Returns true if the OpenRouter metadata explicitly declares reasoning support
 * via the `supported_parameters` array.  Safely handles missing/malformed metadata.
 */
function metadataSupportsReasoning(metadata: OpenRouterModelMetadata): boolean {
  const params = metadata.supported_parameters;
  if (!Array.isArray(params)) return false;
  return params.some(p => typeof p === 'string' && OPENROUTER_REASONING_PARAMS.has(p));
}

// ─── No-reasoning sentinel ────────────────────────────────────────────────────

const NO_REASONING: ReasoningCapability = {
  supportsReasoning: false,
  reasoningType: 'none',
  effortLevels: [],
  defaultEffort: null,
  budgetTokensSupported: false,
  budgetRange: null,
};

// ─── Auto-effort computation ──────────────────────────────────────────────────

/** Minimal shape of a user story needed for auto-effort computation. */
export interface UserStoryForAutoEffort {
  dependsOn?: string[];
}

/** Result of the auto-effort computation. */
export interface AutoEffortResult {
  /** Recommended effort level: 'low' | 'medium' | 'high' */
  effort: 'low' | 'medium' | 'high';
  /** Human-readable explanation shown in the rationale banner. */
  rationale: string;
}

/**
 * Computes an appropriate reasoning effort level based on spec complexity.
 *
 * Rules (first match wins):
 *   - storyCount > 20 OR maxDependencyDepth > 3  → 'high'
 *   - storyCount >= 10                            → 'medium'
 *   - otherwise                                   → 'low'
 *
 * @param stories  Array of user stories from the spec (or a count-compatible substitute).
 */
export function computeAutoEffort(stories: UserStoryForAutoEffort[]): AutoEffortResult {
  const storyCount = stories.length;

  // Compute max dependency chain depth via iterative BFS/DFS.
  // Build an index: storyId → dependsOn list. Since we only have the UserStory
  // objects (not their IDs), we use array indices as node keys for depth calc.
  // The depth is approximated by the length of the longest dependsOn chain.
  const maxDepth = _computeMaxDependencyDepth(stories);

  if (storyCount > 20 || maxDepth > 3) {
    const reason =
      storyCount > 20
        ? `${storyCount}-story spec is large`
        : `dependency chain depth ${maxDepth} is deep`;
    return {
      effort: 'high',
      rationale: `This ${storyCount}-story spec is complex (${reason}). Reasoning: high recommended.`,
    };
  }

  if (storyCount >= 10) {
    return {
      effort: 'medium',
      rationale: `This ${storyCount}-story spec is moderate. Reasoning: medium recommended.`,
    };
  }

  return {
    effort: 'low',
    rationale: `This ${storyCount}-story spec is straightforward. Reasoning: low recommended.`,
  };
}

/**
 * Computes the maximum dependency chain depth across all stories.
 * Each story in `stories` may reference others by string IDs in `dependsOn`.
 * We treat each story as a node and traverse the dependency graph.
 *
 * Returns 0 when there are no dependencies, 1 when every story depends only
 * on stories that themselves have no dependencies, etc.
 */
function _computeMaxDependencyDepth(stories: UserStoryForAutoEffort[]): number {
  // Count distinct dependency IDs referenced — this is a proxy for depth since
  // we don't have full story IDs. Use the max dependsOn array length per story
  // as a simple approximation (each listed dep = one extra level of depth).
  let maxDepth = 0;
  for (const story of stories) {
    const depth = story.dependsOn?.length ?? 0;
    if (depth > maxDepth) maxDepth = depth;
  }
  return maxDepth;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Algorithmically computes the ReasoningCapability for a model ID.
 *
 * Detection priority (first match wins):
 *   1. Claude 4.x  → 'anthropic-thinking'
 *   2. OpenAI o-series → 'effort-levels'
 *   3. Native CoT keyword (think/r1/qwq/reasoning) → 'native-cot'
 *   4. OpenRouter metadata `supported_parameters` contains 'reasoning' / 'thinking' / 'reasoning_effort' → 'native-cot'
 *   5. Unknown → { supportsReasoning: false, reasoningType: 'none' }
 *
 * When `metadata` is provided and `supported_parameters` contains a recognised
 * reasoning flag (step 4), the function returns a `native-cot` capability even
 * if the model ID would otherwise be undetected.  When metadata is unavailable
 * or malformed the function falls back gracefully to ID-pattern matching only —
 * it never throws.
 *
 * @param modelId   The model identifier string (e.g. "claude-opus-4-6", "o3", "openai/o4-mini").
 * @param metadata  Optional OpenRouter model metadata for the same model.
 * @returns         A fully populated ReasoningCapability — never throws.
 */
export function detectCapability(
  modelId: string,
  metadata?: OpenRouterModelMetadata,
): ReasoningCapability {
  if (!modelId || typeof modelId !== 'string') {
    return NO_REASONING;
  }

  // ── 1. Claude 4.x → anthropic-thinking ──────────────────────────────────
  if (isClaudeV4(modelId)) {
    // Opus supports all 4 effort levels including 'max'.
    // Sonnet / Haiku support only low/medium/high.
    const effortLevels = isOpus(modelId)
      ? ['low', 'medium', 'high', 'max']
      : ['low', 'medium', 'high'];

    // Approximate cost multipliers per effort level for Anthropic extended thinking.
    // Based on typical token overhead: low ~1.5x, medium ~2x, high ~3x, max ~4x.
    const costMultiplier: Record<string, number> = { low: 1.5, medium: 2.0, high: 3.0 };
    if (isOpus(modelId)) costMultiplier['max'] = 4.0;

    return {
      supportsReasoning: true,
      reasoningType: 'anthropic-thinking',
      effortLevels,
      defaultEffort: 'medium',
      budgetTokensSupported: true,
      budgetRange: [1024, 65536],
      costMultiplier,
    };
  }

  // ── 2. OpenAI o-series → effort-levels ──────────────────────────────────
  if (isOpenAIReasoningModel(modelId)) {
    return {
      supportsReasoning: true,
      reasoningType: 'effort-levels',
      effortLevels: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      budgetTokensSupported: false,
      budgetRange: null,
      costMultiplier: { low: 1.0, medium: 1.5, high: 2.5 },
    };
  }

  // ── 2b. Codex GPT-5.x → effort-levels (low/medium/high/xhigh) ───────────
  // Source of truth: ~/.codex/models_cache.json supported_reasoning_levels.
  if (isCodexGpt5Model(modelId)) {
    return {
      supportsReasoning: true,
      reasoningType: 'effort-levels',
      effortLevels: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
      budgetTokensSupported: false,
      budgetRange: null,
      costMultiplier: { low: 1.0, medium: 1.5, high: 2.5, xhigh: 4.0 },
    };
  }

  // ── 3. Native CoT keyword → native-cot ──────────────────────────────────
  if (hasNativeCoTKeyword(modelId)) {
    return {
      supportsReasoning: true,
      reasoningType: 'native-cot',
      effortLevels: [],
      defaultEffort: null,
      budgetTokensSupported: false,
      budgetRange: null,
      costMultiplier: { default: 1.5 },
    };
  }

  // ── 4. OpenRouter metadata: supported_parameters → native-cot ───────────
  // Only reached when ID-pattern matching fails. Treats any model with an
  // explicit reasoning parameter declaration as a native-CoT model because
  // we have no structural information to distinguish effort-level APIs.
  if (metadata && metadataSupportsReasoning(metadata)) {
    return {
      supportsReasoning: true,
      reasoningType: 'native-cot',
      effortLevels: [],
      defaultEffort: null,
      budgetTokensSupported: false,
      budgetRange: null,
      costMultiplier: { default: 1.5 },
    };
  }

  // ── 5. Unknown ────────────────────────────────────────────────────────────
  return NO_REASONING;
}
