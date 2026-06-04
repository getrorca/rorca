/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { activeAgent, activeModel, AgentType, VALID_AGENT_TYPES, setActiveAgentConfig, validateOrchestrationConfig } from '../lib/config';
import { loadOrchestrationConfig, clearConfigCache } from '../lib/complexity-scorer';
import { detectOpenCode } from '../lib/opencode-detector';
import { detectCodex } from '../lib/codex-detector';
import { detectPi, listPiModels, PI_INSTALL_METHODS } from '../lib/pi-detector';
import type { PiModel } from '../lib/pi-detector';
import { getClaudeAuthState, triggerClaudeLogin, triggerClaudeLogout } from '../lib/claude-auth';
import { getCodexAuthState, triggerCodexLogin, triggerCodexLogout } from '../lib/codex-auth';
import { queryOne } from '../db/index';
import { getVaultKey } from './vault';
import { getProviderAsync, getProviderSource, invalidateProviderCache } from '../lib/embedding-pipeline';
import { loadRorcaConfig, writeRorcaConfig, invalidateConfigCache } from '../lib/rorca-config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AuthError, DependencyNotFoundError, NotFoundError, TooManyRequestsError, ValidationError } from '../lib/errors';
import { detectCapability, OpenRouterModelMetadata } from '../lib/reasoning-detector';
import { isModelMarkedNonReasoning } from '../lib/llm-client';

/**
 * Context window overrides for OpenRouter models where the API reports the wrong value
 * (e.g., cheapest provider has a lower cap than the model's native context window).
 */
const OPENROUTER_CONTEXT_OVERRIDES: Record<string, number> = {
  'z-ai/glm-5': 200000, // Ambient reports 80K, actual native context is 200K
};

const router = Router();
let cachedPiModels: { models: PiModel[]; ts: number } | null = null;

// ─── OpenCode model catalog (Models.dev compatible) ──────────────────────────
interface OpenCodeModel {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  costPer1kInput?: number;
  costPer1kOutput?: number;
  speedTier?: 'fast' | 'medium' | 'slow';
  costTier?: 'free' | 'low' | 'medium' | 'high' | 'premium';
}

const OPENCODE_MODELS: OpenCodeModel[] = [
  // OpenAI
  { id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'OpenAI', contextWindow: 128000, costPer1kInput: 0.0025, costPer1kOutput: 0.01, speedTier: 'medium', costTier: 'medium' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', provider: 'OpenAI', contextWindow: 128000, costPer1kInput: 0.00015, costPer1kOutput: 0.0006, speedTier: 'fast', costTier: 'low' },
  { id: 'openai/o3', name: 'o3', provider: 'OpenAI', contextWindow: 200000, costPer1kInput: 0.01, costPer1kOutput: 0.04, speedTier: 'slow', costTier: 'premium' },
  { id: 'openai/o3-mini', name: 'o3 Mini', provider: 'OpenAI', contextWindow: 200000, costPer1kInput: 0.0011, costPer1kOutput: 0.0044, speedTier: 'medium', costTier: 'low' },
  { id: 'openai/o4-mini', name: 'o4 Mini', provider: 'OpenAI', contextWindow: 200000, costPer1kInput: 0.0011, costPer1kOutput: 0.0044, speedTier: 'fast', costTier: 'low' },
  // Google
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'Google', contextWindow: 1048576, costPer1kInput: 0.00125, costPer1kOutput: 0.01, speedTier: 'medium', costTier: 'medium' },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'Google', contextWindow: 1048576, costPer1kInput: 0.000075, costPer1kOutput: 0.0003, speedTier: 'fast', costTier: 'low' },
  { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'Google', contextWindow: 1048576, costPer1kInput: 0.0001, costPer1kOutput: 0.0004, speedTier: 'fast', costTier: 'low' },
  // Anthropic
  { id: 'anthropic/claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', provider: 'Anthropic', contextWindow: 200000, costPer1kInput: 0.003, costPer1kOutput: 0.015, speedTier: 'medium', costTier: 'medium' },
  { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'Anthropic', contextWindow: 200000, costPer1kInput: 0.003, costPer1kOutput: 0.015, speedTier: 'medium', costTier: 'medium' },
  { id: 'anthropic/claude-sonnet-4-7', name: 'Claude Sonnet 4.7', provider: 'Anthropic', contextWindow: 200000, costPer1kInput: 0.003, costPer1kOutput: 0.015, speedTier: 'medium', costTier: 'medium' },
  { id: 'anthropic/claude-sonnet-4-8', name: 'Claude Sonnet 4.8', provider: 'Anthropic', contextWindow: 200000, costPer1kInput: 0.003, costPer1kOutput: 0.015, speedTier: 'medium', costTier: 'medium' },
  { id: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'Anthropic', contextWindow: 200000, costPer1kInput: 0.015, costPer1kOutput: 0.075, speedTier: 'slow', costTier: 'premium' },
  { id: 'anthropic/claude-opus-4-7', name: 'Claude Opus 4.7', provider: 'Anthropic', contextWindow: 200000, costPer1kInput: 0.015, costPer1kOutput: 0.075, speedTier: 'slow', costTier: 'premium' },
  { id: 'anthropic/claude-opus-4-8', name: 'Claude Opus 4.8', provider: 'Anthropic', contextWindow: 200000, costPer1kInput: 0.015, costPer1kOutput: 0.075, speedTier: 'slow', costTier: 'premium' },
  { id: 'anthropic/claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'Anthropic', contextWindow: 200000, costPer1kInput: 0.0008, costPer1kOutput: 0.004, speedTier: 'fast', costTier: 'low' },
  // OpenRouter
  { id: 'openrouter/auto', name: 'Auto (Best Available)', provider: 'OpenRouter', contextWindow: 200000, costPer1kInput: 0, costPer1kOutput: 0, speedTier: 'medium', costTier: 'medium' },
  { id: 'openrouter/deepseek/deepseek-r1', name: 'DeepSeek R1', provider: 'OpenRouter', contextWindow: 131072, costPer1kInput: 0.00055, costPer1kOutput: 0.0022, speedTier: 'medium', costTier: 'low' },
  { id: 'openrouter/meta-llama/llama-4-maverick', name: 'Llama 4 Maverick', provider: 'OpenRouter', contextWindow: 1048576, costPer1kInput: 0.0005, costPer1kOutput: 0.0015, speedTier: 'medium', costTier: 'low' },
  // Local
  { id: 'ollama/llama3.3', name: 'Llama 3.3 (Ollama)', provider: 'Local', contextWindow: 131072, costPer1kInput: 0, costPer1kOutput: 0, speedTier: 'medium', costTier: 'free' },
  { id: 'ollama/deepseek-r1:14b', name: 'DeepSeek R1 14B (Ollama)', provider: 'Local', contextWindow: 131072, costPer1kInput: 0, costPer1kOutput: 0, speedTier: 'slow', costTier: 'free' },
  { id: 'ollama/qwen2.5-coder:14b', name: 'Qwen 2.5 Coder 14B (Ollama)', provider: 'Local', contextWindow: 131072, costPer1kInput: 0, costPer1kOutput: 0, speedTier: 'slow', costTier: 'free' },
];

