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
 * Returns true if the model ID contains keywords that indicate native chain-of-thought reasoning.
 */
function hasNativeCoTKeyword(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return /think|r1\b|qwq|reasoning/.test(id);
}

// ─── No-reasoning sentinel ────────────────────────────────────────────────────

const NO_REASONING: ReasoningCapability = {
  supportsReasoning: false,
  reasoningType: 'none',
  effortLevels: [],
  defaultEffort: null,
  budgetTokensSupported: false,
  budgetRange: null,
  costMultiplier: 1.0,
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Algorithmically computes the ReasoningCapability for a model ID.
 *
 * Detection priority (first match wins):
 *   1. Claude 4.x  → 'anthropic-thinking'
 *   2. OpenAI o-series → 'effort-levels'
 *   3. Native CoT keyword (think/r1/qwq/reasoning) → 'native-cot'
 *   4. Unknown → { supportsReasoning: false, reasoningType: 'none' }
 *
 * The optional `metadata` parameter (OpenRouter model metadata) is accepted
 * for future extensibility but is not required for current detection paths.
 * When provided it can be used by callers to enrich results.
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

    return {
      supportsReasoning: true,
      reasoningType: 'anthropic-thinking',
      effortLevels,
      defaultEffort: 'medium',
      budgetTokensSupported: true,
      budgetRange: [1024, 65536],
      costMultiplier: 1.0,
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
      costMultiplier: 1.0,
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
      costMultiplier: 1.0,
    };
  }

  // ── 4. Unknown ────────────────────────────────────────────────────────────
  return NO_REASONING;
}
