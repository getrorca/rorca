/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import type { Express } from 'express';
import { getAuthToken } from './helpers/auth-helper';

// ---------------------------------------------------------------------------
// Mock llm-client BEFORE requiring app (chatComplete uses claude CLI)
// ---------------------------------------------------------------------------

const mockChatComplete = jest.fn<Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }>, [any]>();

jest.mock('../../lib/llm-client', () => ({
  chatComplete: (...args: any[]) => mockChatComplete(args[0]),
  getActiveProvider: () => 'mock',
  getActiveModel: () => 'mock-model',
}));

// ---------------------------------------------------------------------------
// Mock global fetch for URL-based tests
// ---------------------------------------------------------------------------

const mockFetch = jest.fn<Promise<Response>, [any, any]>();
(global as any).fetch = mockFetch;

let app: Express;
let tmpDir: string;
let authToken: string;

beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();

  // Re-apply mocks after resetModules
  jest.mock('../../lib/llm-client', () => ({
    chatComplete: (...args: any[]) => mockChatComplete(args[0]),
    getActiveProvider: () => 'mock',
    getActiveModel: () => 'mock-model',
    isValidModel: () => false,
    DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
    resolveVaultProvider: jest.fn().mockReturnValue(null),
    getModelInfo: jest.fn().mockReturnValue(undefined),
    SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
  }));
  (global as any).fetch = mockFetch;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-context-test-'));
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
authToken = await getAuthToken(app);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

// ---------------------------------------------------------------------------
// Helper: default LLM response
// ---------------------------------------------------------------------------

function mockLlmYaml(yaml: string, meta?: { confidence?: string; extracted?: string[]; missing?: string[] }) {
  const metaObj = {
    confidence: meta?.confidence || 'high',
    extracted: meta?.extracted || ['field1'],
    missing: meta?.missing || [],
  };
  mockChatComplete.mockResolvedValueOnce({
    text: `${yaml}\n#meta ${JSON.stringify(metaObj)}`,
    usage: { inputTokens: 0, outputTokens: 0 },
  });
}

// ===========================================================================
// POST /api/context/extract — paste mode
// ===========================================================================

describe('POST /api/context/extract — paste mode', () => {
  test('sends text to LLM and returns YAML in response', async () => {
    mockLlmYaml('project:\n  name: TestApp', { confidence: 'high', extracted: ['project.name'] });

    const res = await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'paste', text: 'TestApp is a task manager built with React', targetLayer: 3 });

    expect(res.status).toBe(200);
    expect(res.body.yaml).toContain('project:');
    expect(res.body.yaml).toContain('name: TestApp');
    expect(res.body.confidence).toBe('high');
    expect(res.body.extracted).toEqual(['project.name']);
    expect(res.body.rawInput).toBe('TestApp is a task manager built with React');
    expect(res.body.tokenCount).toBeGreaterThan(0);
  });

  test('truncates paste text at 12000 chars', async () => {
    mockLlmYaml('global:\n  style: concise');
    const longText = 'x'.repeat(15000);

    await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'paste', text: longText, targetLayer: 1 });

    expect(mockChatComplete).toHaveBeenCalledTimes(1);
    const callArg = mockChatComplete.mock.calls[0][0][0].content as string;
    // The raw input in the prompt should be truncated
    expect(callArg.length).toBeLessThan(15000 + 500); // prompt overhead
  });
});

// ===========================================================================
// POST /api/context/extract — qa mode
// ===========================================================================

describe('POST /api/context/extract — qa mode', () => {
  test('assembles answers into labelled list before LLM call', async () => {
    mockLlmYaml('project:\n  name: InvoiceSaaS');

    const answers = {
      'Project name': 'Freelance Invoicing SaaS',
      'What does it do': 'Creates invoices and tracks payments',
      'Tech stack': 'React, Node.js, PostgreSQL',
    };

    const res = await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'qa', answers, targetLayer: 3 });

    expect(res.status).toBe(200);

    // Verify the assembled text was sent to LLM
    const callArg = mockChatComplete.mock.calls[0][0][0].content as string;
    expect(callArg).toContain('Project name: Freelance Invoicing SaaS');
    expect(callArg).toContain('What does it do: Creates invoices and tracks payments');
    expect(callArg).toContain('Tech stack: React, Node.js, PostgreSQL');
  });
});

// ===========================================================================
// POST /api/context/extract — filepath mode
// ===========================================================================

