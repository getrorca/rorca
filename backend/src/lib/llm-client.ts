/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execFileSync, spawn } from 'child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { logger } from './logger';
import { prepareAutonomousModelSandboxLaunch } from './autonomous-sandbox';

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
export type ReasoningType = 'anthropic-thinking' | 'effort-levels' | 'native-cot' | 'deepseek-thinking' | 'none';

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
  /** Reasoning/thinking tokens reported separately by the provider (0 when not applicable). */
  reasoningTokens: number;
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
  /** Optional workspace visible to a sandboxed CLI provider. SDK providers ignore it. */
  cwd?: string;
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

// ─── Reasoning Capability Override Cache ─────────────────────────────────────

/**
 * In-memory cache of per-model reasoning capability overrides.
 * Populated when a provider rejects a request due to reasoning params,
 * so subsequent calls skip reasoning without retrying.
 * Intentionally not exported — use markModelAsNonReasoning() to update.
 * Resets on process restart (in-memory only by design).
 */
const reasoningCapabilityCache = new Map<string, Pick<ReasoningCapability, 'supportsReasoning'>>();

/**
 * Mark a model as non-reasoning in the capability cache.
 * Called automatically by chatComplete() on reasoning-related provider errors.
 * Exported for testing only.
 */
export function markModelAsNonReasoning(model: string): void {
  reasoningCapabilityCache.set(model, { supportsReasoning: false });
}

/**
 * Check if a model has been marked as non-reasoning in this session.
 * Returns true if the model is known not to support reasoning params.
 */
export function isModelMarkedNonReasoning(model: string): boolean {
  const entry = reasoningCapabilityCache.get(model);
  return entry !== undefined && !entry.supportsReasoning;
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
function normalizeClaudeModelId(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed.startsWith('claude-')) return trimmed;
  return trimmed.replace(/-(\d+)\.(\d+)(?:(-\d{8})?)$/, '-$1-$2$3');
}

export const ALL_MODELS: ModelInfo[] = [
  // ── Anthropic (Claude API + subscription / claude-cli) ──
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
    supportsReasoning: true,
    effortLevels: ['low', 'medium', 'high'],
  },
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
    supportsReasoning: true,
    effortLevels: ['low', 'medium', 'high'],
  },
  {
    id: 'claude-sonnet-4-7',
    label: 'Claude Sonnet 4.7',
    provider: 'Anthropic',
    providerType: 'anthropic',
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    contextWindow: 200000,
    speedTier: 'medium',
    costTier: 'medium',
    supportsReasoning: true,
    effortLevels: ['low', 'medium', 'high'],
  },
  {
    id: 'claude-sonnet-4-8',
    label: 'Claude Sonnet 4.8',
    provider: 'Anthropic',
    providerType: 'anthropic',
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    contextWindow: 200000,
    speedTier: 'medium',
    costTier: 'medium',
    supportsReasoning: true,
    effortLevels: ['low', 'medium', 'high'],
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
    supportsReasoning: true,
    effortLevels: ['low', 'medium', 'high', 'max'],
  },
  {
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    provider: 'Anthropic',
    providerType: 'anthropic',
    // Temporary: mirror Opus 4.6 pricing/capacity until Anthropic pricing is
    // explicitly revised in Rorca's pricing table / UI copy.
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
    contextWindow: 200000,
    speedTier: 'slow',
    costTier: 'premium',
    supportsReasoning: true,
    effortLevels: ['low', 'medium', 'high', 'max'],
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    provider: 'Anthropic',
    providerType: 'anthropic',
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
    contextWindow: 200000,
    speedTier: 'slow',
    costTier: 'premium',
    supportsReasoning: true,
    effortLevels: ['low', 'medium', 'high', 'max'],
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
    supportsReasoning: true,
    effortLevels: ['low', 'medium', 'high'],
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
  'claude-sonnet-4-6',
  'claude-sonnet-4-7',
  'claude-sonnet-4-8',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-haiku-4-5-20251001',
] as const;

