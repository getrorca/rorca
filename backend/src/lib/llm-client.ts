import { spawn } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { logger } from './logger';

// ─── Provider Types ──────────────────────────────────────────────────────────

export type ProviderType = 'claude-cli' | 'anthropic' | 'openai-compat' | 'openrouter';

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
   * reasoning is enabled (e.g. 1.0 means same cost, 1.5 means 50% more).
   * Informational only — used in FinOps display.
   */
  costMultiplier: number;
}

/**
 * Reasoning options that can be attached to a pipeline trigger request,
 * a spec JSON, or a story. These flow into the execution engine and are
 * translated into provider-specific API parameters by llm-client.ts.
 */
export interface ReasoningOptions {
  /** Whether reasoning/thinking is enabled for this run or story. */
  enabled: boolean;
  /**
   * Effort level string. Only meaningful when the model supports effort levels.
   * Must be one of the values in ReasoningCapability.effortLevels for the model.
   */
  effort?: string;
  /**
   * Explicit token budget for thinking blocks (anthropic-thinking only).
   * Must be within ReasoningCapability.budgetRange when provided.
   */
  budgetTokens?: number;
}

export interface ChatMessage { role: 'user' | 'assistant'; content: string; }

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  usage: TokenUsage;
}

/** OpenRouter provider routing preferences. */
export interface OpenRouterProviderPrefs {
  order?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
}

export interface ChatOptions {
  model?: string;
  apiKey?: string;
  provider?: ProviderType;
  baseUrl?: string;
  /** Enable extended thinking for Anthropic models. */
  thinking?: { type: 'enabled'; budgetTokens: number };
  /** Override default max_tokens (16384). When thinking is enabled, increase this. */
  maxTokens?: number;
  /** OpenRouter provider routing preferences (order, ignore, allow_fallbacks). */
  openRouterProvider?: OpenRouterProviderPrefs;
  /**
   * Unified reasoning options. Supersedes the legacy `thinking` field for new callers.
   * When both are present, `reasoning` takes precedence.
   * Translated to provider-specific params by each chatComplete* function:
   *   - anthropic: → extended_thinking block with budget_tokens
   *   - openrouter: → reasoning.effort param
   *   - openai-compat: → ignored (model reasons natively or not at all)
   */
  reasoning?: ReasoningOptions;
}

// ─── Model Registry ──────────────────────────────────────────────────────────

/** Speed classification for model selection UI. */
export type SpeedTier = 'fast' | 'medium' | 'slow';

/** Cost classification for model selection UI. */
export type CostTier = 'free' | 'low' | 'medium' | 'high' | 'premium';

/** Models available per provider. `providerType` links to routing logic. */
export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  providerType: ProviderType;
  costPer1kInput: number;
  costPer1kOutput: number;
  contextWindow: number;
  speedTier: SpeedTier;
  costTier: CostTier;
  /** Whether this model supports reasoning/thinking. */
  supportsReasoning?: boolean;
  /** Effort levels supported (e.g. ['low', 'medium', 'high', 'max']). */
  effortLevels?: string[];
  /**
   * Raw OpenRouter metadata (supported_parameters etc.) for reasoning detection.
   * Populated only for OpenRouter-sourced models.
   */
  metadata?: { supported_parameters?: string[] };
}

