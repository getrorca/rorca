import { Router, Request, Response } from 'express';
import multer from 'multer';
import { queryOne } from '../db/index';
import { PayloadTooLargeError, ValidationError } from '../lib/errors';

const router = Router();

const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
  'text/markdown',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const pendingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_CONTENT_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`INVALID_FILE_TYPE:${file.mimetype}`));
    }
  },
});

/**
 * POST /api/attachments/pending
 * Upload a file before a spec exists (pre-generation attachment).
 * Stores in spec_attachments under specSlug (from body) or '__forge__' fallback.
 * When spec generation runs, buildAttachmentSection(slug) picks these up automatically
 * if specSlug matches the generated spec's slug.
 */
router.post(
  '/pending',
  (req: Request, res: Response, next: any) => {
    pendingUpload.single('file')(req, res, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          throw new PayloadTooLargeError('File size exceeds 10MB limit');
          return;
        }
        if (err.message?.startsWith('INVALID_FILE_TYPE:')) {
          const mimeType = err.message.replace('INVALID_FILE_TYPE:', '');
          throw new ValidationError(`Unsupported file type: ${mimeType}`);
          return;
        }
        next(err);
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    if (!req.file) {
      throw new ValidationError('No file uploaded');
      return;
    }

    const specSlug = (req.body?.specSlug as string | undefined)?.trim() || '__forge__';
    const { originalname, mimetype, size, buffer } = req.file;

    const row = await queryOne<{
      id: string;
      filename: string;
      content_type: string;
      file_size: number;
      created_at: string;
    }>(
      `INSERT INTO spec_attachments (spec_id, filename, content_type, file_size, storage_type, file_data)
       VALUES ($1, $2, $3, $4, 'database', $5)
       RETURNING id, filename, content_type, file_size, created_at`,
      [specSlug, originalname, mimetype, size, buffer],
    );

    res.status(201).json({
      id: row!.id,
      filename: row!.filename,
      contentType: row!.content_type,
      fileSize: row!.file_size,
      createdAt: row!.created_at,
    });
  },
);

export default router;