// Map provider group to the vault provider keys that satisfy it
const PROVIDER_KEY_MAP: Record<string, string[]> = {
  OpenAI: ['openai-compat'],
  Google: ['openai-compat'],
  Anthropic: ['anthropic'],
  OpenRouter: ['openrouter'],
  Local: [], // No API key required
};

/**
 * @swagger
 * /api/config:
 *   get:
 *     summary: Get agent configuration
 *     operationId: getAgentConfig
 *     description: Returns the current agent type, model, API key status, and detected CLI binaries.
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: Current agent configuration
 */
router.get('/', async (_req: Request, res: Response) => {
  // Always detect both — UI needs status to show install badges when user toggles
  const opencode = detectOpenCode();
  const codex = detectCodex();
  const pi = detectPi();

  // Determine if user has an API key for the selected model's provider
  let hasApiKey = true; // claude doesn't need one
  let modelDisplayName: string | null = null;

  if (activeAgent === 'opencode') {
    if (activeModel) {
      const modelEntry = OPENCODE_MODELS.find(m => m.id === activeModel);
      if (activeModel.startsWith('openrouter/') && !modelEntry) {
        // OpenRouter model from live catalog — extract provider family and model name
        const orModelId = activeModel.slice('openrouter/'.length); // e.g. "meta-llama/llama-3.3-70b"
        modelDisplayName = orModelId;
        // Check for OpenRouter API key
        const orKeyRow = await queryOne<{ count: number }>(
          `SELECT 1 FROM api_key_vault WHERE provider = 'openrouter' LIMIT 1`
        );
        hasApiKey = !!orKeyRow || !!process.env.OPENROUTER_API_KEY;
      } else {
        modelDisplayName = modelEntry?.name ?? activeModel.split('/').pop() ?? activeModel;
      }
      if (modelEntry) {
        const requiredProviders = PROVIDER_KEY_MAP[modelEntry.provider] ?? [];
        if (requiredProviders.length > 0) {
          const placeholders = requiredProviders.map((_, i) => `$${i + 1}`).join(',');
          const row = await queryOne<Record<string, unknown>>(
            `SELECT 1 FROM api_key_vault WHERE provider IN (${placeholders}) LIMIT 1`,
            requiredProviders
          );
          hasApiKey = !!row;
        }
        // Local models don't need a key
      }
    } else {
      hasApiKey = false; // No model configured at all
    }
  }

  // Check if OpenRouter key is available via env var (even if not in vault)
  const openrouterViaEnv = !!(process.env.OPENROUTER_API_KEY);

  res.json({
    agentType: activeAgent,
    agentModel: activeModel,
    modelDisplayName,
    hasApiKey,
    opencodeInstalled: opencode.opencodeInstalled,
    opencodeVersion: opencode.opencodeVersion,
    codexInstalled: codex.codexInstalled,
    codexVersion: codex.codexVersion,
    piInstalled: pi.piInstalled,
    piVersion: pi.piVersion,
    openrouterViaEnv,
  });
});

// ─── Ollama Detection & Dynamic Model Discovery ─────────────────────────────

interface OllamaModel {
  id: string;
  name: string;
  size: number;
  parameterSize: string;
}

interface OllamaStatus {
  available: boolean;
  models: OllamaModel[];
  error?: string;
}

/**
 * Detect Ollama availability by attempting to reach its API,
 * then fetch available models from /api/tags.
 */
async function detectOllama(): Promise<OllamaStatus> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { available: false, models: [], error: 'Ollama API returned non-200' };
    }

    const data = await res.json() as {
      models?: Array<{
        name: string;
        size: number;
        details?: { parameter_size?: string };
      }>;
    };

    const models: OllamaModel[] = (data.models ?? []).map(m => ({
      id: `ollama/${m.name}`,
      name: m.name,
      size: m.size,
      parameterSize: m.details?.parameter_size ?? 'unknown',
    }));

    return { available: true, models };
  } catch {
    return {
      available: false,
      models: [],
      error: 'Ollama not detected. Start with: ollama serve',
    };
  }
}

/**
 * @swagger
 * /api/config/ollama:
 *   get:
 *     summary: Detect Ollama availability and list locally installed models
 *     operationId: detectOllamaModels
 *     description: Probes the local Ollama API and returns available models with their sizes.
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: Ollama detection result with available models
 */
