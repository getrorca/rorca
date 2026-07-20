/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gunzipSync, gzipSync } from 'zlib';

const executeMock = jest.fn();
const queryMock = jest.fn();
const queryOneMock = jest.fn();
const transactionMock = jest.fn();

jest.mock('../../db/index', () => ({
  execute: (...args: unknown[]) => executeMock(...args),
  query: (...args: unknown[]) => queryMock(...args),
  queryOne: (...args: unknown[]) => queryOneMock(...args),
  transaction: (...args: unknown[]) => transactionMock(...args),
}));

import { hashContent } from '../context-safety';
import { ForbiddenError, RawArchiveIntegrityError } from '../errors';
import {
  RawPtyArchiveWriter,
  openRawPtyArchive,
  pruneExpiredRawPtyArchives,
  reconcileInterruptedRawPtyArchives,
  resolveRawArchiveSegmentPath,
  verifyRawPtyArchive,
} from '../pty-raw-archive';

const GENERATION_ID = '123e4567-e89b-42d3-a456-426614174000';

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pty-raw-archive-'));
}

let serviceRoot = '';
function archiveRoot(): string { return path.join(serviceRoot, 'workspace-test'); }

describe('raw PTY archive', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-service-archive-'));
    process.env.RORCA_PTY_ARCHIVE_ROOT = serviceRoot;
    executeMock.mockResolvedValue({ rowCount: 1 });
    queryMock.mockResolvedValue([]);
    queryOneMock.mockResolvedValue(undefined);
    transactionMock.mockImplementation(async (callback: (client: { query: jest.Mock }) => Promise<unknown>) => (
      callback({ query: jest.fn().mockResolvedValue({ rows: [] }) })
    ));
  });

  it('rejects traversal and symlink escapes from the workspace archive root', () => {
    const workspace = tempWorkspace();
    try {
      fs.mkdirSync(archiveRoot(), { recursive: true });
      expect(() => resolveRawArchiveSegmentPath(workspace, archiveRoot(), '../../secret', false))
        .toThrow(ForbiddenError);

      if (process.platform !== 'win32') {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-outside-'));
        fs.writeFileSync(path.join(outside, 'segment.gz'), 'secret');
        fs.symlinkSync(outside, path.join(archiveRoot(), 'escaped'));
        expect(() => resolveRawArchiveSegmentPath(
          workspace,
          archiveRoot(),
          'escaped/segment.gz',
        )).toThrow(ForbiddenError);
        expect(() => resolveRawArchiveSegmentPath(
          workspace,
          archiveRoot(),
          'escaped/new-segment.gz',
          false,
        )).toThrow(ForbiddenError);
        expect(fs.existsSync(path.join(outside, 'new-segment.gz'))).toBe(false);
        fs.rmSync(path.join(archiveRoot(), 'escaped'), { force: true });
        fs.rmSync(archiveRoot(), { recursive: true, force: true });
        fs.symlinkSync(outside, archiveRoot());
        expect(() => resolveRawArchiveSegmentPath(workspace, archiveRoot(), 'segment.gz')).toThrow(ForbiddenError);
        fs.rmSync(archiveRoot(), { force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('rotates ordered gzip segments without changing any raw PTY byte', async () => {
    const workspace = tempWorkspace();
    const generationDir = path.join(archiveRoot(), GENERATION_ID);
    fs.mkdirSync(generationDir, { recursive: true });
    const manifest = {
      id: '223e4567-e89b-42d3-a456-426614174000',
      generation_id: GENERATION_ID,
      run_id: 77,
      workspace_id: 'ws-1',
      story_id: 'PTY-003',
      archive_root_relative: archiveRoot(),
      segment_max_raw_bytes: 4096,
      next_raw_offset: 0,
      completion_state: 'writing',
      retention_days: 30,
      retention_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      gaps: [],
      started_at: new Date().toISOString(),
      completed_at: null,
      failure_code: null,
      failure_message: null,
      workspace_path: workspace,
    };
    const input = Buffer.concat([
      Buffer.from('\x1b[2Jfirst\rrepaint\n', 'utf8'),
      Buffer.from(Array.from({ length: 8_900 }, (_, index) => index % 256)),
    ]);

    try {
      const Writer = RawPtyArchiveWriter as unknown as new (row: unknown, index: number, offset: number) => RawPtyArchiveWriter;
      const writer = new Writer(manifest, 0, 0);
      writer.append(input.subarray(0, 3_000));
      writer.append(input.subarray(3_000));
      await writer.drain();

      const files = fs.readdirSync(generationDir).sort();
      expect(files).toHaveLength(3);
      const restored = Buffer.concat(files.map((name) => gunzipSync(fs.readFileSync(path.join(generationDir, name)))));
      expect(restored.equals(input)).toBe(true);
      expect(transactionMock).toHaveBeenCalledTimes(3);
      expect(executeMock).toHaveBeenCalledWith(expect.stringContaining("completion_state = 'complete'"), expect.any(Array));
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('retains the created descriptor and rejects segment-path replacement before persistence', async () => {
    const workspace = tempWorkspace();
    const generationDir = path.join(archiveRoot(), GENERATION_ID);
    fs.mkdirSync(generationDir, { recursive: true });
    const manifest = {
      id: '223e4567-e89b-42d3-a456-426614174001', generation_id: GENERATION_ID, run_id: 77,
      workspace_id: 'ws-1', story_id: 'PTY-RACE', archive_root_relative: archiveRoot(),
      segment_max_raw_bytes: 4096, next_raw_offset: 0, completion_state: 'writing', retention_days: 30,
      retention_expires_at: new Date(Date.now() + 86_400_000).toISOString(), gaps: [], started_at: new Date().toISOString(),
      completed_at: null, failure_code: null, failure_message: null, workspace_path: workspace,
    };
    const Writer = RawPtyArchiveWriter as unknown as new (row: unknown, index: number, offset: number) => RawPtyArchiveWriter;
    const writer = new Writer(manifest, 0, 0);
    writer.append(Buffer.from('first'));
    const segmentPath = path.join(generationDir, 'segment-000000.gz');
    fs.renameSync(segmentPath, `${segmentPath}.replaced`);
    fs.writeFileSync(segmentPath, gzipSync(Buffer.from('attacker')));
    writer.append(Buffer.from('second'));
    await expect(writer.drain()).rejects.toThrow(/no longer identifies its retained descriptor/);
    expect(gunzipSync(fs.readFileSync(segmentPath)).toString()).toBe('attacker');
  });

  it('reconciles an interrupted missing segment without renumbering valid later ranges', async () => {
    const workspace = tempWorkspace();
    const archiveDir = path.join(archiveRoot(), GENERATION_ID);
    fs.mkdirSync(archiveDir, { recursive: true });
    const laterCompressed = gzipSync(Buffer.from('bbbb'));
    fs.writeFileSync(path.join(archiveDir, 'segment-000001.gz'), laterCompressed);
    const manifest = {
      id: '223e4567-e89b-42d3-a456-426614174000',
      generation_id: GENERATION_ID,
      run_id: 77,
      workspace_id: 'ws-1',
      story_id: 'PTY-003',
      archive_root_relative: archiveRoot(),
      segment_max_raw_bytes: 4096,
      next_raw_offset: 8,
      completion_state: 'writing',
      retention_days: 30,
      retention_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      gaps: [],
      started_at: new Date().toISOString(),
      completed_at: null,
      failure_code: null,
      failure_message: null,
      workspace_path: workspace,
      generation_active: false,
      generation_status: 'failed',
    };
    const missing = {
      id: '323e4567-e89b-42d3-a456-426614174000', manifest_id: manifest.id,
      generation_id: GENERATION_ID, segment_index: 0,
      relative_path: `${GENERATION_ID}/segment-000000.gz`, raw_start: 0, raw_end: 4,
      raw_size: 4, compressed_size: 20, sha256: 'a'.repeat(64),
      completion_state: 'complete', first_byte_at: new Date().toISOString(),
      completed_at: new Date().toISOString(), verified_at: null,
    };
    const later = {
      ...missing,
      id: '423e4567-e89b-42d3-a456-426614174000',
      segment_index: 1,
      relative_path: `${GENERATION_ID}/segment-000001.gz`,
      raw_start: 4,
      raw_end: 8,
      compressed_size: laterCompressed.length,
      sha256: hashContent(laterCompressed),
    };
    queryMock.mockImplementation(async (sql: string) => (
      sql.includes('FROM pty_raw_archive_manifests m') ? [manifest] : [missing, later]
    ));

    try {
      expect(await reconcileInterruptedRawPtyArchives()).toBe(1);
      const laterUpsert = executeMock.mock.calls.find((call) => (
        String(call[0]).includes('INSERT INTO pty_raw_archive_segments')
        && Array.isArray(call[1])
        && call[1][2] === 1
      ));
      expect(laterUpsert?.[1][4]).toBe(4);
      expect(laterUpsert?.[1][5]).toBe(8);
      expect(executeMock).toHaveBeenCalledWith(
        expect.stringContaining("SET next_raw_offset = $2, completion_state = $3"),
        expect.arrayContaining([manifest.id, 8, 'corrupt']),
      );
      expect(executeMock).toHaveBeenCalledWith(
        expect.stringContaining("completion_state = 'missing'"),
        [missing.id],
      );
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('prunes only the expired contained generation directory and records retention state', async () => {
    const workspace = tempWorkspace();
    const generationDir = path.join(archiveRoot(), GENERATION_ID);
    fs.mkdirSync(generationDir, { recursive: true });
    fs.writeFileSync(path.join(generationDir, 'segment-000000.gz'), gzipSync(Buffer.from('old')));
    queryMock.mockResolvedValue([{
      id: '223e4567-e89b-42d3-a456-426614174000',
      generation_id: GENERATION_ID,
      run_id: 77,
      workspace_id: 'ws-1',
      story_id: 'PTY-003',
      archive_root_relative: archiveRoot(),
      segment_max_raw_bytes: 4096,
      next_raw_offset: 3,
      completion_state: 'complete',
      retention_days: 1,
      retention_expires_at: new Date(0).toISOString(),
      gaps: [],
      started_at: new Date(0).toISOString(),
      completed_at: new Date(0).toISOString(),
      failure_code: null,
      failure_message: null,
      workspace_path: workspace,
    }]);

    try {
      expect(await pruneExpiredRawPtyArchives()).toEqual({ pruned: 1, failed: 0 });
      expect(fs.existsSync(generationDir)).toBe(false);
      expect(transactionMock).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('relocates a parent-format workspace archive before read and safely resumes from retained service bytes', async () => {
    const workspace = tempWorkspace();
    const legacyRoot = path.join(workspace, '.rorca', 'pty-archives');
    const relativePath = `${GENERATION_ID}/segment-000000.gz`;
    const legacyPath = path.join(legacyRoot, relativePath);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    const compressed = gzipSync(Buffer.from('legacy retained'));
    fs.writeFileSync(legacyPath, compressed, { mode: 0o600 });
    const manifest = {
      id: '223e4567-e89b-42d3-a456-426614174099', generation_id: GENERATION_ID, run_id: 77,
      workspace_id: 'ws-legacy', story_id: 'PTY-LEGACY', archive_root_relative: '.rorca/pty-archives',
      segment_max_raw_bytes: 4096, next_raw_offset: 15, completion_state: 'complete', retention_days: 30,
      retention_expires_at: new Date(Date.now() + 86_400_000).toISOString(), gaps: [], started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(), failure_code: null, failure_message: null,
      workspace_path: workspace, generation_active: false, generation_status: 'exited',
    };
    const segment = {
      id: '323e4567-e89b-42d3-a456-426614174099', manifest_id: manifest.id, generation_id: GENERATION_ID,
      segment_index: 0, relative_path: relativePath, raw_start: 0, raw_end: 15, raw_size: 15,
      compressed_size: compressed.length, sha256: hashContent(compressed), completion_state: 'complete',
      first_byte_at: new Date().toISOString(), completed_at: new Date().toISOString(), verified_at: null,
    };
    const legacyServiceRoot = path.join(serviceRoot, createHash('sha256').update('ws-legacy').digest('hex'));
    const serviceManifest = { ...manifest, archive_root_relative: legacyServiceRoot };
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO pty_raw_archive_manifests')) return [manifest];
      if (sql.includes('FROM pty_raw_archive_segments')) return [segment];
      return [];
    });
    queryOneMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pty_raw_archive_manifests m')) return manifest;
      if (sql.includes('UPDATE pty_raw_archive_manifests') && sql.includes('RETURNING')) return serviceManifest;
      if (sql.includes('SELECT g.workspace_id')) return { workspace_id: 'ws-legacy', story_id: 'PTY-LEGACY', workspace_path: workspace, is_active: true };
      if (sql.includes('SELECT completion_state')) return { completion_state: 'writing', gaps: [] };
      return undefined;
    });

    try {
      const verified = await verifyRawPtyArchive(77, GENERATION_ID);
      expect(verified.archiveRoot).toBe(legacyServiceRoot);
      expect(verified.verifiedPaths).toHaveLength(1);
      expect(gunzipSync(fs.readFileSync(verified.verifiedPaths[0]!)).toString()).toBe('legacy retained');
      expect(fs.readFileSync(legacyPath).equals(compressed)).toBe(true);
      expect(queryOneMock).toHaveBeenCalledWith(expect.stringContaining('archive_root_relative = $2'),
        [manifest.id, legacyServiceRoot, '.rorca/pty-archives']);

      const writer = await openRawPtyArchive({ generationId: GENERATION_ID, runId: 77, generationToken: 'legacy-token' });
      writer.append(Buffer.from(' resumed'));
      await writer.drain();
      expect(fs.existsSync(path.join(legacyServiceRoot, GENERATION_ID, 'segment-000001.gz'))).toBe(true);
      expect(fs.existsSync(legacyPath)).toBe(true);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('verifies every segment hash and reports later corruption without hiding earlier evidence', async () => {
    const workspace = tempWorkspace();
    const relativePath = `${GENERATION_ID}/segment-000000.gz`;
    const absolutePath = path.join(archiveRoot(), relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const compressed = gzipSync(Buffer.from('exact raw bytes'));
    fs.writeFileSync(absolutePath, compressed);
    const manifest = {
      id: '223e4567-e89b-42d3-a456-426614174000',
      generation_id: GENERATION_ID,
      run_id: 77,
      workspace_id: 'ws-1',
      story_id: 'PTY-003',
      archive_root_relative: archiveRoot(),
      segment_max_raw_bytes: 4096,
      next_raw_offset: 15,
      completion_state: 'complete',
      retention_days: 30,
      retention_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      gaps: [],
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      failure_code: null,
      failure_message: null,
      workspace_path: workspace,
      generation_active: false,
      generation_status: 'exited',
    };
    const segment = {
      id: '323e4567-e89b-42d3-a456-426614174000',
      manifest_id: manifest.id,
      generation_id: GENERATION_ID,
      segment_index: 0,
      relative_path: relativePath,
      raw_start: 0,
      raw_end: 15,
      raw_size: 15,
      compressed_size: compressed.length,
      sha256: hashContent(compressed),
      completion_state: 'complete',
      first_byte_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      verified_at: null,
    };
    queryOneMock.mockResolvedValue(manifest);
    queryMock.mockResolvedValue([segment]);

    try {
      const verified = await verifyRawPtyArchive(77, GENERATION_ID);
      expect(verified.nextRawOffset).toBe(15);
      expect(verified.verifiedPaths).toEqual([fs.realpathSync(absolutePath)]);

      fs.appendFileSync(absolutePath, Buffer.from('tamper'));
      await expect(verifyRawPtyArchive(77, GENERATION_ID)).rejects.toBeInstanceOf(RawArchiveIntegrityError);
      expect(transactionMock).toHaveBeenCalled();
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
