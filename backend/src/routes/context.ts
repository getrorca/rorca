/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
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
import { ValidationError } from '../lib/errors';

const router = Router();

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

export default router;