export type SupportedModel = typeof SUPPORTED_MODELS[number];

export const DEFAULT_MODEL: SupportedModel = 'claude-sonnet-4-6';

/**
 * Backward-compat MODEL_INFO keyed by SupportedModel.
 * New code should use ALL_MODELS instead.
 */
export const MODEL_INFO = Object.fromEntries(
  SUPPORTED_MODELS.map((modelId) => [modelId, ALL_MODELS.find(m => m.id === modelId)!]),
) as Record<SupportedModel, ModelInfo>;

/** Check if model ID exists in the full registry. */
export function isValidModel(model: string): model is SupportedModel {
  const normalized = normalizeClaudeModelId(model);
  return ALL_MODELS.some(m => m.id === normalized) ||
    (SUPPORTED_MODELS as readonly string[]).includes(normalized);
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

/**
 * Resolve the Claude CLI without embedding any developer-machine path.
 *
 * NVM/PATH is not inherited by Node child processes (launchd, systemd), so an
 * explicit `CLAUDE_BIN` full path remains the supported override. Otherwise the
 * ambient shell PATH is consulted, and the bare command name is the final
 * fallback — which is what a normal user install relies on.
 */
function resolveClaudeBin(): string {
  const configured = process.env.CLAUDE_BIN?.trim();
  if (configured) return configured;
  try {
    const resolved = execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim();
    if (resolved) return resolved;
  } catch {
    // No ambient `claude` on PATH; fall through to the bare command name so the
    // spawn error surfaces at launch with the CLI name the user can install.
  }
  return 'claude';
}

const CLAUDE_BIN = resolveClaudeBin();

const CLAUDE_ENV_VARS_TO_REMOVE = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
];

