import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne, execute } from '../db/index';
import { withUserClient } from '../db/user-client';
import { validateBody } from '../lib/validate';
import { synthesize } from '../lib/direction-stack';
import { chatComplete } from '../lib/llm-client';
import { DEFAULT_MODEL, ALL_MODELS, getModelsForProviders, fetchOpenRouterModels } from '../lib/llm-client';
import type { ProviderType, ModelInfo } from '../lib/llm-client';
import { detectCapability } from '../lib/reasoning-detector';
import { validateDirectionYaml, getPreviewWarnings } from '../lib/direction-validator';
import { getVaultKey } from './vault';
import { logger } from '../lib/logger';
import { invalidateDirection } from '../lib/context-cache';
import { ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';

const router = Router();

/** Look up team L1/L2 for a workspace via workspace_access */
async function getTeamLayers(workspaceId: string): Promise<{ teamL1?: string; teamL2?: string }> {
  // A workspace may belong to a team via workspace_access
  const access = await queryOne<{ team_id: string }>(
    'SELECT team_id FROM workspace_access WHERE workspace_id = $1 LIMIT 1',
    [workspaceId]
  );

  if (!access) return {};

  const teamL1 = await queryOne<{ content_yaml: string }>(
    `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND team_id = $1 AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = ''`,
    [access.team_id]
  );

  const teamL2 = await queryOne<{ content_yaml: string }>(
    `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND team_id = $1 AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = ''`,
    [access.team_id]
  );

  return {
    teamL1: teamL1?.content_yaml,
    teamL2: teamL2?.content_yaml,
  };
}

/**
 * @swagger
 * /api/direction:
 *   get:
 *     tags: [Direction Stack]
 *     summary: Fetch a single direction layer
 *     operationId: getDirectionLayer
 *     parameters:
 *       - in: query
 *         name: layer
 *         required: true
 *         schema: { type: integer, enum: [1, 2, 3] }
 *       - in: query
 *         name: workspaceId
 *         schema: { type: string }
 *         description: Required for L2 and L3
 *     responses:
 *       200:
 *         description: Direction layer content
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 contentYaml: { type: string }
 *                 preferredModel: { type: string, nullable: true, description: "Only returned for L3" }
 *       400: { description: "Invalid layer" }
 *   put:
 *     tags: [Direction Stack]
 *     summary: Upsert a direction layer
 *     operationId: upsertDirectionLayer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [layer, contentYaml]
 *             properties:
 *               layer: { type: integer, enum: [1, 2, 3] }
 *               workspaceId: { type: string }
 *               domain: { type: string }
 *               contentYaml: { type: string }
 *               preferredModel: { type: string, description: "Only valid for layer 3" }
 *     responses:
 *       200: { description: "Saved", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean } } } } } }
 *       400: { description: "Missing fields or invalid layer" }
 *       422: { description: "Invalid YAML or schema validation error" }
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { layer, workspaceId } = req.query;

    if (!layer || ![1, 2, 3].includes(Number(layer))) {
      throw new ValidationError('layer must be 1, 2, or 3');
      return;
    }

    const layerNum = Number(layer);
    let row: { content_yaml: string } | undefined;

    if (layerNum === 1) {
      row = await withUserClient(req, async (client) => {
        const result = await client.query<{ content_yaml: string }>(
          `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
        );
        return result.rows[0];
      });
    } else if (layerNum === 2) {
      // L2 is domain-scoped; for the panel we fetch workspace-level L2
      row = workspaceId
        ? await withUserClient(req, async (client) => {
            const result = await client.query<{ content_yaml: string }>(
              `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND workspace_id = $1 AND COALESCE(domain, '') = ''`,
              [String(workspaceId)]
            );
            return result.rows[0];
          })
        : undefined;
    } else {
      const l3Row = workspaceId
        ? await withUserClient(req, async (client) => {
            const result = await client.query<{ content_yaml: string; preferred_model: string | null }>(
              `SELECT content_yaml, preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`,
              [String(workspaceId)]
            );
            return result.rows[0];
          })
        : undefined;
      res.json({ contentYaml: l3Row?.content_yaml ?? '', preferredModel: l3Row?.preferred_model ?? null });
      return;
    }

    res.json({ contentYaml: row?.content_yaml ?? '' });
  } catch (err) { next(err); }
});

// PUT /api/direction — upsert a direction layer
const DirectionUpsertSchema = z.object({
  layer: z.number().int().refine(v => [1, 2, 3].includes(v), { message: 'layer must be 1, 2, or 3' }),
  contentYaml: z.string().min(1),
  workspaceId: z.union([z.string(), z.number()]).optional(),
  domain: z.string().optional(),
  preferredModel: z.string().nullable().optional(),
  skipValidation: z.boolean().optional(),
});

/**
 * @swagger
 * /api/direction:
 *   put:
 *     tags: [Direction Stack]
 *     summary: Upsert a direction layer
 *     operationId: upsertDirectionLayer
 *     description: >
 *       Creates or updates a direction layer (L1, L2, or L3) with YAML content.
 *       L1 is global and applies to all workspaces. L2 is scoped to a domain.
 *       L3 is scoped to a specific workspace. The preferredModel field is only
 *       valid for L3 (workspace-scoped layer). Content is validated as YAML
 *       unless skipValidation is true.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [layer, contentYaml]
 *             properties:
 *               layer:
 *                 type: integer
 *                 enum: [1, 2, 3]
 *                 description: Direction layer number (1=global, 2=domain, 3=workspace)
 *                 example: 3
 *               contentYaml:
 *                 type: string
 *                 description: YAML content for the direction layer
 *                 example: "stack: react\ndatabase: postgres"
 *               workspaceId:
 *                 type: string
 *                 description: Required for L3; the workspace this layer applies to
 *                 example: cashflow-ai
 *               domain:
 *                 type: string
 *                 description: Domain tag for L2 layers (e.g. saas, fintech)
 *                 example: saas
 *               preferredModel:
 *                 type: string
 *                 nullable: true
 *                 description: Preferred LLM model for spec generation (L3 only)
 *                 example: claude-sonnet-4-6
 *               skipValidation:
 *                 type: boolean
 *                 description: Skip YAML schema validation (default false)
 *                 example: false
 *     responses:
 *       200:
 *         description: Direction layer upserted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 *       400:
 *         description: preferredModel only valid for layer 3
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       422:
 *         description: Invalid YAML syntax or schema validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.put('/', validateBody(DirectionUpsertSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { layer, workspaceId, domain, contentYaml, preferredModel, skipValidation } = req.body;

    // Validate preferredModel if provided (only valid for L3)
    if (preferredModel !== undefined && preferredModel !== null) {
      if (layer !== 3) {
        throw new ValidationError('preferredModel is only valid for layer 3');
        return;
      }
      // Accept any model string — registered models get cost tracking, unregistered models pass through to openai-compat
    }

    // Validate YAML syntax and per-layer schema (skip for Simple/prose mode)
    if (!skipValidation) {
      const validation = validateDirectionYaml(layer, contentYaml);
      if (validation.yamlError) {
        res.status(422).json({
          error: 'Invalid YAML syntax',
          code: 'UNPROCESSABLE',
          yamlError: validation.yamlError,
        });
        return;
      }
      if (!validation.valid) {
        res.status(422).json({
          error: 'Direction content failed schema validation',
          code: 'UNPROCESSABLE',
          validationErrors: validation.errors,
        });
        return;
      }
    }

    // Upsert via INSERT ... ON CONFLICT (unique index on layer + workspace_id + domain + team_id)
    await execute(`
      INSERT INTO direction_layers (layer, workspace_id, domain, content_yaml, preferred_model, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (layer, COALESCE(workspace_id,''), COALESCE(domain,''), COALESCE(team_id,''))
      DO UPDATE SET content_yaml = EXCLUDED.content_yaml, preferred_model = EXCLUDED.preferred_model, updated_at = NOW()
    `, [layer, workspaceId || null, domain || null, contentYaml, (layer === 3 ? preferredModel ?? null : null)]);

    // PG-013: Invalidate direction cache — global layers affect all workspaces
    if (layer === 1 && !workspaceId) {
      invalidateDirection(); // Global L1 changed — invalidate all
    } else {
      invalidateDirection(workspaceId ? String(workspaceId) : undefined);
    }

    // WAL event
    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('direction_update', $1, $2)`,
      [workspaceId || null, JSON.stringify({ layer, domain: domain || null, ...(preferredModel ? { preferredModel } : {}) })]
    );

    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * @swagger
 * /api/direction/all:
 *   get:
 *     tags: [Direction Stack]
 *     summary: Fetch all direction layers for a workspace
 *     operationId: getAllDirectionLayers
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: All direction layers
 *       400: { description: "Missing workspaceId" }
 */
router.get('/all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { workspaceId } = req.query;

    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }

    const wsId = String(workspaceId);

    // L1: global (no workspace, no domain)
    const l1Row = await queryOne<{ content_yaml: string }>(
      `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
    );

    // L2: workspace-scoped
    const l2Row = await queryOne<{ content_yaml: string }>(
      `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND workspace_id = $1 AND COALESCE(domain, '') = ''`,
      [wsId]
    );

    // L3: workspace-scoped with preferred_model
    const l3Row = await queryOne<{ content_yaml: string; preferred_model: string | null }>(
      `SELECT content_yaml, preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`,
      [wsId]
    );

    // Team L1/L2 overrides
    const teamLayers = await getTeamLayers(wsId);

    res.json({
      layers: {
        l1: { content: l1Row?.content_yaml ?? null, source: teamLayers.teamL1 ? 'team' : 'global' },
        l2: { content: l2Row?.content_yaml ?? null, teamOverride: teamLayers.teamL2 ?? null },
        l3: { content: l3Row?.content_yaml ?? null, preferredModel: l3Row?.preferred_model ?? null },
        l4: { content: null, note: 'L4 (spec brief) is provided per-request, not persisted' },
        l5: { content: null, note: 'L5 (story annotations) is provided per-request, not persisted' },
      },
      teamL1: teamLayers.teamL1 ?? null,
      teamL2: teamLayers.teamL2 ?? null,
    });
  } catch (err) { next(err); }
});

/**
 * @swagger
 * /api/direction/models:
 *   get:
 *     tags: [Direction Stack]
 *     summary: List supported LLM models
 *     operationId: listDirectionModels
 *     responses:
 *       200:
 *         description: Model list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 models:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, example: "claude-sonnet-4-5-20250929" }
 *                       label: { type: string }
 */
router.get('/models', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { workspaceId } = req.query;

    // Resolve workspace default model for "recommended" badge
    let workspaceDefault: string | null = null;
    if (workspaceId) {
      const l3Pref = await queryOne<{ preferred_model: string | null }>(
        `SELECT preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`,
        [String(workspaceId)]
      );
      workspaceDefault = l3Pref?.preferred_model ?? null;
    }

    const recommendedId = workspaceDefault || DEFAULT_MODEL;

    // Determine which providers the user has configured (vault keys + claude-cli always available)
    const configuredProviders: ProviderType[] = ['claude-cli'];

    // Check vault for stored API keys (any user — vault keys indicate configured providers)
    const vaultProviders = await query<{ provider: string }>(
      'SELECT DISTINCT provider FROM api_key_vault'
    );
    for (const row of vaultProviders) {
      if (['anthropic', 'openai-compat', 'openrouter'].includes(row.provider)) {
        configuredProviders.push(row.provider as ProviderType);
      }
    }

    // Also check env vars for API keys
    if (process.env.ANTHROPIC_API_KEY && !configuredProviders.includes('anthropic')) {
      configuredProviders.push('anthropic');
    }
    if (process.env.OPENROUTER_API_KEY && !configuredProviders.includes('openrouter')) {
      configuredProviders.push('openrouter');
    }
    if (process.env.OPENAI_API_KEY && !configuredProviders.includes('openai-compat')) {
      configuredProviders.push('openai-compat');
    }

    // Start with hardcoded models for non-openrouter providers
    let models: ModelInfo[] = getModelsForProviders(configuredProviders);

    // If OpenRouter is configured, fetch live catalog from their API
    if (configuredProviders.includes('openrouter')) {
      let openrouterKey: string | undefined;

      // Try vault first — find any user who has an openrouter key (single-user tool)
      const vaultUser = await queryOne<{ user_id: string }>(
        'SELECT user_id FROM api_key_vault WHERE provider = $1 ORDER BY created_at DESC LIMIT 1',
        ['openrouter']
      );

      if (vaultUser) {
        const result = await getVaultKey(vaultUser.user_id, 'openrouter');
        if (result) openrouterKey = result.key;
      }

      // Fallback to env var
      if (!openrouterKey) {
        openrouterKey = process.env.OPENROUTER_API_KEY;
      }

      if (openrouterKey) {
        try {
          const catalogModels = await fetchOpenRouterModels(openrouterKey);
          // Replace hardcoded openrouter models with live catalog
          models = models.filter(m => m.providerType !== 'openrouter');
          models.push(...catalogModels);
        } catch (err: any) {
          logger.warn('[direction/models] Failed to fetch OpenRouter catalog:', err.message);
          // Keep hardcoded openrouter models as fallback
        }
      }
    }

    res.json({
      models: models.map(info => {
        const cap = detectCapability(info.id, (info as any).metadata);
        return {
          id: info.id,
          label: info.label,
          provider: info.provider,
          providerType: info.providerType,
          costPer1kInput: info.costPer1kInput,
          costPer1kOutput: info.costPer1kOutput,
          contextWindow: info.contextWindow,
          speedTier: info.speedTier,
          costTier: info.costTier,
          recommended: info.id === recommendedId,
          supportsReasoning: cap.supportsReasoning,
          effortLevels: cap.effortLevels,
        };
      }),
      defaultModel: recommendedId,
      configuredProviders,
    });
  } catch (err) { next(err); }
});

/**
 * @swagger
 * /api/direction/models/test:
 *   post:
 *     tags: [Direction Stack]
 *     summary: Test a specific model by sending a minimal prompt
 *     operationId: testDirectionModel
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [modelId]
 *             properties:
 *               modelId: { type: string, description: "Model ID to test" }
 *     responses:
 *       200:
 *         description: Test result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 latencyMs: { type: number }
 *                 response: { type: string }
 *       400: { description: "Missing modelId" }
 *       500: { description: "Model test failed" }
 */
router.post('/models/test', async (req: Request, res: Response, _next: NextFunction) => {
  try {
    const { modelId } = req.body as { modelId?: string };

    if (!modelId || typeof modelId !== 'string') {
      throw new ValidationError('modelId is required');
      return;
    }

    // Resolve provider and API key for this model
    const modelInfo = ALL_MODELS.find(m => m.id === modelId);
    const providerType = modelInfo?.providerType ?? 'claude-cli';

    let apiKey: string | undefined;
    let baseUrl: string | undefined;

    if (providerType !== 'claude-cli' && providerType !== 'anthropic') {
      // Check vault for API key
      const vaultRow = await queryOne<{ user_id: string }>(
        'SELECT user_id FROM api_key_vault WHERE provider = $1 ORDER BY created_at DESC LIMIT 1',
        [providerType]
      );

      if (vaultRow) {
        const result = await getVaultKey(vaultRow.user_id, providerType);
        if (result) {
          apiKey = result.key;
          baseUrl = result.baseUrl ?? undefined;
        }
      }

      // Fallback to env vars
      if (!apiKey) {
        if (providerType === 'openrouter') apiKey = process.env.OPENROUTER_API_KEY;
        else if (providerType === 'openai-compat') apiKey = process.env.OPENAI_API_KEY;
      }
    } else if (providerType === 'anthropic') {
      // Check vault then env
      const vaultRow = await queryOne<{ user_id: string }>(
        'SELECT user_id FROM api_key_vault WHERE provider = $1 ORDER BY created_at DESC LIMIT 1',
        ['anthropic']
      );

      if (vaultRow) {
        const result = await getVaultKey(vaultRow.user_id, 'anthropic');
        if (result) apiKey = result.key;
      }
      if (!apiKey) apiKey = process.env.ANTHROPIC_API_KEY;
    }

    const start = Date.now();
    const result = await chatComplete(
      [{ role: 'user', content: 'Respond with exactly one word: "connected"' }],
      { model: modelId, apiKey, provider: providerType === 'claude-cli' ? 'claude-cli' : undefined, baseUrl },
    );
    const latencyMs = Date.now() - start;

    res.json({
      ok: true,
      latencyMs,
      response: result.text.trim().slice(0, 200),
    });
  } catch (err: any) {
    handleRouteError(res, err, '[direction/models/test]');
  }
});

/**
 * @swagger
 * /api/direction/preview:
 *   get:
 *     tags: [Direction Stack]
 *     summary: Preview synthesized direction stack
 *     operationId: previewDirectionStack
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         schema: { type: string }
 *       - in: query
 *         name: domain
 *         schema: { type: string }
 *       - in: query
 *         name: brief
 *         required: true
 *         schema: { type: string }
 *         description: The spec brief text (L4)
 *     responses:
 *       200:
 *         description: Synthesized direction stack preview
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 synthesized: { type: string }
 *                 schemaTableCount: { type: integer, nullable: true }
 *                 gitCommitCount: { type: integer, nullable: true }
 *                 warnings: { type: array, items: { type: string } }
 *       400: { description: "Missing brief" }
 */
router.get('/preview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { workspaceId, domain, brief } = req.query;

    if (!brief) {
      throw new ValidationError('Missing required query param: brief');
      return;
    }

    // Fetch layers
    const l1Row = await queryOne<{ content_yaml: string }>(
      `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
    );

    const l2Row = domain
      ? await queryOne<{ content_yaml: string }>(
          `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND domain = $1 AND COALESCE(workspace_id, '') = ''`,
          [String(domain)]
        )
      : undefined;

    const l3Row = workspaceId
      ? await queryOne<{ content_yaml: string }>(
          `SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`,
          [String(workspaceId)]
        )
      : undefined;

    // Fetch auto-hydrated context from workspace_context
    let schemaSnapshot: string | undefined;
    let schemaTableCount: number | null = null;
    let gitCommitCount: number | null = null;

    if (workspaceId) {
      const ctx = await queryOne<{
        schema_snapshot: string | null;
        schema_table_count: number | null;
        git_commit_count: number | null;
      }>(
        `SELECT schema_snapshot, schema_table_count, git_commit_count
         FROM workspace_context WHERE workspace_id = $1`,
        [String(workspaceId)]
      );

      if (ctx) {
        schemaSnapshot = ctx.schema_snapshot || undefined;
        schemaTableCount = ctx.schema_table_count;
        gitCommitCount = ctx.git_commit_count;
      }
    }

    // Look up workspace domains for mismatch detection
    let workspaceDomains: string[] | undefined;
    if (workspaceId) {
      const wsRow = await queryOne<{ domains: string | null }>(
        `SELECT domains FROM workspaces WHERE id = $1`,
        [String(workspaceId)]
      );
      if (wsRow?.domains) {
        try { workspaceDomains = JSON.parse(wsRow.domains); } catch { /* ignore */ }
      }
    }

    // Fetch team L1/L2 if workspace belongs to a team
    const teamLayers = workspaceId ? await getTeamLayers(String(workspaceId)) : {};

    const warnings = getPreviewWarnings({
      l1Content: l1Row?.content_yaml,
      l2Content: l2Row?.content_yaml,
      l3Content: l3Row?.content_yaml,
      workspaceId: workspaceId ? String(workspaceId) : undefined,
      domain: domain ? String(domain) : undefined,
      workspaceDomains,
    });

    const synthesized = synthesize({
      l1: l1Row?.content_yaml,
      l2: l2Row?.content_yaml,
      teamL1: teamLayers.teamL1,
      teamL2: teamLayers.teamL2,
      l3: l3Row?.content_yaml,
      schemaSnapshot,
      specBrief: String(brief),
    });

    res.json({ synthesized, schemaTableCount, gitCommitCount, warnings });
  } catch (err) { next(err); }
});