describe('POST /api/context/extract — filepath mode', () => {
  test('reads file content and sends to LLM', async () => {
    const filePath = path.join(tmpDir, 'readme.md');
    fs.writeFileSync(filePath, '# My Project\nA cool tool for building things.');
    mockLlmYaml('project:\n  name: My Project');

    const res = await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'filepath', filePath, targetLayer: 3 });

    expect(res.status).toBe(200);
    expect(res.body.rawInput).toContain('# My Project');
  });

  test('returns 400 if file does not exist', async () => {
    const res = await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'filepath', filePath: '/nonexistent/file.md', targetLayer: 3 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('File not found');
  });

  test('returns 400 if path is a directory', async () => {
    const res = await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'filepath', filePath: tmpDir, targetLayer: 3 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('directory');
  });

  test('.sql files extract only CREATE TABLE blocks', async () => {
    const sqlContent = `
-- Migration 001
ALTER TABLE foo ADD COLUMN bar TEXT;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT
);

INSERT INTO users VALUES ('1', 'Alice', 'a@b.com');

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  title TEXT
);
    `.trim();

    const filePath = path.join(tmpDir, 'schema.sql');
    fs.writeFileSync(filePath, sqlContent);
    mockLlmYaml('project:\n  stack: PostgreSQL');

    const res = await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'filepath', filePath, targetLayer: 3 });

    expect(res.status).toBe(200);
    expect(res.body.rawInput).toContain('CREATE TABLE users');
    expect(res.body.rawInput).toContain('CREATE TABLE posts');
    expect(res.body.rawInput).not.toContain('ALTER TABLE');
    expect(res.body.rawInput).not.toContain('INSERT INTO');
  });

  test('.ts files extract only interface/type declarations', async () => {
    const tsContent = `
import { something } from 'somewhere';

export interface User {
  id: string;
  name: string;
  email: string;
}

function doSomething() {
  console.log('hello');
}

export type Status = 'active' | 'inactive';

const x = 42;
    `.trim();

    const filePath = path.join(tmpDir, 'types.ts');
    fs.writeFileSync(filePath, tsContent);
    mockLlmYaml('project:\n  types: extracted');

    const res = await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'filepath', filePath, targetLayer: 3 });

    expect(res.status).toBe(200);
    expect(res.body.rawInput).toContain('export interface User');
    expect(res.body.rawInput).toContain('id: string');
    expect(res.body.rawInput).toContain("export type Status = 'active' | 'inactive'");
    expect(res.body.rawInput).not.toContain('function doSomething');
    expect(res.body.rawInput).not.toContain('const x = 42');
  });

  test('.json files are pretty-printed', async () => {
    const filePath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(filePath, '{"name":"test","nested":{"key":"val"}}');
    mockLlmYaml('project:\n  name: test');

    const res = await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'filepath', filePath, targetLayer: 3 });

    expect(res.status).toBe(200);
    // Should be formatted with indentation
    expect(res.body.rawInput).toContain('"name": "test"');
  });
});

// ===========================================================================
// POST /api/context/extract — url mode
// ===========================================================================

describe('POST /api/context/extract — url mode', () => {
  test('fetches URL and strips HTML tags', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => '<html><body><h1>Hello</h1><p>World</p></body></html>',
    } as any);
    mockLlmYaml('project:\n  name: Hello');

    const res = await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'url', url: 'https://example.com/about', targetLayer: 3 });

    expect(res.status).toBe(200);
    expect(res.body.rawInput).toContain('Hello');
    expect(res.body.rawInput).toContain('World');
    expect(res.body.rawInput).not.toContain('<html>');
  });

  test('rewrites github.com/*/blob/* to raw.githubusercontent.com', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => '# README\nSome project docs',
    } as any);
    mockLlmYaml('project:\n  name: GHProject');

    await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        mode: 'url',
        url: 'https://github.com/user/repo/blob/main/README.md',
        targetLayer: 3,
      });

    // Verify fetch was called with raw URL
    expect(mockFetch).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/user/repo/main/README.md',
      expect.any(Object)
    );
  });

  test('blocks localhost URLs with 400', async () => {
    const res = await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'url', url: 'http://localhost:3000/api/secret', targetLayer: 3 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Private');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('blocks 192.168.x.x URLs with 400', async () => {
    const res = await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'url', url: 'http://192.168.1.1/admin', targetLayer: 3 });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('blocks 10.x.x.x URLs with 400', async () => {
    const res = await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'url', url: 'http://10.0.0.1/internal', targetLayer: 3 });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// POST /api/context/extract — multi mode
// ===========================================================================

describe('POST /api/context/extract — multi mode', () => {
  test('combines sources with labeled separators in single LLM pass', async () => {
    // Create a temp file for the filepath source
    const filePath = path.join(tmpDir, 'arch.md');
    fs.writeFileSync(filePath, '## Architecture\nMicroservices pattern');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => '# API Docs\nREST endpoints listed here',
    } as any);
    mockLlmYaml('project:\n  architecture: microservices');

    const res = await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        mode: 'multi',
        targetLayer: 3,
        sources: [
          { type: 'paste', content: 'This is a task management tool', label: 'README' },
          { type: 'filepath', content: filePath, label: 'Architecture Doc' },
          { type: 'url', content: 'https://example.com/api-docs', label: 'API Reference' },
        ],
      });

    expect(res.status).toBe(200);

    // Verify labeled separators in rawInput
    expect(res.body.rawInput).toContain('=== Source: README ===');
    expect(res.body.rawInput).toContain('This is a task management tool');
    expect(res.body.rawInput).toContain('=== Source: Architecture Doc ===');
    expect(res.body.rawInput).toContain('Microservices pattern');
    expect(res.body.rawInput).toContain('=== Source: API Reference ===');

    // Only one LLM call
    expect(mockChatComplete).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// POST /api/context/upload
