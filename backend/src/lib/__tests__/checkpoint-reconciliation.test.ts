import * as fs from 'fs';

jest.mock('../../db/index', () => ({ execute: jest.fn(), queryOne: jest.fn() }));
jest.mock('fs', () => ({ existsSync: jest.fn(), readFileSync: jest.fn() }));
jest.mock('../execution-engine', () => ({ markStoryPassed: jest.fn() }));
jest.mock('../sse-hub', () => ({ broadcastAll: jest.fn() }));
jest.mock('simple-git', () => jest.fn());

import { queryOne } from '../../db/index';
import { markStoryPassed } from '../execution-engine';
import { broadcastAll } from '../sse-hub';
import simpleGit from 'simple-git';
import {
  checkpointReconciliationSchema,
  reconcileCheckpoint,
  type CheckpointReconciliationInput,
} from '../checkpoint-reconciliation';

const mockedQueryOne = queryOne as jest.Mock;
const mockedMarkPassed = markStoryPassed as jest.Mock;
const mockedBroadcast = broadcastAll as jest.Mock;
const mockedGit = simpleGit as jest.Mock;

const input: CheckpointReconciliationInput = {
  workspaceId: 'ws-recovery',
  specId: 'recovery-spec',
  runId: 21,
  storyId: 'US-002',
  branch: 'recovery/checkpoint',
  commitSha: '0123456789abcdef',
  validation: {
    passed: true,
    completedAt: new Date().toISOString(),
    commitSha: '0123456789abcdef',
    command: 'npm test -- recovery',
    summary: 'focused validation passed',
  },
};

describe('checkpoint reconciliation contract', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
      userStories: [
        { id: 'US-001', passes: true },
        { id: 'US-002', passes: false, dependsOn: ['US-001'] },
      ],
    }));
    mockedQueryOne
      .mockResolvedValueOnce({ path: '/workspace' })
      .mockResolvedValueOnce({
        workspace_id: 'ws-recovery',
        spec_path: 'forge/specs/approved/recovery-spec.json',
        status: 'failed',
        branch_name: 'recovery/checkpoint',
      })
      .mockResolvedValueOnce({ id: 77 });
    mockedGit.mockReturnValue({ raw: jest.fn()
      .mockResolvedValueOnce('0123456789abcdef0123456789abcdef01234567\n')
      .mockResolvedValueOnce('') });
    mockedMarkPassed.mockResolvedValue({ changed: true, storyFound: true });
  });


  it('rejects missing, stale, and mismatched validation evidence before mutation', async () => {
    expect(checkpointReconciliationSchema.safeParse({ ...input, validation: undefined }).success).toBe(false);
    await expect(reconcileCheckpoint({
      ...input,
      validation: { ...input.validation, completedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() },
    })).rejects.toMatchObject({ code: 'CHECKPOINT_EVIDENCE_STALE' });
    await expect(reconcileCheckpoint({
      ...input,
      validation: { ...input.validation, commitSha: 'abcdef0123456789' },
    })).rejects.toMatchObject({ code: 'CHECKPOINT_EVIDENCE_COMMIT_MISMATCH' });
    expect(mockedMarkPassed).not.toHaveBeenCalled();
  });

  it('validates canonical ownership and records only digested evidence in WAL', async () => {
    const result = await reconcileCheckpoint(input);

    expect(result).toMatchObject({ reconciled: true, idempotent: false, walEventId: 77 });
    expect(result.validation.commandDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(input.validation.command);
    expect(mockedMarkPassed).toHaveBeenCalledWith('/workspace/forge/specs/approved/recovery-spec.json', 'US-002');
    expect(mockedQueryOne).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO wal_events'), expect.arrayContaining([
      'checkpoint_reconciled', 'ws-recovery', 'recovery-spec', 21,
    ]));
    expect(mockedBroadcast).toHaveBeenCalledWith({ id: 77 });
  });

  it('is idempotent and does not emit a second WAL event', async () => {
    mockedMarkPassed.mockResolvedValueOnce({ changed: false, storyFound: true });
    const result = await reconcileCheckpoint(input);

    expect(result).toMatchObject({ reconciled: true, idempotent: true });
    expect(mockedQueryOne).toHaveBeenCalledTimes(2);
    expect(mockedBroadcast).not.toHaveBeenCalled();
  });
});