router.get('/ollama', async (_req: Request, res: Response) => {
  const status = await detectOllama();
  res.json(status);
});

/**
 * @swagger
 * /api/config/opencode-models:
 *   get:
 *     summary: Get available OpenCode models grouped by provider
 *     operationId: listOpenCodeModels
 *     description: Returns the full OpenCode model catalog with dynamic Ollama discovery, grouped by provider.
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: Models.dev compatible model list
 */
router.get('/opencode-models', async (_req: Request, res: Response) => {
  // Start with hardcoded models (excluding static Ollama entries — they'll be replaced by dynamic ones)
  const staticModels = OPENCODE_MODELS.filter(m => m.provider !== 'Local');

  // Attempt to discover Ollama models dynamically
  const ollamaStatus = await detectOllama();
  const dynamicOllamaModels: OpenCodeModel[] = ollamaStatus.models.map(m => ({
    id: m.id,
    name: `${m.name} (Ollama)`,
    provider: 'Local',
    contextWindow: 131072, // Conservative default — Ollama doesn't expose this
  }));

  // If Ollama is down, fall back to hardcoded Ollama models
  const ollamaModels = dynamicOllamaModels.length > 0
    ? dynamicOllamaModels
    : OPENCODE_MODELS.filter(m => m.provider === 'Local');

  const allModels = [...staticModels, ...ollamaModels];

  // Group by provider
  const grouped: Record<string, OpenCodeModel[]> = {};
  for (const m of allModels) {
    (grouped[m.provider] ??= []).push(m);
  }
  res.json({ models: allModels, grouped, ollamaAvailable: ollamaStatus.available });
});

// ─── OpenRouter Model Catalog (OC-027) ───────────────────────────────────────

interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
  top_provider?: { is_moderated: boolean };
  /** Capability flags declared by the OpenRouter model catalog. */
  supported_parameters?: string[];
  /** Architecture metadata from OpenRouter. */
  architecture?: {
    tokenizer?: string;
    instruct_type?: string | null;
    modality?: string;
  };
}

interface OpenRouterCatalog {
  models: Array<{
    id: string;
    name: string;
    provider: string;
    contextWindow: number;
    free: boolean;
    pricingPrompt: number;
    pricingCompletion: number;
    reasoningCapability: ReturnType<typeof detectCapability>;
  }>;
  modelCount: number;
  cachedAt: number;
}

let openRouterCache: OpenRouterCatalog | null = null;
const OPENROUTER_CACHE_TTL = 60 * 60 * 1000; // 1 hour

function getOpenRouterProviderFamily(modelId: string): string {
  const prefix = modelId.split('/')[0];
  const familyMap: Record<string, string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google',
    'meta-llama': 'Meta',
    mistralai: 'Mistral',
    deepseek: 'DeepSeek',
    qwen: 'Qwen',
    microsoft: 'Microsoft',
    cohere: 'Cohere',
    perplexity: 'Perplexity',
    databricks: 'Databricks',
    nvidia: 'NVIDIA',
    nousresearch: 'Nous Research',
    '01-ai': '01.AI',
    cognitivecomputations: 'Cognitive Computations',
  };
  return familyMap[prefix] ?? prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

/**
 * Resolve OpenRouter API key from vault (any user) or env var.
 */
async function resolveOpenRouterKey(): Promise<string | null> {
  // Check vault first (any user — auth is bypassed globally)
  try {
    const userRow = await queryOne<{ id: string }>('SELECT id FROM users LIMIT 1');
    if (userRow) {
      const vaultResult = await getVaultKey(userRow.id, 'openrouter');
      if (vaultResult) return vaultResult.key;
    }
  } catch { /* table may not exist */ }

  // Fall back to env var
  return process.env.OPENROUTER_API_KEY ?? null;
}

/**
 * @swagger
 * /api/config/openrouter-models:
 *   get:
 *     summary: Get OpenRouter model catalog (cached 1h)
 *     operationId: listOpenRouterModels
 *     description: Fetches the OpenRouter model catalog (cached for one hour) and returns models grouped by provider family.
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: Filtered and sorted OpenRouter model list grouped by provider family
 *       401:
 *         description: No OpenRouter API key configured
 *       502:
 *         description: Failed to fetch from OpenRouter API
 */
router.get('/openrouter-models', async (_req: Request, res: Response) => {
  // Return cached if fresh
  if (openRouterCache && Date.now() - openRouterCache.cachedAt < OPENROUTER_CACHE_TTL) {
    res.json(openRouterCache);
    return;
  }

  const apiKey = await resolveOpenRouterKey();
  if (!apiKey) {
    throw new AuthError('No OpenRouter API key configured. Add one in Settings > Provider Configuration.');
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://rorca.app',
        'X-Title': 'Rorca',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403) {
        throw new AuthError('Invalid OpenRouter API key.');
        return;
      }
      if (status === 429) {
        throw new TooManyRequestsError('OpenRouter rate limited. Try again later.');
        return;
      }
      res.status(502).json({ error: `OpenRouter API returned ${status}` });
      return;
    }

    const data = await response.json() as { data: OpenRouterModel[] };
    const rawModels = data.data ?? [];

    // Filter and transform
    const models = rawModels
      .filter(m => m.context_length >= 4096) // Skip tiny models
      .map(m => {
        // Build OpenRouterModelMetadata for capability detection
        const orMeta: OpenRouterModelMetadata = {
          id: m.id,
          name: m.name,
          context_length: m.context_length,
          pricing: m.pricing,
          top_provider: m.top_provider,
          supported_parameters: m.supported_parameters,
          architecture: m.architecture,
        };
        return {
          id: m.id,
          name: m.name,
          provider: getOpenRouterProviderFamily(m.id),
          contextWindow: OPENROUTER_CONTEXT_OVERRIDES[m.id] ?? m.context_length,
          free: parseFloat(m.pricing?.prompt ?? '1') === 0 && parseFloat(m.pricing?.completion ?? '1') === 0,
          pricingPrompt: parseFloat(m.pricing?.prompt ?? '0'),
          pricingCompletion: parseFloat(m.pricing?.completion ?? '0'),
          reasoningCapability: detectCapability(m.id, orMeta),
        };
      })
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));

    // Group by provider family
    const grouped: Record<string, typeof models> = {};
    for (const m of models) {
      (grouped[m.provider] ??= []).push(m);
    }

    openRouterCache = {
      models,
      modelCount: models.length,
      cachedAt: Date.now(),
    };

    res.json({ ...openRouterCache, grouped });
  } catch (err: any) {
    if (err.name === 'AbortError') {
      res.status(504).json({ error: 'OpenRouter API timeout (10s)' });
      return;
    }
    res.status(502).json({ error: err.message || 'Failed to fetch OpenRouter models' });
  }
});