// ===========================================================================

describe('POST /api/context/upload', () => {
  test('accepts uploaded files and runs multi-source extraction', async () => {
    mockLlmYaml('project:\n  files: 2', { extracted: ['project.files'] });

    const res = await request(app)
      .post('/api/context/upload')
      .set('Authorization', `Bearer ${authToken}`)
      .field('targetLayer', '3')
      .attach('files', Buffer.from('# README\nProject overview'), { filename: 'README.md' })
      .attach('files', Buffer.from('interface Foo { bar: string; }'), { filename: 'types.ts' });

    expect(res.status).toBe(200);
    expect(res.body.yaml).toContain('project:');
    expect(res.body.rawInput).toContain('=== Source: README.md ===');
    expect(res.body.rawInput).toContain('=== Source: types.ts ===');
    expect(res.body.tokenCount).toBeGreaterThan(0);
    expect(mockChatComplete).toHaveBeenCalledTimes(1);
  });

  test('returns 400 when no files uploaded', async () => {
    const res = await request(app)
      .post('/api/context/upload')
      .set('Authorization', `Bearer ${authToken}`)
      .field('targetLayer', '3');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No files');
  });

  test('returns 400 when targetLayer missing', async () => {
    const res = await request(app)
      .post('/api/context/upload')
      .set('Authorization', `Bearer ${authToken}`)
      .attach('files', Buffer.from('hello'), { filename: 'test.md' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('targetLayer');
  });
});

// ===========================================================================
// GET /api/context/fetch-preview
// ===========================================================================

describe('GET /api/context/fetch-preview', () => {
  test('returns 500-char preview + contentType', async () => {
    const longContent = 'A'.repeat(2000);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'text/markdown' }),
      text: async () => longContent,
    } as any);

    const res = await request(app)
      .get('/api/context/fetch-preview?url=https://example.com/readme.md')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.preview.length).toBe(500);
    expect(res.body.contentLength).toBe(2000);
    expect(res.body.contentType).toBe('text/markdown');
  });

  test('returns 400 when url param missing', async () => {
    const res = await request(app).get('/api/context/fetch-preview').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('url');
  });

  test('blocks private URLs', async () => {
    const res = await request(app)
      .get('/api/context/fetch-preview?url=http://localhost:8080/secret')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Private');
  });
});

// ===========================================================================
// Confidence / #meta parsing
// ===========================================================================

describe('confidence parsing', () => {
  test('#meta line parsed correctly from LLM response', async () => {
    mockChatComplete.mockResolvedValueOnce({
      text: 'global:\n  tone: friendly\n#meta {"confidence":"medium","extracted":["global.tone"],"missing":["global.constraints"]}',
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const res = await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'paste', text: 'Be friendly and concise', targetLayer: 1 });

    expect(res.status).toBe(200);
    expect(res.body.confidence).toBe('medium');
    expect(res.body.extracted).toEqual(['global.tone']);
    expect(res.body.missing).toEqual(['global.constraints']);
  });

  test('missing #meta defaults to low confidence', async () => {
    mockChatComplete.mockResolvedValueOnce({
      text: 'global:\n  tone: friendly',
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const res = await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'paste', text: 'Something vague', targetLayer: 1 });

    expect(res.status).toBe(200);
    expect(res.body.confidence).toBe('low');
    expect(res.body.extracted).toEqual([]);
    expect(res.body.missing).toEqual([]);
  });
});

// ===========================================================================
// Validation edge cases
// ===========================================================================

describe('validation', () => {
  test('rejects missing mode', async () => {
    const res = await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ targetLayer: 3 });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Validation failed');
  });

  test('rejects invalid targetLayer', async () => {
    const res = await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'paste', text: 'hello', targetLayer: 5 });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Validation failed');
  });

  test('layer 1 prompt contains Global Brain instructions', async () => {
    mockLlmYaml('global:\n  style: terse');

    await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'paste', text: 'Be terse', targetLayer: 1 });

    const callArg = mockChatComplete.mock.calls[0][0][0].content as string;
    expect(callArg).toContain('Global Brain');
    expect(callArg).toContain("YAML root key: 'global'");
  });

  test('layer 2 prompt contains Domain Profile instructions', async () => {
    mockLlmYaml('domain:\n  industry: fintech');

    await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'paste', text: 'Fintech regulatory', targetLayer: 2 });

    const callArg = mockChatComplete.mock.calls[0][0][0].content as string;
    expect(callArg).toContain('Domain Profile');
    expect(callArg).toContain("YAML root key: 'domain'");
  });

  test('layer 3 prompt contains Project Brief instructions', async () => {
    mockLlmYaml('project:\n  name: Foo');

    await request(app)
      .post('/api/context/extract')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mode: 'paste', text: 'Foo is a project', targetLayer: 3 });

    const callArg = mockChatComplete.mock.calls[0][0][0].content as string;
    expect(callArg).toContain('Project Brief');
    expect(callArg).toContain("YAML root key: 'project'");
  });
});