/** All known models across providers. */
export const ALL_MODELS: ModelInfo[] = [
  // ── Anthropic (claude-cli or anthropic SDK) ──
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    provider: 'Anthropic',
    providerType: 'anthropic',
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    contextWindow: 200000,
    speedTier: 'medium',
    costTier: 'medium',
  },
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    provider: 'Anthropic',
    providerType: 'anthropic',
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
    contextWindow: 200000,
    speedTier: 'slow',
    costTier: 'premium',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    provider: 'Anthropic',
    providerType: 'anthropic',
    costPer1kInput: 0.0008,
    costPer1kOutput: 0.004,
    contextWindow: 200000,
    speedTier: 'fast',
    costTier: 'low',
  },
  // ── OpenAI-compat (covers OpenAI, Groq, Together, DeepSeek, Mistral, Ollama) ──
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    provider: 'OpenAI',
    providerType: 'openai-compat',
    costPer1kInput: 0.0025,
    costPer1kOutput: 0.01,
    contextWindow: 128000,
    speedTier: 'medium',
    costTier: 'medium',
  },
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o Mini',
    provider: 'OpenAI',
    providerType: 'openai-compat',
    costPer1kInput: 0.00015,
    costPer1kOutput: 0.0006,
    contextWindow: 128000,
    speedTier: 'fast',
    costTier: 'low',
  },
  {
    id: 'deepseek-chat',
    label: 'DeepSeek V3',
    provider: 'DeepSeek',
    providerType: 'openai-compat',
    costPer1kInput: 0.00027,
    costPer1kOutput: 0.0011,
    contextWindow: 128000,
    speedTier: 'medium',
    costTier: 'low',
  },
  {
    id: 'deepseek-reasoner',
    label: 'DeepSeek R1',
    provider: 'DeepSeek',
    providerType: 'openai-compat',
    costPer1kInput: 0.00055,
    costPer1kOutput: 0.0022,
    contextWindow: 128000,
    speedTier: 'slow',
    costTier: 'low',
  },
  // ── Groq ──
  {
    id: 'llama-3.3-70b-versatile',
    label: 'Llama 3.3 70B',
    provider: 'Groq',
    providerType: 'openai-compat',
    costPer1kInput: 0.00059,
    costPer1kOutput: 0.00079,
    contextWindow: 128000,
    speedTier: 'fast',
    costTier: 'low',
  },
  {
    id: 'gemma2-9b-it',
    label: 'Gemma 2 9B',
    provider: 'Groq',
    providerType: 'openai-compat',
    costPer1kInput: 0.0002,
    costPer1kOutput: 0.0002,
    contextWindow: 8192,
    speedTier: 'fast',
    costTier: 'free',
  },
  // ── Together AI ──
  {
    id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    label: 'Llama 3.3 70B (Together)',
    provider: 'Together AI',
    providerType: 'openai-compat',
    costPer1kInput: 0.00088,
    costPer1kOutput: 0.00088,
    contextWindow: 128000,
    speedTier: 'fast',
    costTier: 'low',
  },
  // ── Fireworks ──
  {
    id: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    label: 'Llama 3.3 70B (Fireworks)',
    provider: 'Fireworks',
    providerType: 'openai-compat',
    costPer1kInput: 0.0009,
    costPer1kOutput: 0.0009,
    contextWindow: 128000,
    speedTier: 'fast',
    costTier: 'low',
  },
  // ── Mistral ──
  {
    id: 'mistral-large-latest',
    label: 'Mistral Large',
    provider: 'Mistral',
    providerType: 'openai-compat',
    costPer1kInput: 0.002,
    costPer1kOutput: 0.006,
    contextWindow: 128000,
    speedTier: 'medium',
    costTier: 'medium',
  },
  {
    id: 'codestral-latest',
    label: 'Codestral',
    provider: 'Mistral',
    providerType: 'openai-compat',
    costPer1kInput: 0.0003,
    costPer1kOutput: 0.0009,
    contextWindow: 256000,
    speedTier: 'fast',
    costTier: 'low',
  },
  // ── Cerebras ──
  {
    id: 'llama-3.3-70b',
    label: 'Llama 3.3 70B (Cerebras)',
    provider: 'Cerebras',
    providerType: 'openai-compat',
    costPer1kInput: 0.00085,
    costPer1kOutput: 0.00085,
    contextWindow: 128000,
    speedTier: 'fast',
    costTier: 'low',
  },
  // ── Perplexity ──
  {
    id: 'sonar-pro',
    label: 'Sonar Pro',
    provider: 'Perplexity',
    providerType: 'openai-compat',
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    contextWindow: 200000,
    speedTier: 'medium',
    costTier: 'medium',
  },
  // ── OpenRouter (covers Gemini, Grok, and any other outlier) ──
  {
    id: 'google/gemini-2.5-pro-preview',
    label: 'Gemini 2.5 Pro',
    provider: 'Google',
    providerType: 'openrouter',
    costPer1kInput: 0.00125,
    costPer1kOutput: 0.01,
    contextWindow: 1000000,
    speedTier: 'medium',
    costTier: 'medium',
  },
  {
    id: 'google/gemini-2.5-flash-preview',
    label: 'Gemini 2.5 Flash',
    provider: 'Google',
    providerType: 'openrouter',
    costPer1kInput: 0.00015,
    costPer1kOutput: 0.0006,
    contextWindow: 1000000,
    speedTier: 'fast',
    costTier: 'low',
  },
  {
    id: 'x-ai/grok-3',
    label: 'Grok 3',
    provider: 'xAI',
    providerType: 'openrouter',
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    contextWindow: 131072,
    speedTier: 'medium',
    costTier: 'medium',
  },
];

