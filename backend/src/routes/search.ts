/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-008: GET /api/search — Unified hybrid search endpoint
 *
 * Combines keyword (tsvector) + semantic (pgvector) search with RRF merging.
 * Supports filtering by source type, workspace, and search mode.
 */

import { Router, Request, Response } from 'express';
import { hybridSearch, type SearchOptions, type SourceType } from '../lib/search';
import { logger } from '../lib/logger';
import { ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';

const router = Router();

/**
 * @swagger
 * /api/search:
 *   get:
 *     tags: [Search]
 *     summary: Cross-source semantic + keyword search — use when searching across specs, stories, AND memories together
 *     operationId: hybridSearch
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Unified search is a read-only discovery surface that the open-source CLI and MCP tools need for cross-artifact lookup."
 *     x-rorca-public-api: true
 *     description: >
 *       USE THIS for broad search across all content types ("find anything about Stripe integration",
 *       "search for authentication across specs and memories"). Combines keyword (tsvector) and semantic
 *       (pgvector cosine similarity) via Reciprocal Rank Fusion. Filter by source type (spec, story, memory, archive).
 *       Falls back to keyword-only if no embeddings exist. For memory-only semantic search, prefer getRecall with query.
 *       For paginated memory browsing, use listMemoryItems.
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *         description: Search query text
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [spec, story, memory, archive] }
 *         description: Filter by source type (comma-separated for multiple)
 *       - in: query
 *         name: workspace
 *         schema: { type: string }
 *         description: Filter by workspace ID
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *         description: Max results to return
 *       - in: query
 *         name: mode
 *         schema: { type: string, enum: [keyword, semantic, hybrid], default: hybrid }
 *         description: Search mode
 *     responses:
 *       200:
 *         description: Search results with metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       sourceType: { type: string }
 *                       sourceId: { type: string }
 *                       title: { type: string }
 *                       snippet: { type: string }
 *                       score: { type: number }
 *                       matchType: { type: string, enum: [keyword, semantic, hybrid] }
 *                       highlights: { type: array, items: { type: string } }
 *                 meta:
 *                   type: object
 *                   properties:
 *                     keywordHits: { type: integer }
 *                     semanticHits: { type: integer }
 *                     hybridHits: { type: integer }
 *                     latencyMs: { type: integer }
 *       400:
 *         description: Missing required query param
 */
router.get('/', async (req: Request, res: Response) => {
  const start = Date.now();

  try {
    const q = req.query.q as string;
    if (!q || !q.trim()) {
      throw new ValidationError('Missing required query param: q (search query)');
      return;
    }

    const typeParam = req.query.type as string | undefined;
    const workspaceId = req.query.workspace as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const mode = (req.query.mode as string) || 'hybrid';

    // Parse source types
    const validTypes: SourceType[] = ['spec', 'story', 'memory', 'archive'];
    let sourceTypes: SourceType[] | undefined;
    if (typeParam) {
      sourceTypes = typeParam
        .split(',')
        .map(t => t.trim() as SourceType)
        .filter(t => validTypes.includes(t));
      if (sourceTypes.length === 0) sourceTypes = undefined;
    }

    const options: SearchOptions = {
      sourceTypes,
      workspaceId,
      limit,
    };

    // Adjust weights based on mode
    if (mode === 'keyword') {
      options.keywordWeight = 1.0;
      options.semanticWeight = 0.0;
    } else if (mode === 'semantic') {
      options.keywordWeight = 0.0;
      options.semanticWeight = 1.0;
    }
    // 'hybrid' uses default equal weights

    const results = await hybridSearch(q.trim(), options);
    const latencyMs = Date.now() - start;

    // Compute meta counts
    let keywordHits = 0;
    let semanticHits = 0;
    let hybridHits = 0;
    for (const r of results) {
      if (r.matchType === 'keyword') keywordHits++;
      else if (r.matchType === 'semantic') semanticHits++;
      else hybridHits++;
    }

    res.json({
      results,
      meta: {
        keywordHits,
        semanticHits,
        hybridHits,
        latencyMs,
      },
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Search] Hybrid search');
  }
});

export default router;
