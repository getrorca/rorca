/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Unit tests for attachment-extraction.ts
 * Covers: PDF, DOCX, plain text extraction + edge cases (empty, corrupted, oversized).
 */

jest.mock('pdf-parse', () => {
  const mockDestroy = jest.fn().mockResolvedValue(undefined);
  const MockPDFParse = jest.fn().mockImplementation(({ data }: { data: Buffer }) => {
    return {
      getText: jest.fn(async () => {
        if (data.length === 0) return { text: '' };
        // Simulate corrupt detection: if buffer starts with 0xFF 0x00 (not a real PDF header)
        if (data[0] === 0xff && data[1] === 0x00) {
          throw new Error('Invalid PDF structure');
        }
        return { text: data.toString('utf-8').replace(/%PDF-1\.4\s*/, '') };
      }),
      destroy: mockDestroy,
    };
  });
  return { PDFParse: MockPDFParse };
});

jest.mock('mammoth', () => {
  const extractRawText = jest.fn(async ({ buffer }: { buffer: Buffer }) => {
    if (buffer.length === 0) return { value: '' };
    // Simulate corrupt DOCX: PK header required for zip-based DOCX
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      throw new Error('End of Central Directory signature not found');
    }
    return { value: 'Hello from DOCX document.' };
  });
  // mammoth is a CommonJS module; the default export has extractRawText directly
  return { __esModule: true, default: { extractRawText }, extractRawText };
});

import {
  extractAttachmentText,
  MAX_ATTACHMENT_TOKENS,
  MAX_FILE_SIZE_BYTES,
} from '../attachment-extraction';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal fake PDF buffer with a valid-looking header prefix */
function fakePdfBuffer(content: string): Buffer {
  return Buffer.from(`%PDF-1.4\n${content}`);
}

/** Minimal fake DOCX buffer — starts with PK (zip magic bytes) */
function fakeDocxBuffer(content: string): Buffer {
  const pk = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  return Buffer.concat([pk, Buffer.from(content, 'utf-8')]);
}

/** Buffer that simulates a corrupt PDF (starts with 0xFF 0x00) */
function corruptPdfBuffer(): Buffer {
  return Buffer.from([0xff, 0x00, 0x00, 0x01, 0x02, 0x03]);
}

// ─── Plain text extraction ────────────────────────────────────────────────────

describe('Plain text extraction', () => {
  test('extracts UTF-8 text from text/plain', async () => {
    const content = 'Hello, world! 🎉';
    const result = await extractAttachmentText('text/plain', Buffer.from(content, 'utf-8'), 'readme.txt');
    expect(result).toBe(content);
  });

  test('extracts content from text/markdown', async () => {
    const content = '# Heading\n\nSome **bold** text.';
    const result = await extractAttachmentText('text/markdown', Buffer.from(content, 'utf-8'), 'notes.md');
    expect(result).toBe(content);
  });

  test('extracts content from generic text/* type', async () => {
    const content = 'key=value';
    const result = await extractAttachmentText('text/x-config', Buffer.from(content, 'utf-8'), 'config.txt');
    expect(result).toBe(content);
  });

  test('returns empty string for empty text file', async () => {
    const result = await extractAttachmentText('text/plain', Buffer.alloc(0), 'empty.txt');
    expect(result).toBe('');
  });

  test('truncates text exceeding token budget', async () => {
    const maxChars = MAX_ATTACHMENT_TOKENS * 4;
    const longContent = 'a'.repeat(maxChars + 500);
    const result = await extractAttachmentText('text/plain', Buffer.from(longContent, 'utf-8'), 'big.txt');
    expect(result).not.toBeNull();
    expect(result!.endsWith('\n[truncated]')).toBe(true);
    expect(result!.length).toBeLessThan(longContent.length);
  });
});

// ─── PDF extraction ───────────────────────────────────────────────────────────

describe('PDF extraction', () => {
  test('extracts text from a valid PDF buffer', async () => {
    const result = await extractAttachmentText(
      'application/pdf',
      fakePdfBuffer('This is the document body.'),
      'report.pdf',
    );
    expect(result).toContain('This is the document body.');
  });

  test('returns empty string for empty PDF', async () => {
    // Empty buffer → mocked getText returns { text: '' }
    const result = await extractAttachmentText('application/pdf', Buffer.alloc(0), 'empty.pdf');
    expect(result).toBe('');
  });

  test('returns error string for corrupted PDF instead of throwing', async () => {
    const result = await extractAttachmentText('application/pdf', corruptPdfBuffer(), 'corrupt.pdf');
    expect(typeof result).toBe('string');
    expect(result).toMatch(/\[Error extracting text from corrupt\.pdf/);
  });

  test('truncates oversized PDF text to token budget', async () => {
    const maxChars = MAX_ATTACHMENT_TOKENS * 4;
    // The mock strips the %PDF-1.4\n prefix and returns the rest as text
    const longBody = 'x'.repeat(maxChars + 1000);
    const result = await extractAttachmentText(
      'application/pdf',
      fakePdfBuffer(longBody),
      'large.pdf',
    );
    expect(result).not.toBeNull();
    expect(result!.endsWith('\n[truncated]')).toBe(true);
  });
});

// ─── DOCX extraction ──────────────────────────────────────────────────────────

describe('DOCX extraction', () => {
  test('extracts raw text from a valid DOCX buffer', async () => {
    const result = await extractAttachmentText(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fakeDocxBuffer('payload'),
      'document.docx',
    );
    expect(result).toBe('Hello from DOCX document.');
  });

  test('returns empty string for empty DOCX buffer', async () => {
    // Empty buffer → mock returns { value: '' }
    const result = await extractAttachmentText(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      Buffer.alloc(0),
      'empty.docx',
    );
    expect(result).toBe('');
  });

  test('returns error string for corrupted DOCX instead of throwing', async () => {
    // Buffer missing PK magic bytes → mock throws
    const corruptDocx = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const result = await extractAttachmentText(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      corruptDocx,
      'bad.docx',
    );
    expect(typeof result).toBe('string');
    expect(result).toMatch(/\[Error extracting text from bad\.docx/);
  });
});

// ─── Image passthrough ────────────────────────────────────────────────────────

describe('Image content types', () => {
  test.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'])(
    'returns null for %s',
    async (contentType) => {
      const result = await extractAttachmentText(contentType, Buffer.from('binary'), 'photo.png');
      expect(result).toBeNull();
    },
  );
});

// ─── Unsupported type ─────────────────────────────────────────────────────────

describe('Unsupported content types', () => {
  test('returns unsupported message for binary/octet-stream', async () => {
    const result = await extractAttachmentText(
      'application/octet-stream',
      Buffer.from([0x00, 0x01]),
      'data.bin',
    );
    expect(result).toContain('[Unsupported file type: application/octet-stream]');
  });
});

// ─── Oversized file guard ─────────────────────────────────────────────────────

describe('Oversized file rejection', () => {
  test('throws before extraction when file exceeds 10MB', async () => {
    // 10MB + 1 byte
    const oversized = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1);
    await expect(
      extractAttachmentText('text/plain', oversized, 'huge.txt'),
    ).rejects.toThrow(/exceeds maximum size/);
  });

  test('does not throw for file exactly at 10MB limit', async () => {
    const atLimit = Buffer.alloc(MAX_FILE_SIZE_BYTES, 'a');
    // Should not throw — text extraction returns the (truncated) content
    const result = await extractAttachmentText('text/plain', atLimit, 'boundary.txt');
    expect(typeof result).toBe('string');
  });
});
