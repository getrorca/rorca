/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Regression coverage for generation-isolated PTY persistence and controls. */

import { execute, queryOne } from '../../db/index';
import { ConflictError, ForbiddenError } from '../errors';
import {
  appendRunPtyOutput,
  claimLatestRunPtyResize,
  claimPendingRunPtyInput,
  completeRunPtySession,
  createRunPtyOutputBatcher,
  getRunPtyGeneration,
  getRunPtySessionHealth,
  initializeRunPtySequence,
  listRunPtyChunks,
  markRunPtyCompletionMarkerSeen,
  recordRunPtyHeartbeat,
  requestRunPtyInput,
  requestRunPtyResize,
  startRunPtySession,
  type PtyGenerationIdentity,
  type PtyGenerationRef,
} from '../run-pty-store';

function ref(generation: PtyGenerationIdentity): PtyGenerationRef {
  return {
    runId: generation.runId,
    generationId: generation.generationId,
    generationToken: generation.generationToken,
  };
}

describe('run-pty-store generations', () => {
  const workspaceId = 'pty-store-test-ws';
  let runId: number;

  beforeEach(async () => {
    await execute('DELETE FROM pipeline_runs WHERE workspace_id = $1', [workspaceId]);
    await execute('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await execute(
      'INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)',
      [workspaceId, 'PTY Store Test', process.cwd()],
    );
    const result = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, agent, agent_type, terminal_mode)
       VALUES ($1, $2, 'running', 'pi', 'pi', 'pty') RETURNING id`,
      ['forge/specs/approved/pty-store-test.json', workspaceId],
    );
    runId = result!.id;
  });

  afterEach(async () => {
    await execute('DELETE FROM pipeline_runs WHERE workspace_id = $1', [workspaceId]);
    await execute('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  });

  const start = (storyId = 'PTY-001', attempt = 1) => startRunPtySession({
    runId,
    workspaceId,
    storyId,
    attempt,
    cwd: process.cwd(),
    agentType: 'pi',
    cols: 120,
    rows: 36,
    childPid: null,
  });

  it('persists and replays bytes in an independent generation sequence space', async () => {
    const first = await start('PTY-001', 1);
    const firstRef = ref(first);
    const firstSequence = await initializeRunPtySequence(firstRef);
    await appendRunPtyOutput(firstRef, Buffer.from('first-attempt'), firstSequence);

    const retry = await start('PTY-001', 2);
    const retryRef = ref(retry);
    const retrySequence = await initializeRunPtySequence(retryRef);
    expect(retrySequence.value).toBe(1);
    await appendRunPtyOutput(retryRef, Buffer.from('retry-only'), retrySequence);

    await expect(appendRunPtyOutput(firstRef, Buffer.from('leak'), firstSequence))
      .rejects.toBeInstanceOf(ConflictError);
    const current = await listRunPtyChunks(runId);
    expect(current.map(row => row.sequence)).toEqual([1]);
    expect(Buffer.concat(current.map(row => row.chunk)).toString()).toBe('retry-only');
    expect(current[0].generation).toMatchObject({
      generationId: retry.generationId,
      storyId: 'PTY-001',
      attempt: 2,
      status: 'active',
      isActive: true,
      source: 'native',
      replaySource: 'generation',
    });

    const prior = await getRunPtyGeneration(runId, first.generationToken);
    const priorReplay = await listRunPtyChunks(runId, 0, 10, prior);
    expect(priorReplay.map(row => row.chunk.toString())).toEqual(['first-attempt']);
  });

  it('atomically supersedes concurrent starts and leaves exactly one active generation', async () => {
    const [storyA, storyB] = await Promise.all([
      start('PTY-001', 1),
      start('PTY-002', 1),
    ]);
    const active = await queryOne<{ count: string; story_id: string }>(
      `SELECT COUNT(*)::text AS count, MAX(story_id) FILTER (WHERE is_active) AS story_id
       FROM pty_generations WHERE run_id = $1 AND is_active`,
      [runId],
    );
    expect(active?.count).toBe('1');
    const rows = await queryOne<{ superseded: string }>(
      `SELECT COUNT(*)::text AS superseded FROM pty_generations
       WHERE run_id = $1 AND status = 'superseded'`,
      [runId],
    );
    expect(rows?.superseded).toBe('1');
    expect(new Set([storyA.generationId, storyB.generationId]).size).toBe(2);
  });

  it('requires the exact active token and prevents old processes claiming controls', async () => {
    const old = await start('PTY-001', 1);
    await expect(requestRunPtyInput(runId, old.generationToken, Buffer.from('old-pending')))
      .resolves.toMatchObject({ generationId: old.generationId });
    await requestRunPtyResize(runId, old.generationToken, 140, 40);

    const current = await start('PTY-002', 1);
    const currentRef = ref(current);
    await expect(requestRunPtyInput(runId, old.generationToken, Buffer.from('stale')))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(requestRunPtyResize(runId, old.generationToken, 90, 20))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(requestRunPtyInput(runId, crypto.randomUUID(), Buffer.from('mismatch')))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(claimPendingRunPtyInput(ref(old))).resolves.toEqual([]);
    await expect(claimLatestRunPtyResize(ref(old))).resolves.toBeNull();

    await requestRunPtyInput(runId, current.generationToken, Buffer.from('current-only'));
    await requestRunPtyResize(runId, current.generationToken, 100, 30);
    const input = await claimPendingRunPtyInput(currentRef);
    const resize = await claimLatestRunPtyResize(currentRef);
    expect(input.map(item => item.input.toString())).toEqual(['current-only']);
    expect(resize).toMatchObject({ cols: 100, rows: 30 });
  });

  it('cannot leak controls when admission races generation replacement', async () => {
    const old = await start('PTY-001', 1);
    const transition = Promise.allSettled([
      start('PTY-002', 1),
      requestRunPtyInput(runId, old.generationToken, Buffer.from('racing-input')),
      requestRunPtyResize(runId, old.generationToken, 101, 31),
    ]);

    const [replacementResult, inputResult, resizeResult] = await transition;
    expect(replacementResult.status).toBe('fulfilled');
    if (replacementResult.status !== 'fulfilled') return;
    const replacement = replacementResult.value;

    for (const result of [inputResult, resizeResult]) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(ForbiddenError);
      }
    }
    await expect(claimPendingRunPtyInput(ref(old))).resolves.toEqual([]);
    await expect(claimLatestRunPtyResize(ref(old))).resolves.toBeNull();
    await expect(claimPendingRunPtyInput(ref(replacement))).resolves.toEqual([]);
    await expect(claimLatestRunPtyResize(ref(replacement))).resolves.toBeNull();

    const controls = await queryOne<{ inputs: string; resizes: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM run_pty_input_requests WHERE run_id = $1) AS inputs,
         (SELECT COUNT(*)::text FROM run_pty_resize_requests WHERE run_id = $1) AS resizes`,
      [runId],
    );
    expect(controls).toEqual({ inputs: '0', resizes: '0' });
  });

  it('classifies writes to a closed generation as conflicts', async () => {
    const generation = await start();
    await completeRunPtySession(ref(generation), 'exited', 0, null);
    await expect(requestRunPtyInput(runId, generation.generationToken, Buffer.from('late')))
      .rejects.toBeInstanceOf(ConflictError);
    await expect(requestRunPtyResize(runId, generation.generationToken, 100, 30))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it('bounds each generation independently and resets completion/health evidence', async () => {
    const first = await start('PTY-001', 1);
    const firstRef = ref(first);
    const sequence = await initializeRunPtySequence(firstRef);
    const writer = createRunPtyOutputBatcher(firstRef, sequence, {
      maxCaptureBytes: 4,
      maxPendingBytes: 4,
      batchBytes: 4,
      batchChunks: 1,
    });
    writer.enqueue(Buffer.from('keep'));
    writer.enqueue(Buffer.from('drop'));
    await writer.drain();
    await markRunPtyCompletionMarkerSeen(firstRef, '__DONE__');
    await recordRunPtyHeartbeat(firstRef);

    const second = await start('PTY-002', 1);
    const health = await getRunPtySessionHealth(runId);
    expect(health).toMatchObject({
      generationId: second.generationId,
      storyId: 'PTY-002',
      attempt: 1,
      completion_marker_seen_at: null,
      last_heartbeat_at: null,
    });
    expect(Number(health?.total_output_bytes)).toBe(0);
    expect(Number(health?.dropped_output_bytes)).toBe(0);
    expect(health?.output_truncated_at).toBeNull();
  });

  it('reads untouched run-only bytes through an explicit legacy generation', async () => {
    const legacyToken = crypto.randomUUID();
    const legacy = await queryOne<{ id: string }>(
      `INSERT INTO pty_generations
        (run_id, workspace_id, story_id, attempt, generation_token, source,
         replay_source, is_active, status, cwd, agent_type)
       VALUES ($1, $2, '__legacy__', 0, $3, 'legacy', 'legacy_run_output',
         FALSE, 'legacy', $4, 'unknown') RETURNING id`,
      [runId, workspaceId, legacyToken, process.cwd()],
    );
    await execute(
      `INSERT INTO run_output_chunks (run_id, sequence, chunk)
       VALUES ($1, 7, $2), ($1, 9, $3)`,
      [runId, Buffer.from('legacy-seven'), Buffer.from('legacy-nine')],
    );

    const replay = await listRunPtyChunks(runId, 7, 10);
    expect(replay.map(row => row.sequence)).toEqual([9]);
    expect(replay[0].chunk.toString()).toBe('legacy-nine');
    expect(replay[0].generation).toMatchObject({
      generationId: legacy?.id,
      storyId: '__legacy__',
      attempt: 0,
      status: 'legacy',
      source: 'legacy',
      replaySource: 'legacy_run_output',
    });
    const untouched = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM run_output_chunks
       WHERE run_id = $1 AND sequence IN (7, 9)`,
      [runId],
    );
    expect(untouched?.count).toBe('2');
  });
});
