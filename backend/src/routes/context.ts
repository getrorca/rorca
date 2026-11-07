/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import * as crypto from 'crypto';
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
import { ValidationError, UnprocessableError, NotFoundError, PayloadTooLargeError } from '../lib/errors';
import { createJob } from '../db/spec-jobs';
import { getBoss } from '../lib/pg-boss';
import { recordSpecJobPublication } from '../lib/spec-job-publication';
import { getPgBossSchemaName } from '../lib/pg-boss-schema';
import { queryOne } from '../db/index';
import { buildContextHealthSummary } from '../lib/auto-memory';
import { retrieveContext, type RetrievedContext } from '../lib/memory-router';
import { estimateTokens } from '../lib/context-router';
import { retrieveSeeds } from '../lib/memory-seed-retrieval';
import { detectHydrationStaleness } from '../lib/hydration-staleness';
import { persistRetrievalTrace } from '../lib/retrieval-trace';
import { invalidateOnStaleness } from '../lib/context-cache';
import {
  clampRetrievalLimits,
  getContextLimits,
  buildContextCacheKey,
  computeWorkspaceContentHash,
} from '../lib/context-limits';
import { logger } from '../lib/logger';

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

  const bossJobId = crypto.randomUUID();
  const transportSchema = getPgBossSchemaName();
  const job = await createJob(input.workspaceId, input.specId, 'context-enrich', requestPayload, { bossJobId, transportSchema });
  const publishedId = await getBoss().send('context:enrich', {
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
    id: bossJobId,
    priority: 1,
  });

  if (publishedId !== bossJobId) {
    await recordSpecJobPublication({
      job,
      outcome: 'failed',
      message: 'boss.send() returned null for context-enrich',
    });
    throw new UnprocessableError('Failed to enqueue context enrichment job');
  }

  await recordSpecJobPublication({
    job,
    outcome: 'published',
    message: `Queued context enrichment (${input.mode})`,
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
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 10,
    fields: 4,
    fieldNestingDepth: 1,
  } as NonNullable<multer.Options['limits']> & { fieldNestingDepth: number },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ALLOWED_EXTENSIONS.includes(ext));
  },
});

function parseContextUpload(req: Request, res: Response, next: NextFunction): void {
  upload.array('files')(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(new PayloadTooLargeError('File size exceeds 5MB limit'));
        return;
      }
      next(new ValidationError(`Invalid multipart upload: ${err.code}`));
      return;
    }
    next(err);
  });
}

