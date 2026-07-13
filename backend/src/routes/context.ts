/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import * as path from 'path';
import { z } from 'zod';
import {
  extractContext,
  combineMultiSources,
  buildExtractionPrompt,
  parseExtractionResponse,
  approxTokenCount,
  fetchUrlPreview,
  type ExtractRequest,
} from '../lib/context-extractor';
import { validateBody } from '../lib/validate';
import { chatComplete } from '../lib/llm-client';
import { handleRouteError } from '../lib/async-handler';
import { ValidationError, UnprocessableError, NotFoundError } from '../lib/errors';
import { createJob, updateJobStatus } from '../db/spec-jobs';
import { getBoss } from '../lib/pg-boss';
import { queryOne } from '../db/index';
import { buildContextHealthSummary } from '../lib/auto-memory';
import { readSafeContextFilePreview } from '../lib/context-safety';

const router = Router();

const ContextEnrichQuerySchema = z.object({
  mode: z.enum(['fetchAll', 'recent', 'semantic']).default('semantic'),
});

const ContextEnrichBodySchema = z.object({
  workspaceId: z.string().min(1),
  specId: z.string().min(1),
  storyId: z.string().min(1).optional(),
  currentTask: z.string().min(1).optional(),
  storyText: z.string().min(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  includeGraph: z.boolean().optional(),
});

async function enqueueContextEnrichmentJob(input: z.infer<typeof ContextEnrichBodySchema> & z.infer<typeof ContextEnrichQuerySchema>) {
  const requestPayload = {
    mode: input.mode,
    storyId: input.storyId ?? null,
    currentTask: input.currentTask ?? null,
    storyText: input.storyText ?? null,
    maxTokens: input.maxTokens ?? null,
    includeGraph: input.includeGraph ?? true,
  };

  const job = await createJob(input.workspaceId, input.specId, 'context-enrich', requestPayload);
  const bossJobId = await getBoss().send('context:enrich', {
    jobId: job.id,
    specId: input.specId,
    workspaceId: input.workspaceId,
    storyId: input.storyId ?? null,
    mode: input.mode,
    currentTask: input.currentTask,
    storyText: input.storyText,
    maxTokens: input.maxTokens,
    includeGraph: input.includeGraph ?? true,
  }, {
    priority: 1,
  });

  if (!bossJobId) {
    await updateJobStatus(job.id, 'failed', {
      errorMessage: 'boss.send() returned null for context-enrich',
      finishedAt: new Date(),
    });
    throw new UnprocessableError('Failed to enqueue context enrichment job');
  }

  await updateJobStatus(job.id, 'pending', {
    bossJobId,
    progressMessage: `Queued context enrichment (${input.mode})`,
  });

  return {
    jobId: job.id,
    status: 'pending' as const,
    pollUrl: `/api/spec-jobs/${job.id}`,
    streamUrl: `/api/spec-jobs/${job.id}/stream`,
  };
}

// ---------------------------------------------------------------------------
// Multer config for /upload
// ---------------------------------------------------------------------------

const ALLOWED_EXTENSIONS = ['.md', '.txt', '.sql', '.prisma', '.ts', '.tsx', '.json', '.yaml', '.yml', '.py', '.rb', '.go'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ALLOWED_EXTENSIONS.includes(ext));
  },
});

/**
 * @swagger
 * /api/context/extract:
 *   post:
 *     tags: [Context]
 *     summary: Extract context from paste/URL/Q&A for direction layers
 *     operationId: extractContext
 *     description: Extracts structured context from pasted text, a URL, or Q&A answers and converts it into direction layer YAML.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [mode, targetLayer]
 *             properties:
 *               mode: { type: string, enum: [paste, url, qa] }
 *               targetLayer: { type: integer, enum: [1, 2, 3] }
 *               content: { type: string, description: "Required for paste mode" }
 *               url: { type: string, description: "Required for url mode" }
 *               questions: { type: object, description: "Required for qa mode" }
 *     responses:
 *       200:
 *         description: Extracted context
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 yaml: { type: string }
 *                 confidence: { type: number }
 *                 extracted: { type: array, items: { type: string } }
 *                 missing: { type: array, items: { type: string } }
 *                 rawInput: { type: string }
 *                 tokenCount: { type: integer }
 *       400: { description: "Missing mode or invalid targetLayer" }
 */
