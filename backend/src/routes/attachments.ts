/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

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
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
    fields: 4,
    fieldNestingDepth: 1,
  } as NonNullable<multer.Options['limits']> & { fieldNestingDepth: number }, // 10MB; Multer 2.2 supports this before its DefinitelyTyped declaration
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_CONTENT_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`INVALID_FILE_TYPE:${file.mimetype}`));
    }
  },
});

/**
 * @swagger
 * /api/attachments/pending:
 *   post:
 *     tags: [Specs]
 *     summary: Upload a pre-generation attachment
 *     operationId: uploadPendingAttachment
 *     description: >
 *       Upload a file before a spec exists (pre-generation attachment).
 *       Stored in spec_attachments under specSlug from the request body,
 *       or '__forge__' if no slug is provided. When spec generation runs,
 *       buildAttachmentSection(slug) picks these up automatically if specSlug
 *       matches the generated spec's slug. Supported types: PNG, JPEG, WebP,
 *       PDF, Markdown, plain text, DOCX. Max 10 MB.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: The file to upload (max 10 MB)
 *               specSlug:
 *                 type: string
 *                 description: Spec slug to associate this attachment with (defaults to '__forge__')
 *                 example: my-spec-slug
 *     responses:
 *       201:
 *         description: Attachment uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   description: UUID of the created attachment
 *                 filename:
 *                   type: string
 *                   example: design-mockup.png
 *                 contentType:
 *                   type: string
 *                   example: image/png
 *                 fileSize:
 *                   type: integer
 *                   description: File size in bytes
 *                   example: 204800
 *                 createdAt:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: No file uploaded or unsupported file type
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Unsupported file type: application/zip"
 *                 supportedTypes:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["image/png", "image/jpeg", "application/pdf"]
 *       413:
 *         description: File size exceeds 10 MB limit
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
router.post(
  '/pending',
  (req: Request, res: Response, next: any) => {
    pendingUpload.single('file')(req, res, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          next(new PayloadTooLargeError('File size exceeds 10MB limit'));
          return;
        }
        if (err.message?.startsWith('INVALID_FILE_TYPE:')) {
          const mimeType = err.message.replace('INVALID_FILE_TYPE:', '');
          next(new ValidationError(`Unsupported file type: ${mimeType}`));
          return;
        }
        if (err instanceof multer.MulterError) {
          next(new ValidationError(`Invalid multipart upload: ${err.code}`));
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
