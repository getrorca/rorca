/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

jest.mock('../../db/index', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { query, queryOne } from '../../db/index';
import {
  appendGitReinsEvidence,
  listGitReinsEvidence,
} from '../gitreins-evidence-store';
import type { GitReinsJudgeResult } from '../gitreins-runner';

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;

function evidenceResult(): GitReinsJudgeResult {
  return {
    mode: 'enforce',
    status: 'pass',
    reasonCode: 'pass',
    passed: true,
    shouldBlock: false,
    durationMs: 12,
    attempt: 2,
    worktree: true,
    diagnostics: '',
    evidence: {
      $schema: 'https://gitreins.dev/schemas/evidence/v1.json',
      schemaVersion: '1.0',
      producer: { name: 'gitreins', version: '0.9.0' },
      command: 'judge',
      generatedAt: '2026-07-13T12:00:00.000Z',
      scope: 'working-tree',
      outcome: 'pass',
      passed: true,
      summary: 'pass',
      subject: { taskId: 'rorca-7-US-001', title: 'story', ephemeral: true },
      checks: [],
      metadata: {
        redacted: true,
        redactionsApplied: false,
        truncated: false,
        historyPersisted: false,
      },
    },
  };
}

const row = {
  id: '10',
  workspace_id: 'ws-1',
  run_id: '7',
  story_id: 'US-001',
  attempt: 2,
  mode: 'enforce',
  status: 'pass',
  reason_code: 'pass',
  schema_version: '1.0',
  command: 'judge',
  scope: 'working-tree',
  worktree: true,
  duration_ms: 12,
  evidence: evidenceResult().evidence,
  created_at: '2026-07-13T12:00:00.000Z',
};

describe('GitReins evidence store', () => {
  beforeEach(() => jest.clearAllMocks());

  test('uses one parameterized INSERT and exposes no update/delete operation', async () => {
    mockQueryOne.mockResolvedValueOnce(row as never);
    const saved = await appendGitReinsEvidence({
      workspaceId: 'ws-1', runId: 7, storyId: 'US-001', result: evidenceResult(),
    });
    expect(saved.id).toBe(10);
    expect(saved.worktree).toBe(true);
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toMatch(/^INSERT INTO gitreins_evidence/);
    expect(sql).not.toMatch(/UPDATE|DELETE/);
    expect(params?.slice(0, 3)).toEqual(['ws-1', 7, 'US-001']);
  });

  test('rejects disabled and invalid/oversized evidence before database access', async () => {
    const disabled = evidenceResult();
    disabled.mode = 'disabled';
    disabled.status = 'skipped';
    await expect(appendGitReinsEvidence({
      workspaceId: 'ws-1', runId: 7, storyId: 'US-001', result: disabled,
    })).rejects.toThrow(/not evidence rows/);

    const invalid = evidenceResult();
    (invalid.evidence!.metadata as { historyPersisted: boolean }).historyPersisted = true;
    await expect(appendGitReinsEvidence({
      workspaceId: 'ws-1', runId: 7, storyId: 'US-001', result: invalid,
    })).rejects.toThrow(/Invalid GitReins evidence/);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('lists evidence with mandatory workspace isolation and bounded pagination', async () => {
    mockQueryOne.mockResolvedValueOnce({ count: '1' } as never);
    mockQuery.mockResolvedValueOnce([row] as never);
    const listed = await listGitReinsEvidence({
      workspaceId: 'ws-1', runId: 7, storyId: 'US-001', limit: 500, offset: 3,
    });
    expect(listed.total).toBe(1);
    expect(listed.limit).toBe(100);
    expect(listed.items[0].workspaceId).toBe('ws-1');
    const [countSql, countParams] = mockQueryOne.mock.calls[0];
    expect(countSql).toContain('workspace_id = $1');
    expect(countSql).toContain('run_id = $2');
    expect(countSql).toContain('story_id = $3');
    expect(countParams).toEqual(['ws-1', 7, 'US-001']);
    expect(mockQuery.mock.calls[0][1]).toEqual(['ws-1', 7, 'US-001', 100, 3]);
  });
});