const ContextExtractSchema = z.object({
  mode: z.enum(['paste', 'url', 'qa', 'filepath', 'multi']),
  targetLayer: z.number().int().refine(v => [1, 2, 3].includes(v), { message: 'targetLayer must be 1, 2, or 3' }),
  // paste mode
  text: z.string().optional(),
  content: z.string().optional(),
  // url mode
  url: z.string().optional(),
  // qa mode
  questions: z.record(z.string(), z.unknown()).optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
  // filepath mode
  filePath: z.string().optional(),
  // multi mode
  sources: z.array(z.any()).optional(),
  workspaceId: z.union([z.string(), z.number()]).optional(),
});

router.post('/extract', validateBody(ContextExtractSchema), async (req: Request, res: Response) => {
  try {
    const body = req.body as ExtractRequest;

    const result = await extractContext(body);
    res.json(result);
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/context/upload:
 *   post:
 *     tags: [Context]
 *     summary: Upload files for context extraction
 *     operationId: uploadContextFiles
 *     description: Accepts uploaded files and extracts structured context for use in direction layers.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [files, targetLayer]
 *             properties:
 *               files:
 *                 type: array
 *                 items: { type: string, format: binary }
 *               targetLayer: { type: integer, enum: [1, 2, 3] }
 *     responses:
 *       200:
 *         description: Extracted context from files
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 yaml: { type: string }
 *                 confidence: { type: number }
 *                 extracted: { type: array, items: { type: string } }
 *                 missing: { type: array, items: { type: string } }
 *                 tokenCount: { type: integer }
 *       400: { description: "No files or invalid targetLayer" }
 */
router.post('/upload', upload.array('files'), async (req: Request, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;

    if (!files || files.length === 0) {
      throw new ValidationError('No files uploaded');
      return;
    }

    const targetLayer = Number(req.body.targetLayer) as 1 | 2 | 3;
    if (![1, 2, 3].includes(targetLayer)) {
      throw new ValidationError('targetLayer must be 1, 2, or 3');
      return;
    }

    // Build multi-source from uploaded file buffers
    const sources = files.map((file) => ({
      type: 'paste' as const,
      content: file.buffer.toString('utf8'),
      label: file.originalname,
    }));

    const rawInput = await combineMultiSources(sources);
    const prompt = buildExtractionPrompt(rawInput, targetLayer);
    const llmResult = await chatComplete([{ role: 'user', content: prompt }]);
    const parsed = parseExtractionResponse(llmResult.text);

    res.json({
      yaml: parsed.yaml,
      confidence: parsed.confidence,
      extracted: parsed.extracted,
      missing: parsed.missing,
      rawInput,
      tokenCount: approxTokenCount(rawInput),
    } satisfies import('../lib/context-extractor').ExtractionResult);
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/context/fetch-preview:
 *   get:
 *     tags: [Context]
 *     summary: Fetch URL preview for context extraction
 *     operationId: fetchContextPreview
 *     description: Fetches a URL and returns a preview of its content for use in context extraction workflows.
 *     parameters:
 *       - in: query
 *         name: url
 *         required: true
 *         schema: { type: string }
 *         description: URL to fetch and preview
 *     responses:
 *       200:
 *         description: URL content preview
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 title: { type: string }
 *                 content: { type: string }
 *                 url: { type: string }
 *       400:
 *         description: Missing url query parameter
 */
router.get('/fetch-preview', async (req: Request, res: Response) => {
  try {
    const url = req.query.url as string | undefined;

    if (!url) {
      throw new ValidationError('url query parameter is required');
      return;
    }

    const result = await fetchUrlPreview(url);
    res.json(result);
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/context/enrich/async:
 *   post:
 *     tags: [Context]
 *     summary: Queue async shared context enrichment for MCP and Pi clients
 *     operationId: rorca_context_enrich_async
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Queues read-only shared context retrieval so MCP clients can poll for long-running enrichment without holding open requests."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: query
 *         name: mode
 *         required: false
 *         schema: { type: string, enum: [fetchAll, recent, semantic], default: semantic }
 *         description: Shared retrieval mode. `semantic` uses currentTask/storyText, `recent` returns the last 100 memories pinned-first, and `fetchAll` returns the widest cached dump that fits the token budget.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, specId]
 *             properties:
 *               workspaceId: { type: string }
 *               specId: { type: string }
 *               storyId: { type: string, nullable: true }
 *               currentTask: { type: string }
 *               storyText: { type: string }
 *               maxTokens: { type: integer }
 *               includeGraph: { type: boolean, default: true }
 *     responses:
 *       202:
 *         description: Async context enrichment queued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId: { type: string, format: uuid }
 *                 status: { type: string, enum: [pending] }
 *                 pollUrl: { type: string }
 *                 streamUrl: { type: string }
 */
router.post('/enrich/async', async (req: Request, res: Response) => {
  try {
    const query = ContextEnrichQuerySchema.parse(req.query);
    const body = ContextEnrichBodySchema.parse(req.body);

    if (query.mode === 'semantic' && !body.storyId && !body.storyText && !body.currentTask) {
      throw new ValidationError('semantic mode requires storyId, storyText, or currentTask');
    }

    const payload = await enqueueContextEnrichmentJob({
      ...body,
      ...query,
    });
    res.status(202).json(payload);
  } catch (error) {
    handleRouteError(res, error, '[context] enrich async');
  }
});

function parseCandidateRelatedFilePaths(value: unknown): string[] {
  const parsed = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return value; } })() : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (typeof item === 'string' && item.trim()) return [item];
    if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).path === 'string') return [(item as Record<string, string>).path];
    return [];
  });
}