/**
 * @swagger
 * /api/config/openrouter-test:
 *   post:
 *     summary: Test OpenRouter API key connection
 *     operationId: testOpenRouterConnection
 *     description: Validates an OpenRouter API key by making a test request and returns latency and model count.
 *     tags: [Config]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               key:
 *                 type: string
 *                 description: Optional — test a specific key before saving. If omitted, tests the stored key.
 *     responses:
 *       200:
 *         description: Connection test result with model count
 */
router.post('/openrouter-test', async (req: Request, res: Response) => {
  const { key } = req.body as { key?: string };
  const apiKey = key || await resolveOpenRouterKey();

  if (!apiKey) {
    throw new ValidationError('No API key provided or stored.');
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const startMs = Date.now();

    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://rorca.app',
        'X-Title': 'Rorca',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latencyMs = Date.now() - startMs;

    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403) {
        res.json({ ok: false, error: 'Invalid API key' });
        return;
      }
      if (status === 429) {
        res.json({ ok: false, error: 'Rate limited by OpenRouter' });
        return;
      }
      res.json({ ok: false, error: `OpenRouter returned HTTP ${status}` });
      return;
    }

    const data = await response.json() as { data: OpenRouterModel[] };
    const modelCount = (data.data ?? []).filter(m => m.context_length >= 4096).length;
    const freeCount = (data.data ?? []).filter(m =>
      m.context_length >= 8192 &&
      parseFloat(m.pricing?.prompt ?? '1') === 0 &&
      parseFloat(m.pricing?.completion ?? '1') === 0
    ).length;

    // Invalidate cache so next GET picks up fresh data
    openRouterCache = null;

    res.json({ ok: true, latencyMs, modelCount, freeCount });
  } catch (err: any) {
    if (err.name === 'AbortError') {
      res.json({ ok: false, error: 'Connection timeout (10s)' });
      return;
    }
    res.json({ ok: false, error: err.message || 'Network error' });
  }
});

/**
 * @swagger
 * /api/config/agent:
 *   put:
 *     summary: Update active agent configuration in memory
 *     operationId: updateAgentConfig
 *     description: Switches the active execution engine and model without restarting the backend. This is in-memory only and reverts to .env values on restart.
 *     tags: [Config]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [agent]
 *             properties:
 *               agent:
 *                 type: string
 *                 enum: [claude, opencode, codex, pi]
 *               model:
 *                 type: string
 *     responses:
 *       200:
 *         description: Configuration updated
 *       400:
 *         description: Validation error
 */
router.put('/agent', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const newType = body.agent ?? body.agentType;
  const hasModelField =
    Object.prototype.hasOwnProperty.call(body, 'model') ||
    Object.prototype.hasOwnProperty.call(body, 'agentModel');
  const newModel = Object.prototype.hasOwnProperty.call(body, 'model')
    ? body.model
    : body.agentModel;

  // Validate agentType
  if (!(VALID_AGENT_TYPES as readonly string[]).includes(newType)) {
    throw new ValidationError(`Invalid agent "${newType}". Must be one of: ${VALID_AGENT_TYPES.join(', ')}`);
    return;
  }

  // When switching to opencode, verify binary is available
  if (newType === 'opencode') {
    const status = detectOpenCode();
    if (!status.opencodeInstalled) {
      throw new ValidationError('OpenCode binary not found. Install it first: npm i -g opencode-ai');
      return;
    }
  }

  // OC-024: When switching to codex, verify binary is available
  if (newType === 'codex') {
    const status = detectCodex();
    if (!status.codexInstalled) {
      throw new ValidationError('Codex CLI not found. Install it first: npm i -g @openai/codex');
      return;
    }
  }

  if (newType === 'pi') {
    const status = detectPi();
    if (!status.piInstalled) {
      throw new ValidationError('Pi CLI not found. Install it first: npm install -g @mariozechner/pi-coding-agent');
      return;
    }
  }

  // Validate model requires API key for OpenCode models
  const effectiveType = newType as AgentType;
  const effectiveModel = hasModelField ? newModel : activeModel;

  if (effectiveType === 'opencode' && effectiveModel) {
    // Ollama models: validate Ollama is running instead of checking API key
    if (effectiveModel.startsWith('ollama/')) {
      const ollamaStatus = await detectOllama();
      if (!ollamaStatus.available) {
        throw new ValidationError('Ollama not detected. Start with: ollama serve');
        return;
      }
    } else {
      // Non-Ollama models: check API key as before
    }

    // OC-027: OpenRouter models from live catalog (not in OPENCODE_MODELS) need key validation
    if (effectiveModel.startsWith('openrouter/') && !OPENCODE_MODELS.find(m => m.id === effectiveModel)) {
      const orKey = await resolveOpenRouterKey();
      if (!orKey) {
        throw new ValidationError('OpenRouter models require an API key. Add one in the OpenRouter card above.');
        return;
      }
    }

    const modelEntry = OPENCODE_MODELS.find(m => m.id === effectiveModel);
    if (modelEntry) {
      const requiredProviders = PROVIDER_KEY_MAP[modelEntry.provider] ?? [];
      if (requiredProviders.length > 0) {
        // Check if user has any vault key for the required providers
        const placeholders = requiredProviders.map((_, i) => `$${i + 1}`).join(',');
        const hasKey = await queryOne<Record<string, unknown>>(
          `SELECT 1 FROM api_key_vault WHERE provider IN (${placeholders}) LIMIT 1`,
          requiredProviders,
        );
        if (!hasKey) {
          throw new ValidationError(`Model "${effectiveModel}" requires a ${modelEntry.provider} API key. Add one in Provider Configuration above.`);
          return;
        }
      }
    }
  }

  // Apply changes
  setActiveAgentConfig({
    agent: effectiveType,
    ...(hasModelField ? { model: newModel } : {}),
  });

  res.json({
    agent: activeAgent,
    model: activeModel,
    changed: true,
  });
});

