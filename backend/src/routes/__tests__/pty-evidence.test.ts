/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import request from 'supertest';

const queryOneMock = jest.fn();
const listTranscriptMock = jest.fn();
const getManifestMock = jest.fn();
const verifyArchiveMock = jest.fn();
const resolveSegmentMock = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => queryOneMock(...args),
}));
jest.mock('../../lib/pty-transcript-store', () => ({
  listPtyTranscriptEvents: (...args: unknown[]) => listTranscriptMock(...args),
}));
jest.mock('../../lib/pty-raw-archive', () => ({
  getRawPtyArchiveManifest: (...args: unknown[]) => getManifestMock(...args),
  verifyRawPtyArchive: (...args: unknown[]) => verifyArchiveMock(...args),
  resolveRawArchiveSegmentPath: (...args: unknown[]) => resolveSegmentMock(...args),
}));

import router from '../pty-evidence';

const GENERATION_ID = '123e4567-e89b-42d3-a456-426614174000';

function appFor(role: string) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = {
      id: 'user-1',
      email: 'user@example.test',
      supabaseId: 'auth-user-1',
      role,
    };
    next();
  });
  app.use(router);
  return app;
}

describe('PTY evidence routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryOneMock.mockResolvedValue({ workspace_id: 'ws-1' });
    listTranscriptMock.mockResolvedValue({
      contractVersion: 1,
      generationId: GENERATION_ID,
      items: [],
      nextCursor: null,
      hasMore: false,
      gaps: [],
    });
  });

  it('lists only a bounded generation cursor page for an authorized workspace member', async () => {
    queryOneMock
      .mockResolvedValueOnce({ workspace_id: 'ws-1' })
      .mockResolvedValueOnce({ role: 'member' });
    const response = await request(appFor('user'))
      .get(`/runs/77/generations/${GENERATION_ID}/transcript?limit=100&cursor=opaque`);
    expect(response.status).toBe(200);
    expect(listTranscriptMock).toHaveBeenCalledWith({
      runId: 77,
      generationId: GENERATION_ID,
      cursor: 'opaque',
      limit: 100,
    });
    expect(response.body.items).toEqual([]);
  });

  it('does not expose another workspace transcript', async () => {
    queryOneMock
      .mockResolvedValueOnce({ workspace_id: 'other-workspace' })
      .mockResolvedValueOnce(undefined);
    const response = await request(appFor('user'))
      .get(`/runs/77/generations/${GENERATION_ID}/transcript`);
    expect(response.status).toBe(403);
    expect(listTranscriptMock).not.toHaveBeenCalled();
  });

  it('requires an administrator before resolving restricted raw evidence', async () => {
    const response = await request(appFor('user'))
      .get(`/runs/77/generations/${GENERATION_ID}/raw-archive`);
    expect(response.status).toBe(403);
    expect(queryOneMock).not.toHaveBeenCalled();
    expect(verifyArchiveMock).not.toHaveBeenCalled();
  });

  it('streams only preverified contained segment bytes for an administrator', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-route-archive-'));
    const segmentPath = path.join(dir, 'segment.gz');
    const bytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03]);
    fs.writeFileSync(segmentPath, bytes);
    resolveSegmentMock.mockReturnValue(segmentPath);
    verifyArchiveMock.mockResolvedValue({
      contractVersion: 1,
      manifestId: '223e4567-e89b-42d3-a456-426614174000',
      generationId: GENERATION_ID,
      runId: 77,
      workspaceId: 'ws-1',
      storyId: 'PTY-003',
      compression: 'gzip',
      nextRawOffset: 4,
      completionState: 'complete',
      restrictedEvidence: true,
      retentionDays: 30,
      retentionExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      gaps: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      failureCode: null,
      failureMessage: null,
      segments: [{
        segmentIndex: 0,
        relativePath: `${GENERATION_ID}/segment-000000.gz`,
        rawStart: 0,
        rawEnd: 4,
        rawSize: 4,
        compressedSize: bytes.length,
        sha256: 'a'.repeat(64),
        completionState: 'complete',
        firstByteAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
      }],
      workspacePath: dir,
      archiveRootRelative: '.rorca/pty-archives',
      archiveRoot: dir,
      verifiedPaths: [segmentPath],
    });

    try {
      const response = await request(appFor('admin'))
        .get(`/runs/77/generations/${GENERATION_ID}/raw-archive`)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        });
      expect(response.status).toBe(200);
      expect(Buffer.from(response.body).equals(bytes)).toBe(true);
      expect(response.headers['content-type']).toBe('application/gzip');
      expect(resolveSegmentMock).toHaveBeenCalledWith(
        dir,
        '.rorca/pty-archives',
        `${GENERATION_ID}/segment-000000.gz`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