/**
 * @swagger
 * /api/context/candidates/{id}/preview:
 *   get:
 *     tags: [Context]
 *     summary: Safely preview a file related to a context memory candidate
 *     operationId: previewContextCandidateFile
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Candidate file previews expose local workspace file contents and must remain operator-only while routing through context-safety redaction gates."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Safe redacted file preview }
 *       400: { description: Invalid preview request }
 *       404: { description: Candidate, workspace, or file not found }
 */
router.get('/candidates/:id/preview', async (req: Request, res: Response) => {
  try {
    const candidateId = Number(req.params.id);
    if (!Number.isInteger(candidateId) || candidateId <= 0) throw new ValidationError('candidate id must be a positive integer');
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
    const previewPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!workspaceId) throw new ValidationError('workspaceId query parameter is required');
    if (!previewPath) throw new ValidationError('path query parameter is required');

    const row = await queryOne<{ workspace_path: string; related_files: unknown }>(
      `SELECT w.path AS workspace_path, mc.related_files
         FROM memory_candidates mc
         JOIN workspaces w ON w.id = mc.workspace_id
        WHERE mc.id = $1 AND mc.workspace_id = $2`,
      [candidateId, workspaceId],
    );
    if (!row) throw new NotFoundError('Memory candidate', String(candidateId));
    const relatedFilePaths = parseCandidateRelatedFilePaths(row.related_files);
    if (!relatedFilePaths.includes(previewPath)) {
      throw new ValidationError('Preview path must be one of the candidate related files', { previewPath, relatedFilePaths });
    }

    let preview: Awaited<ReturnType<typeof readSafeContextFilePreview>>;
    try {
      preview = await readSafeContextFilePreview(row.workspace_path, previewPath);
    } catch (previewError) {
      const message = previewError instanceof Error ? previewError.message : String(previewError);
      const code = previewError && typeof previewError === 'object' ? (previewError as { code?: string }).code : undefined;
      if (code === 'ENOENT') throw new NotFoundError('Candidate file', previewPath);
      throw new ValidationError(message);
    }
    res.json({ ok: true, candidateId, workspaceId, preview });
  } catch (error) {
    handleRouteError(res, error, '[context] candidate preview');
  }
});

/**
 * @swagger
 * /api/context/health/{workspaceId}:
 *   get:
 *     tags: [Context]
 *     summary: Get workspace context readiness/health summary
 *     operationId: rorca_context_health
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only context readiness summary so local/MCP clients can show hydration state before generating specs; no side effects."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Context readiness summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workspaceId: { type: string }
 *                 schemaPresent: { type: boolean }
 *                 schemaTableCount: { type: integer }
 *                 schemaHydratedAt: { type: string, format: date-time, nullable: true }
 *                 gitHydrated: { type: boolean }
 *                 gitCommitCount: { type: integer }
 *                 gitMemoryHydratedAt: { type: string, format: date-time, nullable: true }
 *                 gitMemoryStale: { type: boolean }
 *                 claudeMdPresent: { type: boolean }
 *                 contextScore: { type: integer }
 *                 readiness: { type: string, enum: [ready, partial, absent] }
 *                 needsHydration: { type: boolean }
 *                 nudge: { type: string, nullable: true }
 *       404: { description: "Workspace not found" }
 */
router.get('/health/:workspaceId', async (req: Request, res: Response) => {
  try {
    const workspaceId = String(req.params.workspaceId);
    const workspace = await queryOne<{ path: string }>(
      'SELECT path FROM workspaces WHERE id = $1',
      [workspaceId],
    );
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }

    const summary = await buildContextHealthSummary({
      workspaceId,
      workspacePath: workspace.path,
    });
    res.json(summary);
  } catch (error) {
    handleRouteError(res, error, '[context] health');
  }
});

export default router;
