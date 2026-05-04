/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

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
