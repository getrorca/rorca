/**
 * Regression coverage for PTY capture persistence/replay semantics.
 */

import { execute, queryOne } from '../../db/index';
import {
  appendRunPtyOutput,
  getRunPtySessionHealth,
  initializeRunPtySequence,
  listRunPtyChunks,
  markRunPtyCompletionMarkerSeen,
  recordRunPtyHeartbeat,
  startRunPtySession,
} from '../run-pty-store';

describe('run-pty-store', () => {
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
       VALUES ($1, $2, 'running', 'pi', 'pi', 'pty')
       RETURNING id`,
      ['forge/specs/approved/pty-store-test.json', workspaceId],
    );
    runId = result!.id;
  });

  afterEach(async () => {
    await execute('DELETE FROM pipeline_runs WHERE workspace_id = $1', [workspaceId]);
    await execute('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  });

  it('persists raw PTY chunks in order and replays them after a sequence cursor', async () => {
    await startRunPtySession({
      runId,
      workspaceId,
      cwd: process.cwd(),
      agentType: 'pi',
      cols: 120,
      rows: 36,
      childPid: null,
      completionMarker: '__RORCA_STORY_DONE_1_US_001__',
    });
    const sequence = await initializeRunPtySequence(runId);

    await appendRunPtyOutput(runId, Buffer.from('first'), sequence);
    await appendRunPtyOutput(runId, Buffer.from('second'), sequence);

    const all = await listRunPtyChunks(runId);
    expect(all.map(row => row.sequence)).toEqual([1, 2]);
    expect(Buffer.concat(all.map(row => row.chunk)).toString('utf8')).toBe('firstsecond');

    const replayAfterOne = await listRunPtyChunks(runId, 1);
    expect(replayAfterOne.map(row => row.chunk.toString('utf8'))).toEqual(['second']);
  });

  it('records completion markers as metadata, not pass state or terminal output chunks', async () => {
    const marker = '__RORCA_STORY_DONE_1_US_001__';
    await startRunPtySession({
      runId,
      workspaceId,
      cwd: process.cwd(),
      agentType: 'pi',
      cols: 120,
      rows: 36,
      childPid: null,
      completionMarker: marker,
    });

    await markRunPtyCompletionMarkerSeen(runId, marker);

    const chunks = await listRunPtyChunks(runId);
    const health = await getRunPtySessionHealth(runId);
    const run = await queryOne<{ status: string }>('SELECT status FROM pipeline_runs WHERE id = $1', [runId]);
    expect(chunks).toEqual([]);
    expect(health?.completion_marker).toBe(marker);
    expect(health?.completion_marker_seen_at).toBeTruthy();
    expect(run?.status).toBe('running');
  });

  it('records heartbeats as metadata, not terminal output chunks', async () => {
    await startRunPtySession({
      runId,
      workspaceId,
      cwd: process.cwd(),
      agentType: 'pi',
      cols: 120,
      rows: 36,
      childPid: null,
    });

    await recordRunPtyHeartbeat(runId);

    const chunks = await listRunPtyChunks(runId);
    const health = await getRunPtySessionHealth(runId);
    expect(chunks).toEqual([]);
    expect(health?.last_heartbeat_at).toBeTruthy();
    expect(health?.last_output_at).toBeNull();
    expect(Number(health?.total_output_bytes ?? 0)).toBe(0);
  });
});
