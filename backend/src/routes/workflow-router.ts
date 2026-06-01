/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { execute, query, queryOne } from '../db/index';
import { resolveWorkflowConfig } from '../lib/workflow-config-resolver';
import { NotFoundError, UnprocessableError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';

const router = Router();

const VALID_WORKFLOW_IDS = ['spec_generation', 'pipeline_execution', 'memory_consolidation'] as const;

// Zod schema for PUT body
const UpdateWorkflowConfigSchema = z.object({
  runtime: z.enum(['native', 'claude', 'opencode', 'codex', 'pi']).optional(),
  provider: z.string().min(1).optional(),
  model: z.string().nullable().optional(),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function maskApiKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

interface WorkflowConfigRow {
  workflow_id: string;
  runtime: string;
  provider: string;
  model: string | null;
  updated_at: string;
}

interface VaultKeyCheck {
  provider: string;
  has_key: boolean;
}

// ─── GET /api/workflow-router ───────────────────────────────────────────────

/**
 * @swagger
 * /api/workflow-router:
 *   get:
 *     tags: [Workflow Router]
 *     summary: List all workflow configurations
 *     operationId: listWorkflowConfigs
 *     description: Returns all 3 workflow_configs rows joined with vault key status (hasApiKey boolean per provider).
 *     responses:
 *       200:
 *         description: Array of workflow configuration objects
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   workflowId:
 *                     type: string
 *                     enum: [spec_generation, pipeline_execution, memory_consolidation]
 *                   runtime:
 *                     type: string
 *                     enum: [native, claude, opencode, codex, pi]
 *                   provider:
 *                     type: string
 *                   model:
 *                     type: string
 *                     nullable: true
 *                   hasApiKey:
 *                     type: boolean
 *                   updatedAt:
 *                     type: string
 *                     format: date-time
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const rows = await query<WorkflowConfigRow>(
      'SELECT workflow_id, runtime, provider, model, updated_at FROM workflow_configs ORDER BY workflow_id',
    );

    // Get the requesting user for vault key checks
    const user = (req as any).user;
    const userId: string | null = user?.id ?? null;

    // Check which providers have vault keys
    const providerHasKey = new Map<string, boolean>();
    if (userId) {
      const vaultRows = await query<VaultKeyCheck>(
        `SELECT DISTINCT provider, TRUE AS has_key FROM api_key_vault WHERE user_id = $1`,
        [userId],
      );
      for (const vr of vaultRows) {
        providerHasKey.set(vr.provider, true);
      }
    }

    const result = rows.map((row) => ({
      workflowId: row.workflow_id,
      runtime: row.runtime,
      provider: row.provider,
      model: row.model,
      hasApiKey: providerHasKey.get(row.provider) ?? false,
      updatedAt: row.updated_at,
    }));

    res.json(result);
  } catch (error) {
    handleRouteError(res, error, '[WorkflowRouter] List');
  }
});

// ─── PUT /api/workflow-router/:workflowId ───────────────────────────────────

/**
 * @swagger
 * /api/workflow-router/{workflowId}:
 *   put:
 *     tags: [Workflow Router]
 *     summary: Update a workflow configuration
 *     operationId: updateWorkflowConfig
 *     description: Upserts a single workflow_configs row. Validates that workflowId is one of the 3 allowed values. Rejects runtime != 'native' for spec_generation and memory_consolidation with 422.
 *     parameters:
 *       - in: path
 *         name: workflowId
 *         required: true
 *         schema:
 *           type: string
 *           enum: [spec_generation, pipeline_execution, memory_consolidation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               runtime:
 *                 type: string
 *                 enum: [native, claude, opencode, codex, pi]
 *               provider:
 *                 type: string
 *               model:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Updated workflow configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workflowId:
 *                   type: string
 *                 runtime:
 *                   type: string
 *                 provider:
 *                   type: string
 *                 model:
 *                   type: string
 *                   nullable: true
 *                 updatedAt:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Invalid request body
 *       404:
 *         description: Unknown workflowId
 *       422:
 *         description: Runtime constraint violation
 */
router.put('/:workflowId', async (req: Request, res: Response) => {
  try {
    const workflowId = req.params.workflowId as string;

    // Validate workflowId — treat unknown values as input validation errors (422)
    if (!(VALID_WORKFLOW_IDS as readonly string[]).includes(workflowId)) {
      throw new UnprocessableError(
        `Invalid workflowId: '${workflowId}'. Must be one of: ${VALID_WORKFLOW_IDS.join(', ')}`,
        undefined,
        { workflowId, allowed: VALID_WORKFLOW_IDS },
      );
    }

    // Parse and validate body
    const parsed = UpdateWorkflowConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid request body', {
        issues: JSON.stringify(parsed.error.issues),
      });
    }

    const { runtime, provider, model } = parsed.data;

    // Runtime constraint: spec_generation and memory_consolidation must be 'native'
    if (runtime && runtime !== 'native' && (workflowId === 'spec_generation' || workflowId === 'memory_consolidation')) {
      throw new UnprocessableError(
        `Workflow '${workflowId}' only supports runtime 'native'`,
        undefined,
        { workflowId, requestedRuntime: runtime },
      );
    }

    // Build SET clause dynamically based on provided fields
    const setClauses: string[] = ['updated_at = NOW()'];
    const params: (string | null)[] = [workflowId];
    let paramIndex = 2;

    if (runtime !== undefined) {
      setClauses.push(`runtime = $${paramIndex++}`);
      params.push(runtime);
    }
    if (provider !== undefined) {
      setClauses.push(`provider = $${paramIndex++}`);
      params.push(provider);
    }
    if (model !== undefined) {
      setClauses.push(`model = $${paramIndex++}`);
      params.push(model);
    }

    const row = await queryOne<WorkflowConfigRow>(
      `UPDATE workflow_configs SET ${setClauses.join(', ')} WHERE workflow_id = $1
       RETURNING workflow_id, runtime, provider, model, updated_at`,
      params,
    );

    if (!row) {
      throw new NotFoundError(`Workflow config not found: ${workflowId}`);
    }

    if (workflowId === 'pipeline_execution' && runtime !== undefined) {
      await execute(
        `INSERT INTO agent_config (id, agent_type, agent_model, updated_at)
         VALUES ('default', $1, $2, NOW())
         ON CONFLICT (id) DO UPDATE SET
           agent_type = EXCLUDED.agent_type,
           agent_model = COALESCE(EXCLUDED.agent_model, agent_config.agent_model),
           updated_at = NOW()`,
        [row.runtime, row.model],
      );
    }

    res.json({
      workflowId: row.workflow_id,
      runtime: row.runtime,
      provider: row.provider,
      model: row.model,
      updatedAt: row.updated_at,
    });
  } catch (error) {
    handleRouteError(res, error, '[WorkflowRouter] Update');
  }
});