// ─── Orchestration Config (OC-021) ────────────────────────────────────────────

async function resolveWorkspacePath(workspaceId: string | undefined): Promise<string | null> {
  if (!workspaceId) return null;
  try {
    const row = await queryOne<{ path: string }>(
      'SELECT path FROM workspaces WHERE id = $1', [workspaceId]
    );
    return row?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * @swagger
 * /api/config/orchestration:
 *   get:
 *     summary: Get the full orchestration config for a workspace (merged with defaults)
 *     operationId: getOrchestrationConfig
 *     description: Returns the orchestration configuration for a workspace including routing, thresholds, and task settings.
 *     tags: [Config]
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: false
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Orchestration config with defaults applied
 */
router.get('/orchestration', async (req: Request, res: Response) => {
  const workspaceId = req.query.workspaceId as string | undefined;
  const cwd = await resolveWorkspacePath(workspaceId);
  const config = loadOrchestrationConfig(cwd ?? undefined);

  // Return threshold ranges for frontend display
  res.json({
    router: config.router,
    thresholds: {
      haiku: [0, config.thresholds.haiku],
      sonnet: [config.thresholds.haiku + 1, config.thresholds.sonnet],
      opus: [config.thresholds.sonnet + 1, 100],
    },
    taskCascades: config.taskCascades,
    tokenBudgetPerStory: config.tokenBudgetPerStory,
  });
});

/**
 * @swagger
 * /api/config/orchestration:
 *   put:
 *     summary: Update orchestration config in .rorca/config.json
 *     operationId: updateOrchestrationConfig
 *     description: Writes the orchestration configuration to the workspace .rorca/config.json file after validation.
 *     tags: [Config]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               workspaceId:
 *                 type: string
 *               orchestration:
 *                 type: object
 *     responses:
 *       200:
 *         description: Config saved
 *       400:
 *         description: Validation errors
 *       404:
 *         description: Workspace not found
 */
router.put('/orchestration', async (req: Request, res: Response) => {
  const { workspaceId, orchestration } = req.body;

  const cwd = await resolveWorkspacePath(workspaceId);
  if (!cwd) {
    throw new NotFoundError('Workspace not found. Select a workspace first.');
    return;
  }

  // Validate
  const validationErrors = validateOrchestrationConfig(orchestration);
  if (validationErrors.length > 0) {
    throw new ValidationError('Orchestration config validation failed');
    return;
  }

  // Read existing config.json or start fresh
  const configDir = path.join(cwd, '.rorca');
  const configPath = path.join(configDir, 'config.json');
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configPath)) {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {
    existing = {};
  }

  // Merge orchestration section
  existing.orchestration = orchestration;

  // Write atomically
  fs.mkdirSync(configDir, { recursive: true });
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2) + '\n');
  fs.renameSync(tmpPath, configPath);

  // Clear cached config so next loadOrchestrationConfig reads fresh
  clearConfigCache();

  // Return merged config (with defaults applied)
  const merged = loadOrchestrationConfig(cwd);
  res.json({
    router: merged.router,
    thresholds: {
      haiku: [0, merged.thresholds.haiku],
      sonnet: [merged.thresholds.haiku + 1, merged.thresholds.sonnet],
      opus: [merged.thresholds.sonnet + 1, 100],
    },
    taskCascades: merged.taskCascades,
    tokenBudgetPerStory: merged.tokenBudgetPerStory,
  });
});

// ─── Claude Auth Detection (OC-025) ──────────────────────────────────────────

/**
 * @swagger
 * /api/config/claude-auth:
 *   get:
 *     summary: Get Claude subscription auth state (no raw token exposed)
 *     operationId: getClaudeAuthState
 *     description: Returns the current Claude CLI authentication status including connection state and account details.
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: Claude auth state
 */
router.get('/claude-auth', (_req: Request, res: Response) => {
  const state = getClaudeAuthState();
  res.json(state);
});

/**
 * @swagger
 * /api/config/claude-auth/login:
 *   post:
 *     summary: Trigger Claude CLI auth login (opens browser for PKCE OAuth)
 *     operationId: triggerClaudeLogin
 *     description: Spawns the Claude CLI login flow which opens the user's browser for PKCE OAuth authentication.
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: Login spawned, polling for credential changes
 *       400:
 *         description: CLI not found
 */