/**
 * @swagger
 * /api/context/extract:
 *   post:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
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
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
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
router.post('/upload', parseContextUpload, async (req: Request, res: Response) => {
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
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
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

// ─── Brief-Aware Context Retrieval ───────────────────────────────────────────

const RetrieveContextSchema = z.object({
  workspaceId: z.string().min(1).max(200),
  brief: z.string().min(1).max(100000),
  budget: z.number().int().positive().max(200000).optional(),
  maxCandidates: z.number().int().positive().optional(),
  maxFiles: z.number().int().positive().optional(),
  maxDepth: z.number().int().positive().optional(),
  maxExcerpts: z.number().int().positive().optional(),
  includeGraph: z.boolean().optional(),
  freshness: z.object({
    maxAgeMs: z.number().int().positive().optional(),
    allowStale: z.boolean().optional(),
  }).optional(),
});

/**
 * @swagger
 * /api/context/retrieve:
 *   post:
 *     tags: [Context]
 *     summary: Brief-aware context retrieval — seed retrieval, ranking, excerpting, trace persistence
 *     operationId: rorca_context_retrieve
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only context retrieval for local/MCP clients — runs seed retrieval, Hilo expansion, ranking, and excerpting with trace persistence; no write or operator-only side effects."
 *     x-rorca-public-api: true
 *     description: >
 *       Accepts a workspace ID, brief text, token budget, graph inclusion flag, and freshness policy.
 *       Runs seed retrieval (durable memories + approved candidates + prior specs),
 *       then the full retrieval pipeline (CAG → RAG → Graph → ranking → excerpting).
 *       Persists a redacted retrieval trace and returns bounded context sections,
 *       trace ID, hydration freshness, token estimates, and degradation flags.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, brief]
 *             properties:
 *               workspaceId: { type: string }
 *               brief: { type: string, description: "The story brief or task description to retrieve context for" }
 *               budget: { type: integer, description: "Token budget for context retrieval (default 32000)" }
 *               maxCandidates: { type: integer, description: "Requested candidate cap; clamped to RORCA_RETRIEVAL_MAX_CANDIDATES" }
 *               maxFiles: { type: integer, description: "Requested distinct file cap; clamped to RORCA_RETRIEVAL_MAX_FILES" }
 *               maxDepth: { type: integer, description: "Requested graph traversal depth; clamped to RORCA_RETRIEVAL_MAX_DEPTH" }
 *               maxExcerpts: { type: integer, description: "Requested excerpt/context item cap; clamped to RORCA_RETRIEVAL_MAX_EXCERPTS" }
 *               includeGraph: { type: boolean, description: "Include knowledge graph context (default true)" }
 *               freshness:
 *                 type: object
 *                 properties:
 *                   maxAgeMs: { type: integer, description: "Max age in ms for freshness; stale hydration beyond this degrades" }
 *                   allowStale: { type: boolean, description: "Whether to proceed with stale hydration data" }
 *     responses:
 *       200:
 *         description: Bounded context preview
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 traceId: { type: string }
 *                 sections:
 *                   type: object
 *                   properties:
 *                     direction: { type: object }
 *                     memory: { type: array, items: { type: object } }
 *                     skills: { type: array, items: { type: object } }
 *                     graphContext: { type: object }
 *                 hydrationFreshness:
 *                   type: object
 *                   properties:
 *                     status: { type: string, enum: [clean, stale, dirty, unknown, missing] }
 *                     humanSummary: { type: string }
 *                     currentHead: { type: string, nullable: true }
 *                     hydratedSha: { type: string, nullable: true }
 *                     checks: { type: object }
 *                 tokenEstimates:
 *                   type: object
 *                   properties:
 *                     direction: { type: integer }
 *                     memory: { type: integer }
 *                     skills: { type: integer }
 *                     graph: { type: integer }
 *                     seeds: { type: integer }
 *                     total: { type: integer }
 *                 degradationFlags:
 *                   type: object
 *                   properties:
 *                     graphDegraded: { type: boolean }
 *                     graphLite: { type: boolean }
 *                     cacheDegraded: { type: boolean }
 *                     searchDegraded: { type: boolean }
 *                     staleHydration: { type: boolean }
 *                     noSeeds: { type: boolean }
 *                 meta:
 *                   type: object
 *                   properties:
 *                     tier: { type: string }
 *                     latencyMs: { type: integer }
 *                     cagHits: { type: integer }
 *                     ragHits: { type: integer }
 *                     graphHits: { type: integer }
 *                     needsMoreEvidence: { type: boolean }
 *                     matchedSkills: { type: array, items: { type: string } }
 *       400:
 *         description: Validation error
 *       404:
 *         description: Workspace not found
 */
