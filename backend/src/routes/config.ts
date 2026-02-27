import { Router, Request, Response } from 'express';
import { agentType, agentModel, AgentType, VALID_AGENT_TYPES, validateOrchestrationConfig } from '../lib/config';
import { loadOrchestrationConfig, clearConfigCache } from '../lib/complexity-scorer';
import { detectOpenCode } from '../lib/opencode-detector';
import { detectCodex } from '../lib/codex-detector';
import { getClaudeAuthState, triggerClaudeLogin, triggerClaudeLogout } from '../lib/claude-auth';
import { getCodexAuthState, triggerCodexLogin, triggerCodexLogout } from '../lib/codex-auth';
import { db } from '../db';
import { getVaultKey } from './vault';
import * as fs from 'fs';
import * as path from 'path';

const router = Router();

// ─── In-memory mutable config (hot-reloaded via PUT /agent) ──────────────────
// Load persisted config from DB if available, otherwise fall back to env vars
function loadPersistedConfig(): { agentType: AgentType; agentModel: string | null } {
  try {
    const row = db.prepare('SELECT agent_type, agent_model FROM agent_config WHERE id = ?').get('default') as
      { agent_type: string; agent_model: string | null } | undefined;
    if (row && (VALID_AGENT_TYPES as readonly string[]).includes(row.agent_type)) {
      return { agentType: row.agent_type as AgentType, agentModel: row.agent_model };
    }
  } catch {
    // Table may not exist yet on first run — fall through to env defaults
  }
  return { agentType, agentModel };
}

const persisted = loadPersistedConfig();
let currentAgentType: AgentType = persisted.agentType;
let currentAgentModel: string | null = persisted.agentModel;

export function getActiveAgentType(): AgentType { return currentAgentType; }
export function getActiveAgentModel(): string | null { return currentAgentModel; }

// ─── OpenCode model catalog (Models.dev compatible) ──────────────────────────
interface OpenCodeModel {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
}

const OPENCODE_MODELS: OpenCodeModel[] = [
  // OpenAI
  { id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'OpenAI', contextWindow: 128000 },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', provider: 'OpenAI', contextWindow: 128000 },
  { id: 'openai/o3', name: 'o3', provider: 'OpenAI', contextWindow: 200000 },
  { id: 'openai/o3-mini', name: 'o3 Mini', provider: 'OpenAI', contextWindow: 200000 },
  { id: 'openai/o4-mini', name: 'o4 Mini', provider: 'OpenAI', contextWindow: 200000 },
  // Google
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'Google', contextWindow: 1048576 },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'Google', contextWindow: 1048576 },
  { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'Google', contextWindow: 1048576 },
  // Anthropic
  { id: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'Anthropic', contextWindow: 200000 },
  { id: 'anthropic/claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', provider: 'Anthropic', contextWindow: 200000 },
  { id: 'anthropic/claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'Anthropic', contextWindow: 200000 },
  // OpenRouter
  { id: 'openrouter/auto', name: 'Auto (Best Available)', provider: 'OpenRouter', contextWindow: 200000 },
  { id: 'openrouter/deepseek/deepseek-r1', name: 'DeepSeek R1', provider: 'OpenRouter', contextWindow: 131072 },
  { id: 'openrouter/meta-llama/llama-4-maverick', name: 'Llama 4 Maverick', provider: 'OpenRouter', contextWindow: 1048576 },
  // GitHub Copilot (subscription-based — no API key, uses OAuth token)
  { id: 'github/copilot', name: 'GitHub Copilot', provider: 'GitHub Copilot', contextWindow: 128000 },
  // Local
  { id: 'ollama/llama3.3', name: 'Llama 3.3 (Ollama)', provider: 'Local', contextWindow: 131072 },
  { id: 'ollama/deepseek-r1:14b', name: 'DeepSeek R1 14B (Ollama)', provider: 'Local', contextWindow: 131072 },
  { id: 'ollama/qwen2.5-coder:14b', name: 'Qwen 2.5 Coder 14B (Ollama)', provider: 'Local', contextWindow: 131072 },
];

