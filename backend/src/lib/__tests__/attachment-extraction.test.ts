/**
 * Unit tests for attachment-extraction.ts
 *
 * Covers:
 *  - PDF extraction via pdf-parse (Buffer blob)
 *  - DOCX extraction via mammoth (Buffer blob)
 *  - Plain text / Markdown extraction (UTF-8)
 *  - Edge cases: empty file, corrupted PDF, oversized file
 *
 * Strategy: mock pdf-parse and mammoth so tests run in Jest (no ESM workers needed).
 * The extraction logic, error handling, and size guard under test are in attachment-extraction.ts.
 */

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const mockGetText = jest.fn<Promise<{ text: string }>, []>();
const MockPDFParse = jest.fn().mockImplementation(() => ({ getText: mockGetText }));

jest.mock('pdf-parse', () => ({ PDFParse: MockPDFParse }));

const mockExtractRawText = jest.fn<Promise<{ value: string; messages: unknown[] }>, [{ buffer: Buffer }]>();
jest.mock('mammoth', () => ({ extractRawText: mockExtractRawText }));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { extractTextFromBuffer, MAX_FILE_SIZE } from '../attachment-extraction';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal PDF-like buffer — content doesn't matter since pdf-parse is mocked */
function makePdfBuffer(byteLength = 512): Buffer {
  const buf = Buffer.alloc(byteLength, 0);
  buf.write('%PDF-1.4', 0, 'utf8');
  return buf;
}