router.post('/retrieve', validateBody(RetrieveContextSchema), async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const body = req.body as z.infer<typeof RetrieveContextSchema>;
    const {
      workspaceId,
      brief,
      budget,
      maxCandidates: requestedMaxCandidates,
      maxFiles: requestedMaxFiles,
      maxDepth: requestedMaxDepth,
      maxExcerpts: requestedMaxExcerpts,
      includeGraph,
      freshness,
    } = body;

    // Look up workspace path
    const workspace = await queryOne<{ path: string }>(
      'SELECT path FROM workspaces WHERE id = $1',
      [workspaceId],
    );
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }

    // Clamp the requested token budget to the absolute retrieval ceiling
    // (US-039) so a single request on a large external repo cannot demand an
    // unbounded selection. Clamped fields are reported for honest UX.
    const limits = getContextLimits();
    const clampedLimits = clampRetrievalLimits({
      maxTokens: budget ?? 32000,
      maxCandidates: requestedMaxCandidates,
      maxFiles: requestedMaxFiles,
      maxDepth: requestedMaxDepth,
      maxExcerpts: requestedMaxExcerpts,
    }, limits);
    const maxTokens = clampedLimits.maxTokens;
    if (clampedLimits.clamped.length > 0) {
      logger.info(
        { workspaceId, requested: budget, maxTokens, clamped: clampedLimits.clamped },
        '[context/retrieve] retrieval limits clamped to ceiling',
      );
    }
    const includeGraphFlag = includeGraph ?? true;

    // ── Hydration Staleness Check ──────────────────────────────────────
    const hydrationFreshness = await detectHydrationStaleness(workspaceId, workspace.path);
    const staleHydration =
      hydrationFreshness.status === 'stale' ||
      hydrationFreshness.status === 'dirty' ||
      hydrationFreshness.status === 'missing';

    // Evict any workspace context cached against a different git SHA or dirty
    // working tree so stale hydration can never serve a divergent commit/file
    // state (US-039 cache invalidation keyed by git SHA + file hash).
    invalidateOnStaleness(
      workspaceId,
      hydrationFreshness.currentHead,
      hydrationFreshness.hydratedSha,
      hydrationFreshness.checks.dirtyTree,
    );

    // If freshness policy forbids stale data, reject early
    if (freshness && freshness.allowStale === false && staleHydration) {
      throw new ValidationError(
        `Hydration is ${hydrationFreshness.status} and allowStale is false. ${hydrationFreshness.humanSummary}`,
      );
    }

    // If freshness maxAgeMs is set, check age is acceptable
    if (freshness?.maxAgeMs != null && hydrationFreshness.hydratedSha) {
      // maxAgeMs constraint is advisory — we pass it through but don't block
      const ageMs = Date.now() - startedAt;
      if (ageMs > freshness.maxAgeMs) {
        logger.info(
          { workspaceId, maxAgeMs: freshness.maxAgeMs, ageMs },
          '[context/retrieve] freshness maxAgeMs exceeded but proceeding',
        );
      }
    }

    // ── Seed Retrieval ────────────────────────────────────────────────
    const seedResult = await retrieveSeeds(workspaceId, {
      brief,
      workspacePath: workspace.path,
      maxMemorySeeds: Math.min(8, clampedLimits.maxCandidates),
      maxSpecSeeds: Math.min(6, clampedLimits.maxCandidates),
      tokenBudget: Math.min(4000, Math.floor(maxTokens * 0.1)),
    });

    const seedTokenEstimate =
      seedResult.memorySeeds.reduce((s, seed) => s + seed.tokenEstimate, 0) +
      seedResult.specSeeds.reduce((s, seed) => s + seed.tokenEstimate, 0);

    // ── Full Context Retrieval (CAG → RAG → Graph → Ranking) ──────────
    const retrieved: RetrievedContext = await retrieveContext(
      workspaceId,
      brief,
      {
        maxTokens,
        maxCandidates: clampedLimits.maxCandidates,
        maxFiles: clampedLimits.maxFiles,
        maxDepth: clampedLimits.maxDepth,
        maxExcerpts: clampedLimits.maxExcerpts,
        includeGraph: includeGraphFlag,
        workspacePath: workspace.path,
      },
    );

    // ── Trace ID Generation ───────────────────────────────────────────
    const briefHash = crypto.createHash('sha256').update(brief).digest('hex').slice(0, 16);
    const traceId = `ctx-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

    // ── Composite Cache Key (US-039) ──────────────────────────────────
    // Unique per workspace + git SHA + brief + retrieval policy. Persisted as
    // the trace `policy` so divergent commits/policies are never conflated.
    const retrievalPolicy = {
      maxTokens,
      includeGraph: includeGraphFlag,
      maxCandidates: clampedLimits.maxCandidates,
      maxFiles: clampedLimits.maxFiles,
      maxDepth: clampedLimits.maxDepth,
      maxExcerpts: clampedLimits.maxExcerpts,
      allowStale: freshness?.allowStale ?? true,
    };
    const contentFingerprint = (hydrationFreshness.checks.dirtyTree || !hydrationFreshness.currentHead)
      ? computeWorkspaceContentHash(workspace.path, {
          maxFiles: clampedLimits.maxFiles,
          maxDepth: clampedLimits.maxDepth,
        })
      : null;
    const cacheKey = buildContextCacheKey({
      namespace: 'retrieve',
      workspaceId,
      gitSha: hydrationFreshness.currentHead,
      contentHash: contentFingerprint?.hash ?? null,
      briefHash,
      policy: retrievalPolicy,
    });

    // ── Degradation Flags ─────────────────────────────────────────────
    const degradationFlags = {
      graphDegraded: includeGraphFlag && retrieved.meta.graphHits === 0,
      graphLite: includeGraphFlag && retrieved.meta.graphHits === 0 && !staleHydration,
      cacheDegraded: retrieved.meta.cagHits === 0,
      searchDegraded: retrieved.meta.cagHits === 0 && retrieved.meta.ragHits === 0,
      staleHydration,
      noSeeds: seedResult.memorySeeds.length === 0 && seedResult.specSeeds.length === 0,
    };

    // ── Token Estimates ───────────────────────────────────────────────
    const tokenEstimates = {
      direction:
        (retrieved.direction.standards ? estimateTokens(retrieved.direction.standards) : 0) +
        (retrieved.direction.conventions ? estimateTokens(retrieved.direction.conventions) : 0) +
        (retrieved.direction.project ? estimateTokens(retrieved.direction.project) : 0),
      memory: retrieved.memory.reduce((s, m) => s + estimateTokens(m.text), 0),
      skills: retrieved.skills.reduce((s, sk) => s + estimateTokens(sk.content), 0),
      graph: retrieved.graphSection ? estimateTokens(retrieved.graphSection) : 0,
      seeds: seedTokenEstimate,
      total: retrieved.meta.totalTokens + seedTokenEstimate,
    };

    // ── Persist Trace (best-effort, non-blocking) ────────────────────
    persistRetrievalTrace({
      traceId,
      workspaceId,
      briefHash,
      gitSha: hydrationFreshness.currentHead ?? undefined,
      policy: cacheKey,
      graphMode: includeGraphFlag ? (degradationFlags.graphLite ? 'lite' : 'full') : 'disabled',
      degraded: degradationFlags.staleHydration || degradationFlags.noSeeds || degradationFlags.graphDegraded,
      candidates: [],
      tokenEstimate: tokenEstimates.total,
    }).catch((err) => {
      logger.warn({ err, traceId }, '[context/retrieve] trace persistence failed (non-blocking)');
    });

    // ── Response ─────────────────────────────────────────────────────
    res.json({
      traceId,
      sections: {
        direction: retrieved.direction,
        memory: retrieved.memory,
        skills: retrieved.skills,
        graphContext: retrieved.graphContext ?? null,
        seeds: {
          memorySeeds: seedResult.memorySeeds,
          specSeeds: seedResult.specSeeds,
          meta: seedResult.meta,
        },
      },
      hydrationFreshness: {
        status: hydrationFreshness.status,
        humanSummary: hydrationFreshness.humanSummary,
        currentHead: hydrationFreshness.currentHead,
        hydratedSha: hydrationFreshness.hydratedSha,
        checks: hydrationFreshness.checks,
      },
      tokenEstimates,
      degradationFlags,
      meta: {
        tier: retrieved.meta.tier,
        latencyMs: Date.now() - startedAt,
        cagHits: retrieved.meta.cagHits,
        ragHits: retrieved.meta.ragHits,
        graphHits: retrieved.meta.graphHits,
        needsMoreEvidence: retrieved.meta.needsMoreEvidence ?? false,
        matchedSkills: retrieved.meta.matchedSkills ?? [],
        cacheKey,
        cacheContentHash: contentFingerprint
          ? {
              hash: contentFingerprint.hash.slice(0, 16),
              fileCount: contentFingerprint.fileCount,
              truncated: contentFingerprint.truncated,
            }
          : null,
        limits: {
          maxTokens: clampedLimits.maxTokens,
          maxCandidates: clampedLimits.maxCandidates,
          maxFiles: clampedLimits.maxFiles,
          maxDepth: clampedLimits.maxDepth,
          maxExcerpts: clampedLimits.maxExcerpts,
        },
        limitsClamped: clampedLimits.clamped,
      },
    });
  } catch (err) {
    handleRouteError(res, err, '[context] retrieve');
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
