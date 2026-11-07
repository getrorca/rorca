/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * pdf-parse pulls in pdfjs-dist, which evaluates browser globals (DOMMatrix,
 * ImageData, Path2D) at module scope. Loading it statically crashed the compiled
 * CLI at startup, before the server could listen. Import it only when a PDF is
 * actually parsed.
 */
async function loadPdfParse(): Promise<typeof import('pdf-parse').PDFParse> {
  try {
    const mod = await import('pdf-parse');
    return mod.PDFParse;
  } catch (err) {
    throw new UnprocessableError(
      'PDF attachment parsing requires the optional "pdf-parse" package and a DOM polyfill on this platform.'
    );
  }
}
import mammoth from 'mammoth';
import { UnprocessableError } from './errors';

export const MAX_ATTACHMENT_TOKENS = 2000;
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
export const IMAGE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
]);

/**
 * Extract text content from an attachment's binary data based on MIME type.
 * Returns extracted text (truncated to MAX_ATTACHMENT_TOKENS tokens), or null for images.
 *
 * Throws if fileData exceeds MAX_FILE_SIZE_BYTES — callers (e.g. multer middleware) should
 * enforce this before calling, but this provides a defence-in-depth guard.
 */
export async function extractAttachmentText(
  contentType: string,
  fileData: Buffer,
  filename: string,
): Promise<string | null> {
  if (fileData.length > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File exceeds maximum size of ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB`);
  }

  try {
    if (IMAGE_CONTENT_TYPES.has(contentType)) {
      return null; // images handled separately as metadata
    }

    let text = '';
    if (contentType === 'application/pdf') {
      const PDFParse = await loadPdfParse();
      const parser = new PDFParse({ data: fileData });
      const result = await parser.getText();
      await parser.destroy();
      text = result.text;
    } else if (
      contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      const result = await mammoth.extractRawText({ buffer: fileData });
      text = result.value;
    } else if (
      contentType === 'text/plain' ||
      contentType === 'text/markdown' ||
      contentType.startsWith('text/')
    ) {
      text = fileData.toString('utf-8');
    } else {
      return `[Unsupported file type: ${contentType}]`;
    }

    // Token budget: ~4 chars per token
    const maxChars = MAX_ATTACHMENT_TOKENS * 4;
    if (text.length > maxChars) {
      return text.slice(0, maxChars) + '\n[truncated]';
    }
    return text;
  } catch (err) {
    return `[Error extracting text from ${filename}: ${(err as Error).message}]`;
  }
}