router.post('/claude-auth/login', (_req: Request, res: Response) => {
  const result = triggerClaudeLogin();
  if (!result.spawned) {
    throw new ValidationError(result.error || 'Operation failed');
    return;
  }
  res.json({ ok: true, message: 'Claude auth login triggered. Complete sign-in in your browser.' });
});

/**
 * @swagger
 * /api/config/claude-auth/logout:
 *   post:
 *     summary: Trigger Claude CLI auth logout
 *     operationId: triggerClaudeLogout
 *     description: Removes the stored Claude CLI credentials and disconnects the account.
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: Logout completed
 *       400:
 *         description: Logout failed
 */
router.post('/claude-auth/logout', async (_req: Request, res: Response) => {
  const result = await triggerClaudeLogout();
  if (!result.success) {
    throw new ValidationError(result.error || 'Operation failed');
    return;
  }
  res.json({ ok: true, message: 'Claude account disconnected.' });
});

// ─── Codex Auth Detection (OC-026) ───────────────────────────────────────────

/**
 * @swagger
 * /api/config/codex-auth:
 *   get:
 *     summary: Get Codex CLI (ChatGPT) auth state
 *     operationId: getCodexAuthState
 *     description: Returns the current Codex CLI authentication status including connection state and ChatGPT plan details.
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: Codex auth state (connected, username, plan)
 */
router.get('/codex-auth', (_req: Request, res: Response) => {
  const state = getCodexAuthState();
  res.json(state);
});

/**
 * @swagger
 * /api/config/codex-auth/login:
 *   post:
 *     summary: Trigger Codex CLI login (opens browser for ChatGPT OAuth)
 *     operationId: triggerCodexLogin
 *     description: Spawns the Codex CLI login flow which opens the user's browser for ChatGPT OAuth authentication.
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: Login spawned, polling for credential changes
 *       400:
 *         description: CLI not found
 */
router.post('/codex-auth/login', (_req: Request, res: Response) => {
  const result = triggerCodexLogin();
  if (!result.spawned) {
    throw new ValidationError(result.error || 'Operation failed');
    return;
  }
  res.json({ ok: true, message: 'Codex login triggered. Complete sign-in in your browser.' });
});

/**
 * @swagger
 * /api/config/codex-auth/logout:
 *   post:
 *     summary: Trigger Codex CLI logout (remove stored credentials)
 *     operationId: triggerCodexLogout
 *     description: Removes the stored Codex CLI credentials and disconnects the ChatGPT account.
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: Logout completed
 *       400:
 *         description: Logout failed
 */
router.post('/codex-auth/logout', async (_req: Request, res: Response) => {
  const result = await triggerCodexLogout();
  if (!result.success) {
    throw new ValidationError(result.error || 'Operation failed');
    return;
  }
  res.json({ ok: true, message: 'ChatGPT account disconnected.' });
});

// ─── Embedding Provider Info (SE-009) ─────────────────────────────────────────

/**
 * @swagger
 * /api/config/embedding-provider:
 *   get:
 *     summary: Get active embedding provider info
 *     operationId: getEmbeddingProvider
 *     description: Returns the currently active embedding provider, model, dimensions, and resolution source (config, env, vault, or local).
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: Current embedding provider details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 provider: { type: string }
 *                 model: { type: string }
 *                 dimensions: { type: integer }
 *                 source: { type: string, enum: [config, env, vault, local] }
 */
router.get('/embedding-provider', async (req: Request, res: Response) => {
  const workspaceId = req.query.workspaceId as string | undefined;
  const wsPath = await resolveWorkspacePath(workspaceId);
  const provider = await getProviderAsync(wsPath ?? undefined);
  const source = getProviderSource(wsPath ?? undefined);
  res.json({
    provider: provider.name,
    model: provider.model,
    dimensions: provider.dimension,
    source,
  });
});

/**
 * @swagger
 * /api/config/embedding-provider:
 *   put:
 *     summary: Set embedding provider (persisted to .rorca/config.json)
 *     operationId: setEmbeddingProvider
 *     description: Sets the active embedding provider in the workspace config. Use 'auto' to revert to auto-detection.
 *     tags: [Config]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [provider]
 *             properties:
 *               provider: { type: string, enum: [auto, openai, openai-large, openrouter, voyage, google, local] }
 *               workspaceId: { type: string }
 *               model: { type: string }
 *     responses:
 *       200:
 *         description: Provider updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 provider: { type: string }
 *                 model: { type: string }
 *                 dimensions: { type: integer }
 *                 source: { type: string }
 *       400:
 *         description: Invalid provider
 *       404:
 *         description: Workspace not found
 */
router.put('/embedding-provider', async (req: Request, res: Response) => {
  const { provider, workspaceId, model } = req.body ?? {};
  const valid = ['auto', 'openai', 'openai-large', 'openrouter', 'voyage', 'google', 'local'];
  if (!provider || !valid.includes(provider)) {
    throw new ValidationError(`Invalid provider. Must be one of: ${valid.join(', ')}`);
    return;
  }

  const wsPath = await resolveWorkspacePath(workspaceId);
  if (wsPath) {
    // Persist to .rorca/config.json
    const config = loadRorcaConfig(wsPath);
    config.embedding = { provider, model: model || undefined };
    writeRorcaConfig(wsPath, config);
    invalidateConfigCache();
  }

  invalidateProviderCache();
  const resolved = await getProviderAsync(wsPath ?? undefined);
  const source = getProviderSource(wsPath ?? undefined);
  res.json({
    provider: resolved.name,
    model: resolved.model,
    dimensions: resolved.dimension,
    source,
  });
});

// ─── Model Capability Endpoint (RE-018) ──────────────────────────────────────