// ── Backward-compat aliases ──

/**
 * Legacy SUPPORTED_MODELS — Anthropic-only model IDs for backward compat.
 * New code should use ALL_MODELS and filter by providerType.
 */
export const SUPPORTED_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-haiku-4-5-20251001',
] as const;

export type SupportedModel = typeof SUPPORTED_MODELS[number];

export const DEFAULT_MODEL: SupportedModel = 'claude-sonnet-4-6';

/**
 * Backward-compat MODEL_INFO keyed by SupportedModel.
 * New code should use ALL_MODELS instead.
 */
export const MODEL_INFO: Record<SupportedModel, ModelInfo> = {
  'claude-sonnet-4-6': ALL_MODELS.find(m => m.id === 'claude-sonnet-4-6')!,
  'claude-opus-4-6': ALL_MODELS.find(m => m.id === 'claude-opus-4-6')!,
  'claude-haiku-4-5-20251001': ALL_MODELS.find(m => m.id === 'claude-haiku-4-5-20251001')!,
};

/** Check if model ID exists in the full registry. */
export function isValidModel(model: string): model is SupportedModel {
  return ALL_MODELS.some(m => m.id === model) ||
    (SUPPORTED_MODELS as readonly string[]).includes(model);
}

/** Get ModelInfo for any registered model. */
export function getModelInfo(modelId: string): ModelInfo | undefined {
  return ALL_MODELS.find(m => m.id === modelId);
}

/** Get available models filtered to a set of configured providers. */
export function getModelsForProviders(providers: ProviderType[]): ModelInfo[] {
  return ALL_MODELS.filter(m =>
    providers.includes(m.providerType) ||
    // claude-cli can use all Anthropic models
    (providers.includes('claude-cli') && m.providerType === 'anthropic')
  );
}

// ─── Provider Resolution ─────────────────────────────────────────────────────

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Resolve which provider to use. Priority:
 * 1. Explicit `opts.provider` param
 * 2. Infer from model registry (look up providerType)
 * 3. If baseUrl is set, assume 'openai-compat' (custom endpoint)
 * 4. If apiKey provided but model is unknown, assume 'openai-compat' (pass-through)
 * 5. If apiKey provided and no model, assume 'anthropic' (backward compat)
 * 6. Default: 'claude-cli'
 */
function resolveProvider(opts: ChatOptions): ProviderType {
  if (opts.provider) return opts.provider;

  if (opts.model) {
    const info = getModelInfo(opts.model);
    if (info) {
      // Anthropic models can be served by claude-cli when no API key
      if (info.providerType === 'anthropic' && !opts.apiKey) return 'claude-cli';
      return info.providerType;
    }
    // Model not in registry — custom/pass-through model
    if (opts.baseUrl) return 'openai-compat';
    if (opts.apiKey) return 'openai-compat';
  }

  // Backward compat: apiKey without provider or model = anthropic
  if (opts.apiKey) return 'anthropic';

  return 'claude-cli';
}

// ─── Claude CLI ──────────────────────────────────────────────────────────────

