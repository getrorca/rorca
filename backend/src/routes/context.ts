import { Router, Request, Response } from 'express';
import multer from 'multer';
import * as path from 'path';
import {
  extractContext,
  combineMultiSources,
  buildExtractionPrompt,
  parseExtractionResponse,
  approxTokenCount,
  fetchUrlPreview,
  type ExtractRequest,
} from '../lib/context-extractor';
import { chatComplete } from '../lib/llm-client';

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

// ---------------------------------------------------------------------------
// POST /api/context/extract
// ---------------------------------------------------------------------------

router.post('/extract', async (req: Request, res: Response) => {
  try {
    const body = req.body as ExtractRequest;

    if (!body.mode) {
      res.status(400).json({ error: 'mode is required' });
      return;
    }

    if (![1, 2, 3].includes(body.targetLayer)) {
      res.status(400).json({ error: 'targetLayer must be 1, 2, or 3' });
      return;
    }

    const result = await extractContext(body);
    res.json(result);
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/context/upload
// ---------------------------------------------------------------------------

router.post('/upload', upload.array('files'), async (req: Request, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;

    if (!files || files.length === 0) {
      res.status(400).json({ error: 'No files uploaded' });
      return;
    }

    const targetLayer = Number(req.body.targetLayer) as 1 | 2 | 3;
    if (![1, 2, 3].includes(targetLayer)) {
      res.status(400).json({ error: 'targetLayer must be 1, 2, or 3' });
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
    const llmResponse = await chatComplete([{ role: 'user', content: prompt }]);
    const parsed = parseExtractionResponse(llmResponse);

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

// ---------------------------------------------------------------------------
// GET /api/context/fetch-preview?url=
// ---------------------------------------------------------------------------

router.get('/fetch-preview', async (req: Request, res: Response) => {
  try {
    const url = req.query.url as string | undefined;

    if (!url) {
      res.status(400).json({ error: 'url query parameter is required' });
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