/** In-memory TTL cache for per-modelId capability lookups (5 min). */
interface CapabilityCacheEntry {
  capability: ReturnType<typeof detectCapability>;
  cachedAt: number;
}
const MODEL_CAPABILITY_CACHE = new Map<string, CapabilityCacheEntry>();
const MODEL_CAPABILITY_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Returns the OpenRouterModelMetadata for a given model ID from the current
 * openRouterCache, or null if the cache is stale/missing.
 */
function getOpenRouterMetadataFromCache(modelId: string): OpenRouterModelMetadata | null {
  if (!openRouterCache || Date.now() - openRouterCache.cachedAt >= OPENROUTER_CACHE_TTL) {
    return null;
  }
  const entry = openRouterCache.models.find(m => m.id === modelId);
  if (!entry) return null;
  // Reconstruct minimal OpenRouterModelMetadata from stored model data
  return { id: entry.id, name: entry.name };
}

/**
 * @swagger
 * /api/config/model-capability:
 *   get:
 *     summary: Get reasoning capability for any model ID
 *     operationId: getModelCapability
 *     description: |
 *       Returns the ReasoningCapability for the given model ID. Results are cached in-memory
 *       for 5 minutes per modelId. For OpenRouter models the response incorporates live
 *       OpenRouter metadata when available (from the 1h catalog cache). For Anthropic and
 *       OpenAI prefixed models, capability is determined by pattern-matching only (no
 *       external API call). The graceful-degradation override cache from chatComplete()
 *       is also consulted — if a model has been marked as non-reasoning in this session
 *       the returned capability reflects that override.
 *     tags: [Config]
 *     parameters:
 *       - in: query
 *         name: modelId
 *         required: true
 *         schema:
 *           type: string
 *         description: Full model identifier (e.g. "claude-opus-4-6", "openai/o3", "openrouter/deepseek/deepseek-r1")
 *     responses:
 *       200:
 *         description: ReasoningCapability for the model
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 modelId: { type: string }
 *                 supportsReasoning: { type: boolean }
 *                 reasoningType: { type: string, enum: [none, anthropic-thinking, effort-levels, native-cot] }
 *                 effortLevels: { type: array, items: { type: string } }
 *                 defaultEffort: { type: string, nullable: true }
 *                 budgetTokensSupported: { type: boolean }
 *                 budgetRange: { type: array, nullable: true, items: { type: integer } }
 *                 costMultiplier: { type: number }
 *                 fromGracefulDegradationCache: { type: boolean }
 *                 cachedAt: { type: integer }
 *       400:
 *         description: modelId query parameter is required
 */
router.get('/model-capability', async (req: Request, res: Response) => {
  const modelId = req.query.modelId as string | undefined;
  if (!modelId || typeof modelId !== 'string' || modelId.trim() === '') {
    throw new ValidationError('modelId query parameter is required');
  }

  const trimmedId = modelId.trim();

  // ── Check graceful degradation override cache first ──────────────────────
  // If chatComplete() has already determined this model doesn't support reasoning
  // (provider rejected the params), honour that in-session override immediately.
  const markedNonReasoning = isModelMarkedNonReasoning(trimmedId);

  // ── Check per-modelId TTL cache ───────────────────────────────────────────
  const cached = MODEL_CAPABILITY_CACHE.get(trimmedId);
  if (cached && Date.now() - cached.cachedAt < MODEL_CAPABILITY_TTL) {
    const capability = markedNonReasoning
      ? { ...cached.capability, supportsReasoning: false }
      : cached.capability;
    res.json({
      modelId: trimmedId,
      ...capability,
      fromGracefulDegradationCache: markedNonReasoning,
      cachedAt: cached.cachedAt,
    });
    return;
  }

  // ── Determine if we need OpenRouter metadata ──────────────────────────────
  // OpenRouter models have a vendor-prefixed ID like "openrouter/<provider>/<model>"
  // or an un-prefixed ID resolved from the OpenRouter catalog. We skip the external
  // API call for Anthropic and OpenAI models since their capability is fully
  // determined by ID pattern-matching.
  const isOpenRouterPrefixed = trimmedId.startsWith('openrouter/');
  const isAnthropicPrefixed = trimmedId.startsWith('anthropic/') || trimmedId.startsWith('claude-');
  const isOpenAIPrefixed = trimmedId.startsWith('openai/') || /^o\d/i.test(trimmedId);
  const needsOpenRouterMeta = isOpenRouterPrefixed && !isAnthropicPrefixed && !isOpenAIPrefixed;

  let metadata: OpenRouterModelMetadata | undefined;

  if (needsOpenRouterMeta) {
    // Bare OpenRouter model ID (strip the "openrouter/" prefix for catalog lookup)
    const bareId = trimmedId.slice('openrouter/'.length);

    // 1. Check the in-memory catalog cache first (no extra API call)
    const fromCache = getOpenRouterMetadataFromCache(bareId);
    if (fromCache) {
      metadata = fromCache;
    } else {
      // 2. Try fetching fresh catalog from OpenRouter (single call, result populates catalog cache)
      const apiKey = await resolveOpenRouterKey();
      if (apiKey) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          const response = await fetch('https://openrouter.ai/api/v1/models', {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'HTTP-Referer': 'https://rorca.app',
              'X-Title': 'Rorca',
            },
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (response.ok) {
            const data = await response.json() as { data: OpenRouterModel[] };
            const rawModels = data.data ?? [];

            // Populate the shared catalog cache so /openrouter-models benefits too
            const models = rawModels
              .filter(m => m.context_length >= 4096)
              .map(m => {
                const orMeta: OpenRouterModelMetadata = {
                  id: m.id,
                  name: m.name,
                  context_length: m.context_length,
                  pricing: m.pricing,
                  top_provider: m.top_provider,
                  supported_parameters: m.supported_parameters,
                  architecture: m.architecture,
                };
                return {
                  id: m.id,
                  name: m.name,
                  provider: getOpenRouterProviderFamily(m.id),
                  contextWindow: OPENROUTER_CONTEXT_OVERRIDES[m.id] ?? m.context_length,
                  free: parseFloat(m.pricing?.prompt ?? '1') === 0 && parseFloat(m.pricing?.completion ?? '1') === 0,
                  pricingPrompt: parseFloat(m.pricing?.prompt ?? '0'),
                  pricingCompletion: parseFloat(m.pricing?.completion ?? '0'),
                  reasoningCapability: detectCapability(m.id, orMeta),
                };
              })
              .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));

            openRouterCache = { models, modelCount: models.length, cachedAt: Date.now() };

            // Extract metadata for the requested model
            const found = rawModels.find(m => m.id === bareId);
            if (found) {
              metadata = {
                id: found.id,
                name: found.name,
                context_length: found.context_length,
                pricing: found.pricing,
                top_provider: found.top_provider,
                supported_parameters: found.supported_parameters,
                architecture: found.architecture,
              };
            }
          }
        } catch {
          // Network error / timeout — fall through to pattern-matching only
        }
      }
    }
  }

  // ── Detect capability ─────────────────────────────────────────────────────
  const capability = detectCapability(trimmedId, metadata);

  // ── Store in per-modelId TTL cache ────────────────────────────────────────
  const now = Date.now();
  MODEL_CAPABILITY_CACHE.set(trimmedId, { capability, cachedAt: now });

  const finalCapability = markedNonReasoning
    ? { ...capability, supportsReasoning: false }
    : capability;

  res.json({
    modelId: trimmedId,
    ...finalCapability,
    fromGracefulDegradationCache: markedNonReasoning,
    cachedAt: now,
  });
});