const CLAUDE_BIN = process.env.CLAUDE_BIN ||
  '/Users/dimitriteravanessian/.nvm/versions/node/v20.19.6/bin/claude';

const CLAUDE_ENV_VARS_TO_REMOVE = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
];

function chatCompleteCLI(messages: ChatMessage[], model?: string): Promise<ChatResult> {
  const prompt = messages.length === 1
    ? messages[0].content
    : messages.map(m =>
        m.role === 'user' ? m.content : `[Previous response: ${m.content}]`
      ).join('\n\n---\n\n');

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !CLAUDE_ENV_VARS_TO_REMOVE.includes(k)) {
      env[k] = v;
    }
  }

  return new Promise((resolve, reject) => {
    const args = [
      '--dangerously-skip-permissions',
      '--print',
      '--output-format', 'json',
    ];
    if (model) {
      args.push('--model', model);
    }
    args.push(prompt);

    const child = spawn(CLAUDE_BIN, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    child.on('close', (code) => {
      if (stderr) logger.warn({ stderr: stderr.slice(0, 500) }, '[LLM] claude stderr');
      if (code !== 0) {
        const detail = stderr.slice(0, 300) || stdout.slice(0, 300);
        reject(new Error(`claude exited with code ${code}. detail: ${detail}`));
        return;
      }
      if (!stdout.trim()) {
        reject(new Error(`claude returned empty output. stderr: ${stderr.slice(0, 300)}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        const text = parsed.result ?? parsed.text ?? stdout.trim();
        const usage: TokenUsage = {
          inputTokens: parsed.input_tokens ?? parsed.usage?.input_tokens ?? 0,
          outputTokens: parsed.output_tokens ?? parsed.usage?.output_tokens ?? 0,
        };
        resolve({ text: typeof text === 'string' ? text : JSON.stringify(text), usage });
      } catch {
        resolve({ text: stdout.trim(), usage: { inputTokens: 0, outputTokens: 0 } });
      }
    });
  });
}

// ─── Anthropic SDK ───────────────────────────────────────────────────────────

/** Maps effort level strings to Anthropic thinking budget_tokens values. */
const ANTHROPIC_EFFORT_BUDGET: Record<string, number> = {
  low: 4096,
  medium: 16384,
  high: 32768,
  max: 32768, // same cap as high for budget; 'max' is a quality signal, not a token limit
};

async function chatCompleteAnthropic(
  messages: ChatMessage[],
  model: string,
  apiKey: string,
  opts?: Pick<ChatOptions, 'thinking' | 'maxTokens' | 'reasoning'>,
): Promise<ChatResult> {
  const client = new Anthropic({ apiKey });
  const maxTokens = opts?.maxTokens ?? 16384;

  const createParams: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  };

  // `reasoning` takes precedence over legacy `thinking` field.
  const reasoningOpts = opts?.reasoning;
  if (reasoningOpts?.enabled) {
    const budgetTokens = reasoningOpts.budgetTokens
      ?? ANTHROPIC_EFFORT_BUDGET[reasoningOpts.effort ?? 'medium']
      ?? ANTHROPIC_EFFORT_BUDGET.medium;
    createParams.thinking = {
      type: 'enabled',
      budget_tokens: budgetTokens,
    };
    // max_tokens must be > budget_tokens
    if ((createParams.max_tokens as number) <= budgetTokens) {
      createParams.max_tokens = budgetTokens + 16384;
    }
  } else if (opts?.thinking) {
    createParams.thinking = {
      type: 'enabled',
      budget_tokens: opts.thinking.budgetTokens,
    };
    // When thinking is enabled, max_tokens must be > budget_tokens
    if (maxTokens <= opts.thinking.budgetTokens) {
      createParams.max_tokens = opts.thinking.budgetTokens + 16384;
    }
  }

  const response = await client.messages.create(createParams as unknown as Parameters<typeof client.messages.create>[0]) as Anthropic.Message;

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b: Anthropic.TextBlock) => b.text)
    .join('');

  return {
    text,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

// ─── OpenAI-compatible (OpenAI, Groq, Together, DeepSeek, Mistral, Ollama) ──

/** OpenAI o-series reasoning model pattern. */
const OPENAI_REASONING_MODEL_RE = /^o\d/i;

async function chatCompleteOpenAICompat(
  messages: ChatMessage[],
  model: string,
  apiKey: string,
  baseUrl?: string,
  opts?: Pick<ChatOptions, 'maxTokens' | 'reasoning'>,
): Promise<ChatResult> {
  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl || 'https://api.openai.com/v1',
  });

  const createParams: Record<string, unknown> = {
    model,
    messages: messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    max_tokens: opts?.maxTokens ?? 16384,
  };

  // Inject reasoning_effort for OpenAI o-series models that support it.
  const reasoningOpts = opts?.reasoning;
  if (reasoningOpts?.enabled && reasoningOpts.effort && OPENAI_REASONING_MODEL_RE.test(model)) {
    createParams.reasoning_effort = reasoningOpts.effort;
  }

  const response = await client.chat.completions.create(createParams as unknown as Parameters<typeof client.chat.completions.create>[0]) as OpenAI.ChatCompletion;

  const text = response.choices[0]?.message?.content ?? '';
  const usage = response.usage;

  return {
    text,
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
    },
  };
}

// ─── OpenRouter ──────────────────────────────────────────────────────────────

/** Built-in OpenRouter provider routing defaults for models with known provider issues. */
const GLM5_PREFS: OpenRouterProviderPrefs = { order: ['DeepInfra', 'SiliconFlow', 'AtlasCloud'], ignore: ['Ambient'], allow_fallbacks: true };
const OPENROUTER_PROVIDER_DEFAULTS: Record<string, OpenRouterProviderPrefs> = {
  // GLM-5 base: Ambient caps at 80K; prefer full-context providers for full 200K
  'z-ai/glm-5': GLM5_PREFS,
};

/**
 * Context window overrides for models where OpenRouter reports the wrong value
 * (usually because the cheapest provider has a lower cap than the model supports).
 * Only override models that are KNOWN to report wrong values — turbo variants are fine.
 */
const CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
  'z-ai/glm-5': 200000,
};

async function chatCompleteOpenRouter(
  messages: ChatMessage[],
  model: string,
  apiKey: string,
  opts?: Pick<ChatOptions, 'maxTokens' | 'openRouterProvider' | 'reasoning'>,
): Promise<ChatResult> {
  const client = new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: {
      'HTTP-Referer': 'https://rorca.dev',
      'X-Title': 'Rorca',
    },
  });

  // Merge: explicit opts > DB-stored prefs (passed via opts) > built-in defaults > nothing
  const builtInPrefs = OPENROUTER_PROVIDER_DEFAULTS[model];
  const providerPrefs = opts?.openRouterProvider ?? builtInPrefs;

  const createParams: Record<string, unknown> = {
    model,
    messages: messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    max_tokens: opts?.maxTokens ?? 16384,
  };

  if (providerPrefs) {
    createParams.provider = providerPrefs;
  }

  // Pass through reasoning options when explicitly requested.
  // Only set when reasoning.enabled is true — avoids sending reasoning: {} to models that don't support it.
  const reasoningOpts = opts?.reasoning;
  if (reasoningOpts?.enabled && reasoningOpts.effort) {
    createParams.reasoning = { effort: reasoningOpts.effort };
  }

  const response = await client.chat.completions.create(createParams as unknown as Parameters<typeof client.chat.completions.create>[0]) as OpenAI.ChatCompletion;

  const text = response.choices[0]?.message?.content ?? '';
  const usage = response.usage;

  return {
    text,
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * Fetch the full model catalog from OpenRouter's /api/v1/models endpoint.
 * Returns a list of ModelInfo objects.
 */
export async function fetchOpenRouterModels(apiKey: string): Promise<ModelInfo[]> {
  const res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://rorca.dev',
      'X-Title': 'Rorca',
    },
  });

  if (!res.ok) {
    throw new Error(`OpenRouter /models returned ${res.status}: ${await res.text().catch(() => 'unknown')}`);
  }

  const body = await res.json() as {
    data: Array<{
      id: string;
      name: string;
      context_length?: number;
      pricing?: { prompt?: string; completion?: string };
      supported_parameters?: string[];
    }>;
  };

  return body.data.map(m => {
    const inputCost = m.pricing?.prompt ? parseFloat(m.pricing.prompt) * 1000 : 0;
    const outputCost = m.pricing?.completion ? parseFloat(m.pricing.completion) * 1000 : 0;
    const avgCost = (inputCost + outputCost) / 2;
    return {
      id: m.id,
      label: m.name,
      provider: 'OpenRouter',
      providerType: 'openrouter' as ProviderType,
      costPer1kInput: inputCost,
      costPer1kOutput: outputCost,
      contextWindow: CONTEXT_WINDOW_OVERRIDES[m.id] ?? m.context_length ?? 128000,
      speedTier: 'medium' as SpeedTier,
      costTier: (avgCost === 0 ? 'free' : avgCost < 0.002 ? 'low' : avgCost < 0.01 ? 'medium' : avgCost < 0.05 ? 'high' : 'premium') as CostTier,
      metadata: m.supported_parameters ? { supported_parameters: m.supported_parameters } : undefined,
    };
  });
}

// ─── Unified Entry Point ─────────────────────────────────────────────────────

/**
 * Unified LLM completion that routes to the correct provider.
 *
 * Provider resolution order:
 * 1. Explicit `opts.provider` param
 * 2. Infer from model registry (look up providerType)
 * 3. If apiKey provided but no provider, assume 'anthropic' (backward compat)
 * 4. Default: 'claude-cli' (subscription path)
 */
export function chatComplete(messages: ChatMessage[], modelOrOpts?: string | ChatOptions): Promise<ChatResult> {
  // Normalize overloaded parameter (backward compat: string = model name)
  const opts: ChatOptions = typeof modelOrOpts === 'string'
    ? { model: modelOrOpts }
    : modelOrOpts ?? {};

  const provider = resolveProvider(opts);
  const model = opts.model ?? DEFAULT_MODEL;

  switch (provider) {
    case 'claude-cli':
      return chatCompleteCLI(messages, model);

    case 'anthropic':
      if (!opts.apiKey) {
        throw new Error('Anthropic provider requires an API key (set via BYOB vault or ANTHROPIC_API_KEY)');
      }
      return chatCompleteAnthropic(messages, model, opts.apiKey, opts);

    case 'openai-compat':
      if (!opts.apiKey) {
        throw new Error('OpenAI-compatible provider requires an API key');
      }
      return chatCompleteOpenAICompat(messages, model, opts.apiKey, opts.baseUrl, opts);

    case 'openrouter':
      if (!opts.apiKey) {
        throw new Error('OpenRouter provider requires an API key');
      }
      return chatCompleteOpenRouter(messages, model, opts.apiKey, opts);

    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Map a provider type to the vault provider string used in api_key_vault.
 * 'claude-cli' doesn't need a vault key, returns null.
 */
export function vaultProviderForType(providerType: ProviderType): string | null {
  switch (providerType) {
    case 'claude-cli': return null;
    case 'anthropic': return 'anthropic';
    case 'openai-compat': return 'openai-compat';
    case 'openrouter': return 'openrouter';
    default: return null;
  }
}

/**
 * Given a model ID, determine the vault provider string to look up API keys.
 * Returns null for claude-cli (no key needed) or unrecognized models.
 */
export function resolveVaultProvider(modelId: string): string | null {
  const info = getModelInfo(modelId);
  if (info) return vaultProviderForType(info.providerType);
  // Unrecognized model — could be a pass-through openai-compat model
  return null;
}

// ─── Status Helpers ──────────────────────────────────────────────────────────

export function getActiveProvider(): string { return 'claude-cli'; }
export function getActiveModel(): string { return 'claude (subscription)'; }
