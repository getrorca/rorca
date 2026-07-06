/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importExternalMemoryCandidates } from '../external-memory-import-adapters';

async function tempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'rorca-import-adapter-'));
}

describe('external memory import adapters', () => {
  test('file memory-bank adapter imports JSON with provenance, redaction diagnostics, and pending governance', async () => {
    const workspace = await tempWorkspace();
    const filePath = path.join(workspace, 'cline-memory.json');
    const secret = 'Bearer sk-test-1234567890abcdefghijklmnopqrstuvwxyz';
    await fs.writeFile(filePath, JSON.stringify({
      memories: [
        {
          id: 'mem-1',
          content: `Always use apiFetch. token=${secret}`,
          created_at: '2026-07-05T12:00:00Z',
          tags: ['frontend', 'convention'],
          confidence: 'high',
          trust_tier: 'verified',
          related_files: ['src/lib/apiFetch.ts'],
        },
      ],
    }));

    const result = await importExternalMemoryCandidates({
      workspaceId: 'ws-1',
      workspacePath: workspace,
      vendor: 'cline',
      adapter: 'memory-bank-file',
      dryRun: true,
      source: { filePath, format: 'json' },
      importedAt: '2026-07-06T00:00:00Z',
    });

    expect(result.dryRun).toBe(true);
    expect(result.diagnostics.stagedCandidates).toBe(0);
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate.vendor).toBe('cline');
    expect(candidate.workspaceId).toBe('ws-1');
    expect(candidate.originalId).toBe('mem-1');
    expect(candidate.occurredAt).toBe('2026-07-05T12:00:00.000Z');
    expect(candidate.importedAt).toBe('2026-07-06T00:00:00.000Z');
    expect(candidate.tags).toEqual(['frontend', 'convention']);
    expect(candidate.confidence).toBe('high');
    expect(candidate.trustTier).toBe('verified');
    expect(candidate.relatedFiles).toEqual(['src/lib/apiFetch.ts']);
    expect(candidate.content).not.toContain(secret);
    expect(candidate.redactionDiagnostics.redactionCount).toBeGreaterThan(0);
    expect(candidate.status).toBe('pending');
    expect(candidate.defaultRetrievalEligible).toBe(false);
    expect(candidate.payload.provenance).toMatchObject({
      vendor: 'cline',
      source_file: filePath,
      original_id: 'mem-1',
      imported_at: '2026-07-06T00:00:00.000Z',
      trust_tier: 'verified',
      related_files: ['src/lib/apiFetch.ts'],
    });
  });

  test('file adapter rejects malformed JSON exports with validation errors', async () => {
    await expect(importExternalMemoryCandidates({
      workspaceId: 'ws-1',
      vendor: 'roo',
      adapter: 'memory-bank-file',
      dryRun: true,
      source: { rawText: '{not-json', format: 'json' },
    })).rejects.toThrow(/Malformed memory-bank JSON export/);
  });

  test('duplicate imports are idempotently skipped by deterministic dedupe keys', async () => {
    const first = await importExternalMemoryCandidates({
      workspaceId: 'ws-1',
      vendor: 'cursor',
      adapter: 'memory-bank-file',
      dryRun: true,
      source: {
        rawText: [
          JSON.stringify({ id: 'same-id', text: 'Prefer repository-native validation.' }),
          JSON.stringify({ id: 'same-id', text: 'Prefer repository-native validation.' }),
        ].join('\n'),
        format: 'jsonl',
      },
    });

    expect(first.candidates).toHaveLength(1);
    expect(first.skipped).toEqual([{ originalId: 'same-id', reason: 'duplicate' }]);

    const second = await importExternalMemoryCandidates({
      workspaceId: 'ws-1',
      vendor: 'cursor',
      adapter: 'memory-bank-file',
      dryRun: true,
      existingDedupeKeys: [first.candidates[0].dedupeKey],
      source: { rawText: JSON.stringify({ id: 'same-id', text: 'Prefer repository-native validation.' }), format: 'json' },
    });

    expect(second.candidates).toHaveLength(0);
    expect(second.skipped).toEqual([{ originalId: 'same-id', reason: 'duplicate' }]);
  });

  test('markdown memory-bank imports preserve tags and related files', async () => {
    const result = await importExternalMemoryCandidates({
      workspaceId: 'ws-md',
      vendor: 'windsurf',
      adapter: 'memory-bank-file',
      dryRun: true,
      source: {
        format: 'markdown',
        rawText: '# API convention\nid: windsurf-rule-1\ntags: api, frontend\nfiles: src/lib/apiFetch.ts\nconfidence: medium\nUse apiFetch for every frontend API call.',
      },
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      originalId: 'windsurf-rule-1',
      vendor: 'windsurf',
      tags: ['api', 'frontend'],
      relatedFiles: ['src/lib/apiFetch.ts'],
      status: 'pending',
      defaultRetrievalEligible: false,
    });
  });

  test('trace/memory API adapter uses a mocked provider and preserves API provenance without SDK deps', async () => {
    const provider = jest.fn(async () => [
      {
        id: 'trace-1',
        input: 'Why did build fail?',
        output: 'Use cd backend && npx tsc --noEmit for backend typecheck.',
        timestamp: 1783305600000,
        tags: ['trace', 'validation'],
        trust_tier: 'local',
        related_files: ['backend/tsconfig.json'],
      },
    ]);

    const result = await importExternalMemoryCandidates({
      workspaceId: 'ws-api',
      vendor: 'langsmith',
      adapter: 'trace-memory-api',
      dryRun: true,
      source: { apiEndpoint: 'https://langsmith.invalid/api/runs', apiProvider: provider },
      importedAt: '2026-07-06T01:02:03Z',
    });

    expect(provider).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-api', vendor: 'langsmith' }));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      vendor: 'langsmith',
      originalId: 'trace-1',
      apiEndpoint: 'https://langsmith.invalid/api/runs',
      trustTier: 'local',
      relatedFiles: ['backend/tsconfig.json'],
      status: 'pending',
      defaultRetrievalEligible: false,
    });
    expect(result.candidates[0].payload.provenance).toMatchObject({
      api_endpoint: 'https://langsmith.invalid/api/runs',
      original_id: 'trace-1',
    });
  });
});