/** Minimal DOCX-like buffer — content doesn't matter since mammoth is mocked */
function makeDocxBuffer(byteLength = 1024): Buffer {
  const buf = Buffer.alloc(byteLength, 0);
  // ZIP local file header magic bytes
  buf.writeUInt32LE(0x04034b50, 0);
  return buf;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractTextFromBuffer', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── PDF ──────────────────────────────────────────────────────────────────

  describe('PDF extraction', () => {
    it('extracts text from a valid PDF buffer', async () => {
      mockGetText.mockResolvedValue({ text: 'Hello PDF' });

      const buf = makePdfBuffer();
      const result = await extractTextFromBuffer(buf, 'application/pdf');

      expect(MockPDFParse).toHaveBeenCalledWith({ data: buf });
      expect(mockGetText).toHaveBeenCalledTimes(1);
      expect(result.text).toBe('Hello PDF');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.byteSize).toBe(buf.byteLength);
    });

    it('returns empty string for an empty PDF buffer (zero bytes)', async () => {
      const result = await extractTextFromBuffer(Buffer.alloc(0), 'application/pdf');

      // pdf-parse is NOT called for empty buffers
      expect(MockPDFParse).not.toHaveBeenCalled();
      expect(result.text).toBe('');
      expect(result.byteSize).toBe(0);
    });

    it('throws and logs a warning for a corrupted PDF buffer', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockGetText.mockRejectedValue(new Error('Invalid PDF structure'));

      await expect(
        extractTextFromBuffer(makePdfBuffer(), 'application/pdf'),
      ).rejects.toMatchObject({
        message: expect.stringContaining('Failed to parse PDF'),
        statusCode: 422,
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[attachment-extraction] PDF parse failed'),
      );

      warnSpy.mockRestore();
    });

    it('resolves mime type from .pdf filename when mime is application/octet-stream', async () => {
      mockGetText.mockResolvedValue({ text: 'Resolved PDF' });

      const buf = makePdfBuffer();
      const result = await extractTextFromBuffer(buf, 'application/octet-stream', 'report.pdf');

      expect(MockPDFParse).toHaveBeenCalledWith({ data: buf });
      expect(result.mimeType).toBe('application/pdf');
      expect(result.text).toBe('Resolved PDF');
    });
  });

  // ── DOCX ─────────────────────────────────────────────────────────────────

  describe('DOCX extraction', () => {
    const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    it('extracts raw text from a valid DOCX buffer', async () => {
      mockExtractRawText.mockResolvedValue({ value: 'Hello DOCX', messages: [] });

      const buf = makeDocxBuffer();
      const result = await extractTextFromBuffer(buf, DOCX_MIME);

      expect(mockExtractRawText).toHaveBeenCalledWith({ buffer: buf });
      expect(result.text).toBe('Hello DOCX');
      expect(result.mimeType).toBe(DOCX_MIME);
      expect(result.byteSize).toBe(buf.byteLength);
    });

    it('returns empty string for an empty DOCX buffer (zero bytes)', async () => {
      const result = await extractTextFromBuffer(Buffer.alloc(0), DOCX_MIME);

      // mammoth is NOT called for empty buffers
      expect(mockExtractRawText).not.toHaveBeenCalled();
      expect(result.text).toBe('');
      expect(result.byteSize).toBe(0);
    });

    it('throws and logs a warning for a corrupted DOCX buffer', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockExtractRawText.mockRejectedValue(new Error('Corrupted zip or bug'));

      await expect(
        extractTextFromBuffer(makeDocxBuffer(), DOCX_MIME),
      ).rejects.toMatchObject({
        message: expect.stringContaining('Failed to parse DOCX'),
        statusCode: 422,
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[attachment-extraction] DOCX parse failed'),
      );

      warnSpy.mockRestore();
    });

    it('resolves mime type from .docx filename when mime is application/octet-stream', async () => {
      mockExtractRawText.mockResolvedValue({ value: 'Resolved DOCX', messages: [] });

      const buf = makeDocxBuffer();
      const result = await extractTextFromBuffer(buf, 'application/octet-stream', 'notes.docx');

      expect(mockExtractRawText).toHaveBeenCalledWith({ buffer: buf });
      expect(result.mimeType).toBe(DOCX_MIME);
      expect(result.text).toBe('Resolved DOCX');
    });
  });

  // ── Plain text / Markdown ─────────────────────────────────────────────────

  describe('plain text extraction', () => {
    it('extracts UTF-8 text from a .txt buffer', async () => {
      const content = 'Hello, plain text!\nSecond line.';
      const buf = Buffer.from(content, 'utf8');
      const result = await extractTextFromBuffer(buf, 'text/plain', 'notes.txt');

      expect(result.text).toBe(content);
      expect(result.mimeType).toBe('text/plain');
      expect(result.byteSize).toBe(buf.byteLength);
    });

    it('extracts UTF-8 text from a .md buffer', async () => {
      const content = '# Title\n\nSome **markdown** content.';
      const buf = Buffer.from(content, 'utf8');
      const result = await extractTextFromBuffer(buf, 'text/markdown', 'README.md');

      expect(result.text).toBe(content);
      expect(result.mimeType).toBe('text/markdown');
    });

    it('preserves non-ASCII UTF-8 characters', async () => {
      const content = 'Héllo wörld — 日本語テスト 🎉';
      const buf = Buffer.from(content, 'utf8');
      const result = await extractTextFromBuffer(buf, 'text/plain');

      expect(result.text).toBe(content);
    });

    it('returns empty string for an empty text buffer', async () => {
      const result = await extractTextFromBuffer(Buffer.alloc(0), 'text/plain');
      expect(result.text).toBe('');
      expect(result.byteSize).toBe(0);
    });

    it('resolves .txt filename from application/octet-stream', async () => {
      const content = 'resolved text';
      const buf = Buffer.from(content, 'utf8');
      const result = await extractTextFromBuffer(buf, 'application/octet-stream', 'file.txt');

      expect(result.mimeType).toBe('text/plain');
      expect(result.text).toBe(content);
    });

    it('resolves .md filename from application/octet-stream', async () => {
      const content = '# readme';
      const buf = Buffer.from(content, 'utf8');
      const result = await extractTextFromBuffer(buf, 'application/octet-stream', 'README.md');

      expect(result.mimeType).toBe('text/markdown');
      expect(result.text).toBe(content);
    });
  });

  // ── Oversized file ────────────────────────────────────────────────────────

  describe('oversized file rejection', () => {
    it('throws with statusCode 413 before extraction when buffer exceeds 10 MB', async () => {
      const oversizedBuf = Buffer.alloc(MAX_FILE_SIZE + 1);

      await expect(
        extractTextFromBuffer(oversizedBuf, 'text/plain'),
      ).rejects.toMatchObject({
        message: expect.stringContaining('exceeds maximum allowed size'),
        statusCode: 413,
      });

      // pdf-parse and mammoth must NOT be called
      expect(MockPDFParse).not.toHaveBeenCalled();
      expect(mockExtractRawText).not.toHaveBeenCalled();
    });

    it('allows a buffer exactly at the 10 MB limit', async () => {
      const exactBuf = Buffer.alloc(MAX_FILE_SIZE, 65 /* 'A' */);
      const result = await extractTextFromBuffer(exactBuf, 'text/plain');

      expect(result.byteSize).toBe(MAX_FILE_SIZE);
      expect(result.text.length).toBe(MAX_FILE_SIZE);
    });

    it('throws for oversized PDF before attempting pdf-parse', async () => {
      const oversizedBuf = Buffer.alloc(MAX_FILE_SIZE + 1);

      await expect(
        extractTextFromBuffer(oversizedBuf, 'application/pdf'),
      ).rejects.toMatchObject({ statusCode: 413 });

      expect(MockPDFParse).not.toHaveBeenCalled();
    });

    it('throws for oversized DOCX before attempting mammoth', async () => {
      const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const oversizedBuf = Buffer.alloc(MAX_FILE_SIZE + 1);

      await expect(
        extractTextFromBuffer(oversizedBuf, DOCX_MIME),
      ).rejects.toMatchObject({ statusCode: 413 });

      expect(mockExtractRawText).not.toHaveBeenCalled();
    });
  });

  // ── Unknown MIME type fallback ─────────────────────────────────────────────

  describe('unknown mime type fallback', () => {
    it('falls back to UTF-8 decode for application/octet-stream with no filename', async () => {
      const content = 'some content';
      const buf = Buffer.from(content, 'utf8');
      const result = await extractTextFromBuffer(buf, 'application/octet-stream');

      expect(result.text).toBe(content);
    });

    it('falls back to UTF-8 decode for completely unknown mime types', async () => {
      const content = 'custom content';
      const buf = Buffer.from(content, 'utf8');
      const result = await extractTextFromBuffer(buf, 'application/x-custom-type');

      expect(result.text).toBe(content);
      expect(result.mimeType).toBe('application/x-custom-type');
    });
  });
});