// ─── GET /api/workflow-router/resolved/:workflowId ──────────────────────────

/**
 * @swagger
 * /api/workflow-router/resolved/{workflowId}:
 *   get:
 *     tags: [Workflow Router]
 *     summary: Get fully resolved workflow configuration
 *     operationId: getResolvedWorkflowConfig
 *     description: Calls resolveWorkflowConfig() and returns the fully resolved config with the API key masked (first 4 + last 4 chars only).
 *     parameters:
 *       - in: path
 *         name: workflowId
 *         required: true
 *         schema:
 *           type: string
 *           enum: [spec_generation, pipeline_execution, memory_consolidation]
 *     responses:
 *       200:
 *         description: Resolved workflow configuration with masked API key
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workflowId:
 *                   type: string
 *                 runtime:
 *                   type: string
 *                 provider:
 *                   type: string
 *                 model:
 *                   type: string
 *                   nullable: true
 *                 apiKey:
 *                   type: string
 *                   nullable: true
 *                   description: Masked API key (e.g. 'sk-a...xyz9') or null
 *                 baseUrl:
 *                   type: string
 *                   nullable: true
 *       404:
 *         description: Unknown workflowId
 */
router.get('/resolved/:workflowId', async (req: Request, res: Response) => {
  try {
    const workflowId = req.params.workflowId as string;

    if (!(VALID_WORKFLOW_IDS as readonly string[]).includes(workflowId)) {
      throw new NotFoundError(`Unknown workflowId: ${workflowId}`);
    }

    const user = (req as any).user;
    const userId: string | undefined = user?.id;

    const resolved = await resolveWorkflowConfig(workflowId, userId);

    res.json({
      workflowId: resolved.workflowId,
      runtime: resolved.runtime,
      provider: resolved.provider,
      model: resolved.model,
      apiKey: maskApiKey(resolved.apiKey),
      baseUrl: resolved.baseUrl,
    });
  } catch (error) {
    handleRouteError(res, error, '[WorkflowRouter] Resolved');
  }
});

export default router;