async function chatCompleteCLI(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
  const prompt = messages.length === 1
    ? messages[0].content
    : messages.map(m =>
        m.role === 'user' ? m.content : `[Previous response: ${m.content}]`
      ).join('\n\n---\n\n');

  const env = Object.fromEntries(
    Object.entries(process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .filter(([key]) => !CLAUDE_ENV_VARS_TO_REMOVE.includes(key)),
  );
  const ownedScratch = opts.cwd ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-claude-cli-'));
  const cwd = opts.cwd ?? ownedScratch!;

  try {
    const args = [
      '--print',
      '--tools', '',
      '--output-format', 'json',
    ];
    if (opts.model) {
      args.push('--model', opts.model);
    }
    args.push(prompt);

    const launch = await prepareAutonomousModelSandboxLaunch({ command: CLAUDE_BIN, args, cwd, env });
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(launch.command, launch.args, {
          cwd: launch.cwd,
          env: launch.env,
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
            // Count thinking block tokens if present in the content array
            const thinkingTokens = Array.isArray(parsed.content)
              ? (parsed.content as Array<{ type: string; thinking?: string }>)
                  .filter(b => b.type === 'thinking' && b.thinking)
                  .reduce((sum, b) => sum + Math.ceil((b.thinking?.length ?? 0) / 4), 0)
              : 0;
            const usage: TokenUsage = {
              inputTokens: parsed.input_tokens ?? parsed.usage?.input_tokens ?? 0,
              outputTokens: parsed.output_tokens ?? parsed.usage?.output_tokens ?? 0,
              reasoningTokens: thinkingTokens,
            };
            resolve({ text: typeof text === 'string' ? text : JSON.stringify(text), usage });
          } catch {
            resolve({ text: stdout.trim(), usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 } });
          }
        });
      });
    } finally {
      await launch.closeModelEgress();
    }
  } finally {
    if (ownedScratch) fs.rmSync(ownedScratch, { recursive: true, force: true });
  }
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

  // Sum token lengths across thinking blocks as a proxy for reasoning token count.
  // Anthropic does not expose a discrete reasoning_tokens field in the usage object,
  // so we estimate from thinking block character counts (÷4 ≈ tokens).
  const reasoningTokens = (response.content as Array<{ type: string; thinking?: string }>)
    .filter(b => b.type === 'thinking' && typeof b.thinking === 'string')
    .reduce((sum, b) => sum + Math.ceil((b.thinking?.length ?? 0) / 4), 0);

  return {
    text,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      reasoningTokens,
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
  // OpenAI o-series models report reasoning tokens in completion_tokens_details
  const reasoningTokens = (usage as any)?.completion_tokens_details?.reasoning_tokens ?? 0;

  return {
    text,
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      reasoningTokens,
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
  // OpenRouter passes through reasoning_tokens from upstream providers that support it
  const reasoningTokens = (usage as any)?.completion_tokens_details?.reasoning_tokens ?? 0;

  return {
    text,
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      reasoningTokens,
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
 * Returns true if the error message suggests the provider rejected reasoning params.
 * Matches messages containing 'reasoning' or 'thinking' (case-insensitive).
 */
function isReasoningError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('reasoning') || msg.includes('thinking');
}

/**
 * Unified LLM completion that routes to the correct provider.
 *
 * Provider resolution order:
 * 1. Explicit `opts.provider` param
 * 2. Infer from model registry (look up providerType)
 * 3. If apiKey provided but no provider, assume 'anthropic' (backward compat)
 * 4. Default: 'claude-cli' (subscription path)
 *
 * Reasoning fallback: if reasoning params are included and the provider returns
 * an error containing 'reasoning' or 'thinking', the request is retried once
 * without reasoning params. The model is then marked in the session cache so
 * subsequent calls skip reasoning immediately without retrying.
 */
export async function chatComplete(messages: ChatMessage[], modelOrOpts?: string | ChatOptions): Promise<ChatResult> {
  // Normalize overloaded parameter (backward compat: string = model name)
  const opts: ChatOptions = typeof modelOrOpts === 'string'
    ? { model: modelOrOpts }
    : modelOrOpts ?? {};

  const provider = resolveProvider(opts);
  const model = opts.model ?? DEFAULT_MODEL;

  // If this model was already marked as non-reasoning in this session, strip
  // reasoning params before the first attempt (no retry needed).
  const effectiveOpts: ChatOptions = isModelMarkedNonReasoning(model) && opts.reasoning?.enabled
    ? { ...opts, reasoning: { ...opts.reasoning, enabled: false } }
    : opts;

  const attemptCall = (callOpts: ChatOptions): Promise<ChatResult> => {
    switch (provider) {
      case 'claude-cli':
        return chatCompleteCLI(messages, { ...callOpts, model });

      case 'anthropic':
        if (!callOpts.apiKey) {
          throw new Error('Anthropic provider requires an API key (set via BYOB vault or ANTHROPIC_API_KEY)');
        }
        return chatCompleteAnthropic(messages, model, callOpts.apiKey, callOpts);

      case 'openai-compat':
        if (!callOpts.apiKey) {
          throw new Error('OpenAI-compatible provider requires an API key');
        }
        return chatCompleteOpenAICompat(messages, model, callOpts.apiKey, callOpts.baseUrl, callOpts);

      case 'openrouter':
        if (!callOpts.apiKey) {
          throw new Error('OpenRouter provider requires an API key');
        }
        return chatCompleteOpenRouter(messages, model, callOpts.apiKey, callOpts);

      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  };

  // Only attempt the reasoning-error retry path when reasoning is actually enabled.
  if (effectiveOpts.reasoning?.enabled) {
    try {
      return await attemptCall(effectiveOpts);
    } catch (err) {
      if (isReasoningError(err)) {
        // Update the session cache so future calls skip reasoning immediately.
        markModelAsNonReasoning(model);
        logger.warn({
          model,
          error: err instanceof Error ? err.message : String(err),
          action: 'retried_without_reasoning',
        });
        // Retry the same request with reasoning disabled.
        const fallbackOpts: ChatOptions = { ...effectiveOpts, reasoning: { ...effectiveOpts.reasoning, enabled: false } };
        return attemptCall(fallbackOpts);
      }
      throw err;
    }
  }

  return attemptCall(effectiveOpts);
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
