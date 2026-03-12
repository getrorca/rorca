import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed file size for extraction (10 MB) */
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB in bytes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AttachmentExtractionResult {
  text: string;
  mimeType: string;
  byteSize: number;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a file buffer based on its MIME type or filename.
 *
 * Supported:
 *  - application/pdf  → pdf-parse
 *  - application/vnd.openxmlformats-officedocument.wordprocessingml.document → mammoth
 *  - text/plain, text/markdown, text/* → UTF-8 decode
 *
 * Throws if the buffer exceeds MAX_FILE_SIZE or the file cannot be parsed.
 */
export async function extractTextFromBuffer(
  buffer: Buffer,
  mimeType: string,
  filename?: string,
): Promise<AttachmentExtractionResult> {
  if (buffer.byteLength > MAX_FILE_SIZE) {
    throw Object.assign(
      new Error(
        `File exceeds maximum allowed size of ${MAX_FILE_SIZE / 1024 / 1024} MB (got ${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB)`,
      ),
      { statusCode: 413 },
    );
  }

  // Normalise: derive type from filename extension when mimeType is generic
  const effectiveMime = resolveEffectiveMime(mimeType, filename);

  if (effectiveMime === 'application/pdf') {
    return extractPdf(buffer);
  }

  if (effectiveMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return extractDocx(buffer);
  }

  if (effectiveMime.startsWith('text/') || effectiveMime === 'application/json') {
    return extractPlainText(buffer, effectiveMime);
  }

  // Fallback: attempt UTF-8 decode (will be garbled for binary, but won't throw)
  return extractPlainText(buffer, effectiveMime);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveEffectiveMime(mimeType: string, filename?: string): string {
  if (mimeType && mimeType !== 'application/octet-stream') {
    return mimeType;
  }
  if (!filename) return mimeType;

  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'pdf':  return 'application/pdf';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'txt':  return 'text/plain';
    case 'md':   return 'text/markdown';
    default:     return mimeType;
  }
}

async function extractPdf(buffer: Buffer): Promise<AttachmentExtractionResult> {
  if (buffer.byteLength === 0) {
    return { text: '', mimeType: 'application/pdf', byteSize: 0 };
  }

  try {
    const parser = new PDFParse({ data: buffer });
    const data = await parser.getText();
    return {
      text: data.text ?? '',
      mimeType: 'application/pdf',
      byteSize: buffer.byteLength,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[attachment-extraction] PDF parse failed: ${message}`);
    throw Object.assign(new Error(`Failed to parse PDF: ${message}`), { statusCode: 422 });
  }
}

async function extractDocx(buffer: Buffer): Promise<AttachmentExtractionResult> {
  if (buffer.byteLength === 0) {
    return {
      text: '',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      byteSize: 0,
    };
  }

  try {
    const result = await mammoth.extractRawText({ buffer });
    return {
      text: result.value ?? '',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      byteSize: buffer.byteLength,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[attachment-extraction] DOCX parse failed: ${message}`);
    throw Object.assign(new Error(`Failed to parse DOCX: ${message}`), { statusCode: 422 });
  }
}

function extractPlainText(buffer: Buffer, mimeType: string): AttachmentExtractionResult {
  return {
    text: buffer.toString('utf8'),
    mimeType,
    byteSize: buffer.byteLength,
  };
}
