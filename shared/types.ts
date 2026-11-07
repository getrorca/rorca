// ─── Reasoning Engine Types ───────────────────────────────────────────────────

/**
 * Discriminated union of reasoning mechanism types.
 *
 * - 'anthropic-thinking': Claude extended thinking (budget_tokens, effort levels low/medium/high/max).
 *   Opus 4.6 supports all 4 effort levels; Sonnet 4.6 supports low/medium/high only (not 'max').
 * - 'effort-levels': OpenRouter / OpenAI models that accept an effort parameter (e.g. o3, GLM-5).
 * - 'native-cot': Model reasons natively without explicit control (e.g. Gemini Flash Thinking).
 * - 'none': Model has no reasoning capability.
 */
export type ReasoningType = 'anthropic-thinking' | 'effort-levels' | 'native-cot' | 'none';

/**
 * Describes the reasoning capability of a model, as returned by the
 * GET /api/direction/models endpoint and used by ThinkingControls UI.
 */
export interface ReasoningCapability {
  /** Whether this model supports any form of reasoning/thinking. */
  supportsReasoning: boolean;
  /** Which reasoning mechanism the model uses. */
  reasoningType: ReasoningType;
  /**
   * The effort level strings accepted by this model.
   * Empty array when reasoningType is 'none' or 'native-cot'.
   * For 'anthropic-thinking': ['low', 'medium', 'high'] for Sonnet,
   *   ['low', 'medium', 'high', 'max'] for Opus.
   * For 'effort-levels': provider-specific (e.g. ['low', 'medium', 'high']).
   */
  effortLevels: string[];
  /**
   * The default effort level to pre-select in UI.
   * null when reasoningType is 'none' or 'native-cot'.
   */
  defaultEffort: string | null;
  /**
   * Whether the model accepts an explicit token budget for reasoning.
   * true for 'anthropic-thinking', false for all others.
   */
  budgetTokensSupported: boolean;
  /**
   * Valid [min, max] range for budgetTokens when budgetTokensSupported is true.
   * null when budgetTokensSupported is false.
   */
  budgetRange: [number, number] | null;
  /**
   * Approximate cost multiplier relative to the base model price when
   * reasoning is enabled, keyed by effort level (e.g. { low: 1.5, medium: 2.0, high: 3.0, max: 4.0 }).
   * When the model has no effort levels (native-cot), keyed by 'default'.
   * undefined when reasoningType is 'none'.
   * Informational only — used in FinOps display and Forge cost impact labels.
   */
  costMultiplier?: Record<string, number>;
}

// ─── Chat / Execution Reasoning Options ──────────────────────────────────────

/**
 * Reasoning options that can be attached to a pipeline trigger request,
 * a spec JSON, or a story. These flow into the execution engine and are
 * translated into provider-specific API parameters by llm-client.ts.
 */
export interface ReasoningOptions {
  /** Whether reasoning/thinking is enabled for this run or story. */
  enabled: boolean;
  /**
   * Effort level string. Only meaningful when the model supports effort levels
   * ('anthropic-thinking' or 'effort-levels' reasoning types).
   * Must be one of the values in ReasoningCapability.effortLevels for the model.
   */
  effort?: string;
  /**
   * Explicit token budget for thinking blocks (anthropic-thinking only).
   * Must be within ReasoningCapability.budgetRange when provided.
   */
  budgetTokens?: number;
}

// ─── Spec JSON reasoning field (stored in spec JSON files) ───────────────────

/**
 * Per-spec reasoning config stored in the spec JSON on disk.
 * Subset of ReasoningOptions — budgetTokens is omitted from stored specs
 * because it is computed from effort level at run time.
 */
export interface SpecReasoningConfig {
  /** Whether reasoning is enabled for all stories in this spec by default. */
  enabled: boolean;
  /**
   * Default effort level for this spec. Stories may override.
   * When omitted, the model's defaultEffort is used.
   */
  effort?: string;
}