/**
 * @swagger
 * /api/direction/synthesize:
 *   post:
 *     tags: [Direction Stack]
 *     summary: Synthesize direction stack with L4/L5 content
 *     operationId: synthesizeDirectionStack
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               workspaceId: { type: string }
 *               l4SpecBrief: { type: string, description: "Spec brief (L4)" }
 *               l5Annotations: { type: string, description: "Story annotations (L5)" }
 *     responses:
 *       200:
 *         description: Synthesized direction stack
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 synthesized: { type: string }
 */
router.post('/synthesize', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { workspaceId, l4SpecBrief, l5Annotations } = req.body;

    // Fetch persisted layers
    const l1Row = await queryOne<{ content_yaml: string }>(
      `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
    );

    const l2Row = workspaceId
      ? await queryOne<{ content_yaml: string }>(
          `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND workspace_id = $1 AND COALESCE(domain, '') = ''`,
          [String(workspaceId)]
        )
      : undefined;

    const l3Row = workspaceId
      ? await queryOne<{ content_yaml: string }>(
          `SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`,
          [String(workspaceId)]
        )
      : undefined;

    // Fetch auto-hydrated context
    let schemaSnapshot: string | undefined;

    if (workspaceId) {
      const ctx = await queryOne<{ schema_snapshot: string | null }>(
        `SELECT schema_snapshot FROM workspace_context WHERE workspace_id = $1`,
        [String(workspaceId)]
      );

      if (ctx) {
        schemaSnapshot = ctx.schema_snapshot || undefined;
      }
    }

    // Fetch team L1/L2 if workspace belongs to a team
    const teamLayers = workspaceId ? await getTeamLayers(String(workspaceId)) : {};

    const synthesized = synthesize({
      l1: l1Row?.content_yaml,
      l2: l2Row?.content_yaml,
      teamL1: teamLayers.teamL1,
      teamL2: teamLayers.teamL2,
      l3: l3Row?.content_yaml,
      schemaSnapshot,
      specBrief: l4SpecBrief || '',
      storyAnnotations: l5Annotations || undefined,
    });

    res.json({ synthesized });
  } catch (err) { next(err); }
});

/**
 * @swagger
 * /api/direction/wizard:
 *   post:
 *     tags: [Direction Stack]
 *     summary: AI Setup Wizard for direction stack
 *     operationId: runDirectionWizard
 *     description: Takes plain-English answers to 5-7 setup questions and uses an LLM to generate L1 (global), L2 (domain), and L3 (project) direction layer YAML content. L3 output is validated against the direction schema.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [answers]
 *             properties:
 *               answers:
 *                 type: object
 *                 additionalProperties: { type: string }
 *                 description: "Key-value pairs of wizard question answers"
 *     responses:
 *       200:
 *         description: Generated direction layer content
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 l1: { type: string, description: "Generated L1 YAML content" }
 *                 l2: { type: string, description: "Generated L2 YAML content" }
 *                 l3: { type: string, description: "Generated L3 YAML content" }
 *                 l3Valid: { type: boolean, description: "Whether L3 passes schema validation" }
 *                 l3Errors: { type: array, items: { type: string }, description: "Validation errors for L3" }
 *                 usage: { type: object, description: "LLM token usage" }
 *       400: { description: "Missing or empty answers object" }
 *       502: { description: "LLM returned invalid JSON or missing l1/l2/l3 keys" }
 *       500: { description: "Wizard generation failed" }
 */
router.post('/wizard', async (req: Request, res: Response, _next: NextFunction) => {
  try {
    const { answers } = req.body as { answers: Record<string, string> };

    if (!answers || typeof answers !== 'object' || Object.keys(answers).length === 0) {
      throw new ValidationError('answers object is required and must not be empty');
      return;
    }

    // Build a structured summary of answers for the LLM
    const answerText = Object.entries(answers)
      .filter(([, v]) => v && v.trim())
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');

    const prompt = `=== INSTRUCTIONS: READ THIS FIRST ===
You MUST return ONLY a JSON object. No markdown fences, no explanation, no preamble.
The JSON object must have exactly three keys: "l1", "l2", "l3".
Each value is a string containing valid YAML for that direction layer.

=== CONTEXT ===
You are an AI assistant helping set up a "Direction Stack" for a software project.
The Direction Stack has 3 persistent layers:

L1 (Global Brain): Global engineering principles, coding style, output format preferences, things to always/never do. This is plain text or YAML — any format is valid.

L2 (Domain Profile): Domain-specific knowledge — industry concepts, regulatory constraints, business terminology, domain-specific patterns. This is plain text or YAML — any format is valid.

L3 (Project Brief): Project-specific context. This MUST be a YAML mapping with these required fields:
  - name: string (project name)
  - type: string (e.g. "web-app", "api", "cli", "mobile-app")
  - stack: array of strings (technologies used)
  - purpose: string (what the project does)
  - key_modules: array of strings (main components/modules)

Additional optional L3 fields: constraints, v1_done, deployment_target, team_size, integrations

=== USER ANSWERS ===
${answerText}

=== OUTPUT FORMAT ===
Return a JSON object with exactly this structure (no markdown, no fences):
{
  "l1": "the L1 YAML content as a string",
  "l2": "the L2 YAML content as a string",
  "l3": "the L3 YAML content as a string"
}

Generate thoughtful, specific content for each layer based on the user's answers. Make reasonable inferences where information is incomplete. L3 MUST include name, type, stack, purpose, and key_modules fields.`;

    const result = await chatComplete([{ role: 'user', content: prompt }]);
    let text = result.text.trim();

    // Strip markdown fences if LLM wrapped them
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    let parsed: { l1: string; l2: string; l3: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      res.status(502).json({ error: 'LLM returned invalid JSON', raw: text.slice(0, 500) });
      return;
    }

    if (!parsed.l1 || !parsed.l2 || !parsed.l3) {
      res.status(502).json({ error: 'LLM response missing required l1/l2/l3 keys', raw: text.slice(0, 500) });
      return;
    }

    // Validate L3 against the direction schema
    const l3Validation = validateDirectionYaml(3, parsed.l3);

    res.json({
      l1: parsed.l1,
      l2: parsed.l2,
      l3: parsed.l3,
      l3Valid: l3Validation.valid,
      l3Errors: l3Validation.errors,
      usage: result.usage,
    });
  } catch (err: any) {
    handleRouteError(res, err, '[direction/wizard]');
  }
});

export default router;