// Map provider group to the vault provider keys that satisfy it
const PROVIDER_KEY_MAP: Record<string, string[]> = {
  OpenAI: ['openai-compat'],
  Google: ['openai-compat'],
  Anthropic: ['anthropic'],
  OpenRouter: ['openrouter'],
  'GitHub Copilot': [], // Uses OAuth token from integration_credentials, not vault
  Local: [], // No API key required
};

/**
 * @swagger
 * /api/config:
 *   get:
 *     summary: Get agent configuration
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: Current agent configuration
 */
router.get('/', (_req: Request, res: Response) => {
  // Always detect both — UI needs status to show install badges when user toggles
  const opencode = detectOpenCode();
  const codex = detectCodex();

  // Determine if user has an API key for the selected model's provider
  let hasApiKey = true; // claude doesn't need one
  let modelDisplayName: string | null = null;
  let copilotConnected = false;
  let copilotUsername: string | null = null;

  if (currentAgentType === 'opencode') {
    if (currentAgentModel) {
      const modelEntry = OPENCODE_MODELS.find(m => m.id === currentAgentModel);
      if (currentAgentModel.startsWith('openrouter/') && !modelEntry) {
        // OpenRouter model from live catalog — extract provider family and model name
        const orModelId = currentAgentModel.slice('openrouter/'.length); // e.g. "meta-llama/llama-3.3-70b"
        modelDisplayName = orModelId;
        // Check for OpenRouter API key
        const orKeyRow = db.prepare(
          `SELECT 1 FROM api_key_vault WHERE provider = 'openrouter' LIMIT 1`
        ).get();
        hasApiKey = !!orKeyRow || !!process.env.OPENROUTER_API_KEY;
      } else {
        modelDisplayName = modelEntry?.name ?? currentAgentModel.split('/').pop() ?? currentAgentModel;
      }
      if (modelEntry) {
        if (modelEntry.provider === 'GitHub Copilot') {
          // Copilot uses integration_credentials, not api_key_vault
          const copilotRow = db.prepare(
            `SELECT provider_username FROM integration_credentials WHERE provider = 'github_copilot' LIMIT 1`
          ).get() as { provider_username: string | null } | undefined;
          hasApiKey = !!copilotRow;
          copilotConnected = !!copilotRow;
          copilotUsername = copilotRow?.provider_username ?? null;
        } else {
          const requiredProviders = PROVIDER_KEY_MAP[modelEntry.provider] ?? [];
          if (requiredProviders.length > 0) {
            const placeholders = requiredProviders.map(() => '?').join(',');
            const row = db.prepare(
              `SELECT 1 FROM api_key_vault WHERE provider IN (${placeholders}) LIMIT 1`
            ).get(...requiredProviders);
            hasApiKey = !!row;
          }
          // Local models don't need a key
        }
      }
    } else {
      hasApiKey = false; // No model configured at all
    }
  }

  // Always check Copilot connection status for UI display
  if (!copilotConnected) {
    const copilotRow = db.prepare(
      `SELECT provider_username FROM integration_credentials WHERE provider = 'github_copilot' LIMIT 1`
    ).get() as { provider_username: string | null } | undefined;
    copilotConnected = !!copilotRow;
    copilotUsername = copilotRow?.provider_username ?? null;
  }

  res.json({
    agentType: currentAgentType,
    agentModel: currentAgentModel,
    modelDisplayName,
    hasApiKey,
    copilotConnected,
    copilotUsername,
    opencodeInstalled: opencode.opencodeInstalled,
    opencodeVersion: opencode.opencodeVersion,
    codexInstalled: codex.codexInstalled,
    codexVersion: codex.codexVersion,
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
function resolveOpenRouterKey(): string | null {
  // Check vault first (any user — auth is bypassed globally)
  try {
    const userId = (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string } | undefined)?.id;
    if (userId) {
      const vaultResult = getVaultKey(userId, 'openrouter');
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

  const apiKey = resolveOpenRouterKey();
  if (!apiKey) {
    res.status(401).json({ error: 'No OpenRouter API key configured. Add one in Settings > Provider Configuration.' });
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
        res.status(401).json({ error: 'Invalid OpenRouter API key.' });
        return;
      }
      if (status === 429) {
        res.status(429).json({ error: 'OpenRouter rate limited. Try again later.' });
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
      .map(m => ({
        id: m.id,
        name: m.name,
        provider: getOpenRouterProviderFamily(m.id),
        contextWindow: m.context_length,
        free: parseFloat(m.pricing?.prompt ?? '1') === 0 && parseFloat(m.pricing?.completion ?? '1') === 0,
        pricingPrompt: parseFloat(m.pricing?.prompt ?? '0'),
        pricingCompletion: parseFloat(m.pricing?.completion ?? '0'),
      }))
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
  const apiKey = key || resolveOpenRouterKey();

  if (!apiKey) {
    res.status(400).json({ ok: false, error: 'No API key provided or stored.' });
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
 *     summary: Update agent configuration (hot-reload, no restart required)
 *     tags: [Config]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               agentType:
 *                 type: string
 *                 enum: [claude, opencode, codex]
 *               agentModel:
 *                 type: string
 *     responses:
 *       200:
 *         description: Configuration updated
 *       400:
 *         description: Validation error
 */
router.put('/agent', async (req: Request, res: Response) => {
  const { agentType: newType, agentModel: newModel } = req.body;

  // Validate agentType
  if (newType !== undefined) {
    if (!(VALID_AGENT_TYPES as readonly string[]).includes(newType)) {
      res.status(400).json({
        error: `Invalid agentType "${newType}". Must be one of: ${VALID_AGENT_TYPES.join(', ')}`,
      });
      return;
    }

    // When switching to opencode, verify binary is available
    if (newType === 'opencode') {
      const status = detectOpenCode();
      if (!status.opencodeInstalled) {
        res.status(400).json({
          error: 'OpenCode binary not found. Install it first: npm i -g opencode',
        });
        return;
      }
    }

    // OC-024: When switching to codex, verify binary is available
    if (newType === 'codex') {
      const status = detectCodex();
      if (!status.codexInstalled) {
        res.status(400).json({
          error: 'Codex CLI not found. Install it first: npm i -g @openai/codex',
        });
        return;
      }
    }
  }

  // Validate model requires API key for OpenCode models
  const effectiveType = newType ?? currentAgentType;
  const effectiveModel = newModel !== undefined ? newModel : currentAgentModel;

  if (effectiveType === 'opencode' && effectiveModel) {
    // Ollama models: validate Ollama is running instead of checking API key
    if (effectiveModel.startsWith('ollama/')) {
      const ollamaStatus = await detectOllama();
      if (!ollamaStatus.available) {
        res.status(400).json({
          error: 'Ollama not detected. Start with: ollama serve',
        });
        return;
      }
    } else {
      // Non-Ollama models: check API key as before
    }

    // OC-027: OpenRouter models from live catalog (not in OPENCODE_MODELS) need key validation
    if (effectiveModel.startsWith('openrouter/') && !OPENCODE_MODELS.find(m => m.id === effectiveModel)) {
      const orKey = resolveOpenRouterKey();
      if (!orKey) {
        res.status(400).json({
          error: 'OpenRouter models require an API key. Add one in the OpenRouter card above.',
        });
        return;
      }
    }

    const modelEntry = OPENCODE_MODELS.find(m => m.id === effectiveModel);
    if (modelEntry) {
      if (modelEntry.provider === 'GitHub Copilot') {
        // Copilot uses integration_credentials, not api_key_vault
        const copilotRow = db.prepare(
          `SELECT 1 FROM integration_credentials WHERE provider = 'github_copilot' LIMIT 1`
        ).get();
        if (!copilotRow) {
          res.status(400).json({
            error: 'GitHub Copilot requires connecting your GitHub account first. Use "Sign in with GitHub" below.',
          });
          return;
        }
      } else {
        const requiredProviders = PROVIDER_KEY_MAP[modelEntry.provider] ?? [];
        if (requiredProviders.length > 0) {
          // Check if user has any vault key for the required providers
          const placeholders = requiredProviders.map(() => '?').join(',');
          const hasKey = db.prepare(
            `SELECT 1 FROM api_key_vault WHERE provider IN (${placeholders}) LIMIT 1`
          ).get(...requiredProviders);
          if (!hasKey) {
            res.status(400).json({
              error: `Model "${effectiveModel}" requires a ${modelEntry.provider} API key. Add one in Provider Configuration above.`,
            });
            return;
          }
        }
      }
    }
  }

  // Apply changes
  if (newType !== undefined) currentAgentType = newType as AgentType;
  if (newModel !== undefined) currentAgentModel = newModel || null;

  // Persist to DB (agent_config row) for survival across restarts
  db.prepare(`
    INSERT INTO agent_config (id, agent_type, agent_model, updated_at)
    VALUES ('default', ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      agent_type = excluded.agent_type,
      agent_model = excluded.agent_model,
      updated_at = excluded.updated_at
  `).run(currentAgentType, currentAgentModel);

  res.json({
    agentType: currentAgentType,
    agentModel: currentAgentModel,
  });
});

// ─── Orchestration Config (OC-021) ────────────────────────────────────────────

function resolveWorkspacePath(workspaceId: string | undefined): string | null {
  if (!workspaceId) return null;
  try {
    const row = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(workspaceId) as { path: string } | undefined;
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
router.get('/orchestration', (req: Request, res: Response) => {
  const workspaceId = req.query.workspaceId as string | undefined;
  const cwd = resolveWorkspacePath(workspaceId);
  const config = loadOrchestrationConfig(cwd ?? undefined);

  // Return threshold ranges for frontend display
  res.json({
    router: config.router,
    thresholds: {
      haiku: [0, config.thresholds.haiku],
      sonnet: [config.thresholds.haiku + 1, config.thresholds.sonnet],
      opus: [config.thresholds.sonnet + 1, 100],
    },
    cascades: config.cascades,
    taskCascades: config.taskCascades,
    escalation: config.escalation,
    tokenBudgetPerStory: config.tokenBudgetPerStory,
  });
});

/**
 * @swagger
 * /api/config/orchestration:
 *   put:
 *     summary: Update orchestration config in .rorca/config.json
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
router.put('/orchestration', (req: Request, res: Response) => {
  const { workspaceId, orchestration } = req.body;

  const cwd = resolveWorkspacePath(workspaceId);
  if (!cwd) {
    res.status(404).json({ error: 'Workspace not found. Select a workspace first.' });
    return;
  }

  // Validate
  const validationErrors = validateOrchestrationConfig(orchestration);
  if (validationErrors.length > 0) {
    res.status(400).json({ error: 'Orchestration config validation failed', details: validationErrors });
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
    cascades: merged.cascades,
    taskCascades: merged.taskCascades,
    escalation: merged.escalation,
    tokenBudgetPerStory: merged.tokenBudgetPerStory,
  });
});

// ─── Claude Auth Detection (OC-025) ──────────────────────────────────────────

/**
 * @swagger
 * /api/config/claude-auth:
 *   get:
 *     summary: Get Claude subscription auth state (no raw token exposed)
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
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true, message: 'Claude auth login triggered. Complete sign-in in your browser.' });
});

/**
 * @swagger
 * /api/config/claude-auth/logout:
 *   post:
 *     summary: Trigger Claude CLI auth logout
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
    res.status(400).json({ error: result.error });
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
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true, message: 'Codex login triggered. Complete sign-in in your browser.' });
});

/**
 * @swagger
 * /api/config/codex-auth/logout:
 *   post:
 *     summary: Trigger Codex CLI logout (remove stored credentials)
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
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true, message: 'ChatGPT account disconnected.' });
});

export default router;
