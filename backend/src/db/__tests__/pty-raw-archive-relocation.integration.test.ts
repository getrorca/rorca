/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Pool } from 'pg';
import { assertConnectedTestDatabase, resolveTestDatabaseUrl } from '../../lib/test-db-safety';
import {
  openRawPtyArchive,
  reconcileInterruptedRawPtyArchives,
  verifyRawPtyArchive,
} from '../../lib/pty-raw-archive';

const connectionString = resolveTestDatabaseUrl();
const pool = new Pool({ connectionString, max: 2 });

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

describe('dirty-upgrade PTY parent-format relocation (real PostgreSQL/filesystem)', () => {
  const workspaceId = `pty-relocation-${crypto.randomUUID()}`;
  const generationId = crypto.randomUUID();
  const generationToken = crypto.randomUUID();
  const storyId = 'US-PTY-RELOCATION';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pty-relocation-'));
  const workspacePath = path.join(root, 'workspace');
  const serviceRoot = path.join(root, 'service-owned');
  const legacyRoot = path.join(workspacePath, '.rorca', 'pty-archives');
  const legacyGeneration = path.join(legacyRoot, generationId);
  let runId: number;
  let manifestId: string;
  const legacyRaw = Buffer.from('legacy-pty-bytes\n', 'utf8');
  const legacyCompressed = gzipSync(legacyRaw);

  beforeAll(async () => {
    await assertConnectedTestDatabase(pool, connectionString);
    fs.mkdirSync(legacyGeneration, { recursive: true, mode: 0o700 });
    fs.mkdirSync(serviceRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(legacyGeneration, 'segment-000000.gz'), legacyCompressed, { mode: 0o600 });
    process.env.RORCA_PTY_ARCHIVE_ROOT = serviceRoot;

    await pool.query(
      `INSERT INTO workspaces (id, label, path) VALUES ($1, 'PTY relocation fixture', $2)`,
      [workspaceId, workspacePath],
    );
    runId = Number((await pool.query<{ id: string }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, terminal_mode)
       VALUES ('pty-relocation.json', $1, 'running', 'native-pty') RETURNING id`,
      [workspaceId],
    )).rows[0].id);
    await pool.query(
      `INSERT INTO pty_generations
         (id, run_id, workspace_id, story_id, attempt, generation_token, cwd, agent_type,
          raw_archive_expected, raw_archive_storage_scope)
       VALUES ($1, $2, $3, $4, 1, $5, $6, 'pi', FALSE, NULL)`,
      [generationId, runId, workspaceId, storyId, generationToken, workspacePath],
    );
    manifestId = (await pool.query<{ id: string }>(
      `INSERT INTO pty_raw_archive_manifests
         (generation_id, run_id, workspace_id, story_id, archive_root_relative,
          segment_max_raw_bytes, next_raw_offset, completion_state, retention_days,
          retention_expires_at)
       VALUES ($1, $2, $3, $4, '.rorca/pty-archives', 4096, $5, 'writing', 30,
               NOW() + INTERVAL '30 days') RETURNING id`,
      [generationId, runId, workspaceId, storyId, legacyRaw.length],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO pty_raw_archive_segments
         (manifest_id, generation_id, segment_index, relative_path, raw_start, raw_end,
          raw_size, compressed_size, sha256, completion_state, first_byte_at, completed_at)
       VALUES ($1, $2, 0, $3, 0, $4, $4, $5, $6, 'complete', NOW(), NOW())`,
      [manifestId, generationId, `${generationId}/segment-000000.gz`, legacyRaw.length,
        legacyCompressed.length, sha256(legacyCompressed)],
    );
  });

  afterAll(async () => {
    delete process.env.RORCA_PTY_ARCHIVE_FAILPOINT;
    delete process.env.RORCA_PTY_ARCHIVE_ROOT;
    if (runId) await pool.query('DELETE FROM pipeline_runs WHERE id = $1', [runId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.end();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rolls back both DB authorities between relocation statements, restarts, preserves bytes, resumes, and reruns idempotently', async () => {
    // The applied 201100 constraint rejects the half-authoritative state that a
    // dirty pre-201100 row could otherwise enter.
    await expect(pool.query(
      `UPDATE pty_generations SET raw_archive_storage_scope = 'service-owned'
        WHERE id = $1`,
      [generationId],
    )).rejects.toMatchObject({ code: '23514' });

    process.env.RORCA_PTY_ARCHIVE_FAILPOINT = 'relocation_after_manifest_before_generation';
    await expect(openRawPtyArchive({ runId, generationId, generationToken }))
      .rejects.toThrow('[pty-archive-failpoint] relocation_after_manifest_before_generation');
    delete process.env.RORCA_PTY_ARCHIVE_FAILPOINT;

    const rolledBack = await pool.query<{
      archive_root_relative: string;
      raw_archive_expected: boolean;
      raw_archive_storage_scope: string | null;
    }>(
      `SELECT m.archive_root_relative, g.raw_archive_expected, g.raw_archive_storage_scope
         FROM pty_raw_archive_manifests m
         JOIN pty_generations g ON g.id = m.generation_id
        WHERE m.id = $1`,
      [manifestId],
    );
    expect(rolledBack.rows[0]).toEqual({
      archive_root_relative: '.rorca/pty-archives',
      raw_archive_expected: false,
      raw_archive_storage_scope: null,
    });
    expect(fs.readFileSync(path.join(legacyGeneration, 'segment-000000.gz'))).toEqual(legacyCompressed);

    // The restart orphan pass closes the dead generation before archive
    // reconciliation. Reconciliation adopts already-copied identical destination
    // bytes and atomically publishes manifest + generation authority.
    await pool.query(
      `UPDATE pty_generations SET is_active = FALSE, status = 'exited', exited_at = NOW()
        WHERE id = $1`,
      [generationId],
    );
    expect(await reconcileInterruptedRawPtyArchives()).toBeGreaterThanOrEqual(1);
    const relocated = await pool.query<{
      archive_root_relative: string;
      raw_archive_expected: boolean;
      raw_archive_storage_scope: string | null;
    }>(
      `SELECT m.archive_root_relative, g.raw_archive_expected, g.raw_archive_storage_scope
         FROM pty_raw_archive_manifests m
         JOIN pty_generations g ON g.id = m.generation_id
        WHERE m.id = $1`,
      [manifestId],
    );
    expect(path.resolve(relocated.rows[0].archive_root_relative).startsWith(path.resolve(serviceRoot) + path.sep)).toBe(true);
    expect(relocated.rows[0].raw_archive_expected).toBe(true);
    expect(relocated.rows[0].raw_archive_storage_scope).toBe('service-owned');

    // A valid generation reattachment may resume the same generation identity.
    await pool.query(
      `UPDATE pty_generations SET is_active = TRUE, status = 'active', exited_at = NULL
        WHERE id = $1`,
      [generationId],
    );
    const continuation = Buffer.from('resumed-pty-bytes\n', 'utf8');
    const writer = await openRawPtyArchive({ runId, generationId, generationToken });
    writer.append(continuation);
    await writer.drain();

    const verified = await verifyRawPtyArchive(runId, generationId);
    expect(verified.segments).toHaveLength(2);
    const reconstructed = Buffer.concat(verified.verifiedPaths.map((file) => gunzipSync(fs.readFileSync(file))));
    expect(reconstructed).toEqual(Buffer.concat([legacyRaw, continuation]));
    expect(fs.readFileSync(path.join(legacyGeneration, 'segment-000000.gz'))).toEqual(legacyCompressed);

    const rerun = await openRawPtyArchive({ runId, generationId, generationToken });
    await rerun.drain();
    const afterRerun = await verifyRawPtyArchive(runId, generationId);
    expect(afterRerun.segments).toHaveLength(2);
    expect(afterRerun.verifiedPaths.map((file) => sha256(fs.readFileSync(file))))
      .toEqual(verified.verifiedPaths.map((file) => sha256(fs.readFileSync(file))));
  }, 60_000);
});
