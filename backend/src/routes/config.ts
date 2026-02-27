import { Router, Request, Response } from 'express';
import { agentType, agentModel, AgentType, VALID_AGENT_TYPES } from '../lib/config';
import { detectOpenCode } from '../lib/opencode-detector';
import { db } from '../db';

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
  const opencode = currentAgentType === 'opencode' ? detectOpenCode() : null;

  // Determine if user has an API key for the selected model's provider
  let hasApiKey = true; // claude doesn't need one
  let modelDisplayName: string | null = null;
  if (currentAgentType === 'opencode') {
    if (currentAgentModel) {
      const modelEntry = OPENCODE_MODELS.find(m => m.id === currentAgentModel);
      modelDisplayName = modelEntry?.name ?? currentAgentModel.split('/').pop() ?? currentAgentModel;
      if (modelEntry) {
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
    } else {
      hasApiKey = false; // No model configured at all
    }
  }

  res.json({
    agentType: currentAgentType,
    agentModel: currentAgentModel,
    modelDisplayName,
    hasApiKey,
    opencodeInstalled: opencode?.opencodeInstalled ?? null,
    opencodeVersion: opencode?.opencodeVersion ?? null,
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
 *                 enum: [claude, opencode]
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

    const modelEntry = OPENCODE_MODELS.find(m => m.id === effectiveModel);
    if (modelEntry) {
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

export default router;