/**
 * @swagger
 * /api/config/pi-models:
 *   get:
 *     summary: Get available Pi CLI models
 *     description: Detects the local Pi CLI installation and returns the available models from `pi --list-models`. Results are cached in memory for 60 seconds.
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: List of Pi CLI models
 *       404:
 *         description: Pi CLI is not installed
 */
router.get('/pi-models', (_req: Request, res: Response) => {
  const status = detectPi();
  if (!status.piInstalled || !status.piBinPath) {
    throw new DependencyNotFoundError('Pi CLI not installed', 'PI_NOT_FOUND', {
      installMethods: PI_INSTALL_METHODS,
    });
  }

  const now = Date.now();
  const hasFreshCachedModels =
    cachedPiModels &&
    cachedPiModels.models.length > 0 &&
    now - cachedPiModels.ts < 60_000;

  const models = hasFreshCachedModels && cachedPiModels
    ? cachedPiModels.models
    : (() => {
        const freshModels = listPiModels(status.piBinPath!);
        cachedPiModels = freshModels.length > 0 ? { models: freshModels, ts: now } : null;
        return freshModels;
      })();

  res.json({
    models,
    count: models.length,
    piBinPath: status.piBinPath,
  });
});

/**
 * @swagger
 * /api/config/codex-models:
 *   get:
 *     summary: Get available Codex models from local cache
 *     description: Reads ~/.codex/models_cache.json and returns all visible models with their reasoning levels.
 *     responses:
 *       200:
 *         description: List of Codex models
 */
router.get('/codex-models', (_req: Request, res: Response) => {
  const cacheFile = path.join(os.homedir(), '.codex', 'models_cache.json');

  interface CodexReasoningLevel { effort: string; description: string }
  interface CodexModelRaw {
    slug: string;
    display_name: string;
    description?: string;
    visibility: 'list' | 'hide';
    priority: number;
    supported_reasoning_levels?: CodexReasoningLevel[];
    context_window_tokens?: number;
  }
  interface CodexCache { models: CodexModelRaw[] }

  // Hardcoded fallback if cache file is missing.
  // Mirrors current ~/.codex/models_cache.json (fetched 2026-05-01); refresh as
  // OpenAI ships new Codex GPT-5.x models. Codex auto-fetches fresh metadata at
  // runtime, so this list is only used in headless/offline/fresh-install cases.
  const FALLBACK = [
    { id: 'gpt-5.5', label: 'GPT-5.5', reasoningLevels: ['low', 'medium', 'high', 'xhigh'], recommended: true },
    { id: 'gpt-5.4', label: 'GPT-5.4', reasoningLevels: ['low', 'medium', 'high', 'xhigh'], recommended: false },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', reasoningLevels: ['low', 'medium', 'high', 'xhigh'], recommended: false },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3-Codex', reasoningLevels: ['low', 'medium', 'high', 'xhigh'], recommended: false },
    { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark', reasoningLevels: ['low', 'medium', 'high', 'xhigh'], recommended: false },
    { id: 'gpt-5.2', label: 'GPT-5.2', reasoningLevels: ['low', 'medium', 'high', 'xhigh'], recommended: false },
  ];

  try {
    if (!fs.existsSync(cacheFile)) {
      return res.json({ models: FALLBACK, fromCache: false });
    }

    const raw: CodexCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const models = raw.models
      .filter(m => m.visibility === 'list')
      .sort((a, b) => a.priority - b.priority)
      .map((m, i) => ({
        id: m.slug,
        label: m.display_name,
        description: m.description ?? '',
        reasoningLevels: (m.supported_reasoning_levels ?? []).map(r => r.effort),
        contextWindow: m.context_window_tokens ?? null,
        recommended: i === 0, // highest priority = recommended
      }));

    return res.json({ models, fromCache: true });
  } catch {
    return res.json({ models: FALLBACK, fromCache: false });
  }
});

export default router;
