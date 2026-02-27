import { spawn } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// ─── Provider Types ──────────────────────────────────────────────────────────

export type ProviderType = 'claude-cli' | 'anthropic' | 'openai-compat' | 'openrouter';

export interface ChatMessage { role: 'user' | 'assistant'; content: string; }

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  usage: TokenUsage;
}

export interface ChatOptions {
  model?: string;
  apiKey?: string;
  provider?: ProviderType;
  baseUrl?: string;
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
}

/** All known models across providers. */
export const ALL_MODELS: ModelInfo[] = [
  // ── Anthropic (claude-cli or anthropic SDK) ──
  {
    id: 'claude-sonnet-4-5-20250929',
    label: 'Claude Sonnet 4.5',
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
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-6',
  'claude-haiku-4-5-20251001',
] as const;

export type SupportedModel = typeof SUPPORTED_MODELS[number];

export const DEFAULT_MODEL: SupportedModel = 'claude-sonnet-4-5-20250929';

/**
 * Backward-compat MODEL_INFO keyed by SupportedModel.
 * New code should use ALL_MODELS instead.
 */
export const MODEL_INFO: Record<SupportedModel, ModelInfo> = {
  'claude-sonnet-4-5-20250929': ALL_MODELS.find(m => m.id === 'claude-sonnet-4-5-20250929')!,
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
      if (stderr) console.warn('[LLM] claude stderr:', stderr.slice(0, 500));
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}. stderr: ${stderr.slice(0, 300)}`));
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

async function chatCompleteAnthropic(messages: ChatMessage[], model: string, apiKey: string): Promise<ChatResult> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: 16384,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
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

async function chatCompleteOpenAICompat(
  messages: ChatMessage[],
  model: string,
  apiKey: string,
  baseUrl?: string,
): Promise<ChatResult> {
  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl || 'https://api.openai.com/v1',
  });

  const response = await client.chat.completions.create({
    model,
    messages: messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    max_tokens: 16384,
  });

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

async function chatCompleteOpenRouter(messages: ChatMessage[], model: string, apiKey: string): Promise<ChatResult> {
  const client = new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: {
      'HTTP-Referer': 'https://rorca.dev',
      'X-Title': 'Rorca',
    },
  });

  const response = await client.chat.completions.create({
    model,
    messages: messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    max_tokens: 16384,
  });

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
      pricing?: { prompt?: string; completion?: string };
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
      contextWindow: (m as any).context_length ?? 128000,
      speedTier: 'medium' as SpeedTier,
      costTier: (avgCost === 0 ? 'free' : avgCost < 0.002 ? 'low' : avgCost < 0.01 ? 'medium' : avgCost < 0.05 ? 'high' : 'premium') as CostTier,
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
      return chatCompleteAnthropic(messages, model, opts.apiKey);

    case 'openai-compat':
      if (!opts.apiKey) {
        throw new Error('OpenAI-compatible provider requires an API key');
      }
      return chatCompleteOpenAICompat(messages, model, opts.apiKey, opts.baseUrl);

    case 'openrouter':
      if (!opts.apiKey) {
        throw new Error('OpenRouter provider requires an API key');
      }
      return chatCompleteOpenRouter(messages, model, opts.apiKey);

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
