import * as fs from 'fs';

jest.mock('../../db/index', () => ({ queryOne: jest.fn(), transaction: jest.fn() }));
jest.mock('fs', () => ({ existsSync: jest.fn(), readFileSync: jest.fn() }));
jest.mock('../execution-engine', () => ({ markStoryPassed: jest.fn() }));
jest.mock('../sse-hub', () => ({ broadcastAll: jest.fn() }));
jest.mock('simple-git', () => jest.fn());

import { queryOne, transaction } from '../../db/index';
import { markStoryPassed } from '../execution-engine';
import { broadcastAll } from '../sse-hub';
import simpleGit from 'simple-git';
import {
  checkpointReconciliationSchema,
  getCheckpointAttestationReference,
  reconcileCheckpoint,
  type CheckpointReconciliationInput,
} from '../checkpoint-reconciliation';

const mockedQueryOne = queryOne as jest.Mock;
const mockedTransaction = transaction as jest.Mock;
const mockedMarkPassed = markStoryPassed as jest.Mock;
const mockedBroadcast = broadcastAll as jest.Mock;
const mockedGit = simpleGit as jest.Mock;
const SHA = '0123456789abcdef0123456789abcdef01234567';
const ATTESTATION_ID = '11111111-1111-4111-8111-111111111111';
const DIGEST = 'a'.repeat(64);

const input: CheckpointReconciliationInput = {
  workspaceId: 'ws-recovery', specId: 'recovery-spec', runId: 21, storyId: 'US-002',
  branch: 'recovery/checkpoint', checkpointSha: SHA, attestationId: ATTESTATION_ID, attestationDigest: DIGEST,
};

function installTransaction(options: {
  attestation?: Partial<Record<string, unknown>>;
  provenance?: unknown[];
  run?: Partial<Record<string, unknown>>;
} = {}) {
  const client = { query: jest.fn(async (sql: string) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('SELECT path FROM workspaces')) return { rows: [{ path: '/workspace' }] };
    if (sql.includes('SELECT workspace_id, spec_path')) return { rows: [{
      workspace_id: 'ws-recovery', spec_path: 'forge/specs/approved/recovery-spec.json',
      status: 'failed', branch_name: 'recovery/checkpoint', auto_merge: true,
      merge_strategy: 'direct', merge_status: 'merged', ...options.run,
    }] };
    if (sql.includes('checkpoint_validation_attestations')) return { rows: [{ id: ATTESTATION_ID, workspace_id: 'ws-recovery', run_id: 21, story_id: 'US-002', branch_name: 'recovery/checkpoint', checkpoint_sha: SHA, validation_gate: 'ci', evidence_digest: DIGEST, passed_at: new Date(Date.now() - 1_000).toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null, ...options.attestation }] };
    if (sql.includes('FROM checkpoint_reconciliations')) return { rows: options.provenance ?? [] };
    if (sql.includes('INSERT INTO wal_events')) return { rows: [{ id: 77 }] };
    return { rows: [] };
  }) };
  mockedTransaction.mockImplementation(async (fn: (value: typeof client) => unknown) => fn(client));
  return client;
}

describe('checkpoint reconciliation attestation contract', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({ userStories: [{ id: 'US-001', passes: true }, { id: 'US-002', passes: false, dependsOn: ['US-001'] }] }));
    mockedGit.mockReturnValue({ raw: jest.fn().mockResolvedValue(`${SHA}\n`) });
    mockedMarkPassed.mockResolvedValue({ changed: true, storyFound: true });
    installTransaction();
  });

  it('resolves only an existing trusted attestation without creating one', async () => {
    mockedQueryOne.mockResolvedValueOnce({
      id: ATTESTATION_ID, evidence_digest: DIGEST, validation_gate: 'ci',
      expires_at: '2026-07-05T00:00:00.000Z',
    });
    await expect(getCheckpointAttestationReference({
      workspaceId: input.workspaceId, runId: input.runId, storyId: input.storyId,
      branch: input.branch, checkpointSha: input.checkpointSha,
    })).resolves.toMatchObject({ attestationId: ATTESTATION_ID, attestationDigest: DIGEST, validationGate: 'ci' });
  });

  it('requires an opaque full-head attestation, not caller validation prose', () => {
    expect(checkpointReconciliationSchema.safeParse({ ...input, checkpointSha: SHA.slice(0, 12) }).success).toBe(false);
    expect(checkpointReconciliationSchema.safeParse({ ...input, validation: { passed: true, summary: 'trust me' } }).success).toBe(false);
  });

  it('records only immutable provenance after exact branch-head and gate validation', async () => {
    const result = await reconcileCheckpoint(input);
    expect(result).toMatchObject({ reconciled: true, idempotent: false, checkpointSha: SHA, validationGate: 'ci', walEventId: 77 });
    expect(mockedMarkPassed).toHaveBeenCalledWith('/workspace/forge/specs/approved/recovery-spec.json', 'US-002');
    expect(mockedBroadcast).toHaveBeenCalledWith({ id: 77 });
  });

  it('rejects forged attestations before canonical story mutation', async () => {
    installTransaction({ attestation: { checkpoint_sha: 'f'.repeat(40) } });
    await expect(reconcileCheckpoint(input)).rejects.toMatchObject({ code: 'CONFLICT', details: { code: 'CHECKPOINT_ATTESTATION_MISMATCH' } });
    expect(mockedMarkPassed).not.toHaveBeenCalled();
  });

  it('rejects contribution evidence until direct base integration is recorded', async () => {
    installTransaction({ run: { auto_merge: false, merge_strategy: 'branch-only', merge_status: 'pending' } });
    await expect(reconcileCheckpoint(input)).rejects.toMatchObject({
      code: 'CONFLICT', details: { code: 'CHECKPOINT_BRANCH_NOT_INTEGRATED' },
    });
    expect(mockedMarkPassed).not.toHaveBeenCalled();
  });

  it('rejects a checkpoint that is not reachable from the integrated base', async () => {
    mockedGit.mockReturnValue({ raw: jest.fn()
      .mockResolvedValueOnce(`${SHA}\n`)
      .mockRejectedValueOnce(new Error('not ancestor')) });
    await expect(reconcileCheckpoint(input)).rejects.toMatchObject({
      code: 'CONFLICT', details: { code: 'CHECKPOINT_NOT_BASE_INTEGRATED' },
    });
    expect(mockedMarkPassed).not.toHaveBeenCalled();
  });

  it('is idempotent only for identical provenance and rejects a different post-pass checkpoint', async () => {
    installTransaction({ provenance: [{ checkpoint_sha: SHA, attestation_id: ATTESTATION_ID, attestation_digest: DIGEST }] });
    await expect(reconcileCheckpoint(input)).resolves.toMatchObject({ idempotent: true });
    expect(mockedMarkPassed).not.toHaveBeenCalled();

    installTransaction({ provenance: [{ checkpoint_sha: 'b'.repeat(40), attestation_id: ATTESTATION_ID, attestation_digest: DIGEST }] });
    await expect(reconcileCheckpoint(input)).rejects.toMatchObject({ code: 'CONFLICT', details: { code: 'CHECKPOINT_PROVENANCE_CONFLICT' } });
  });

  it('rejects a disappeared story or a race reported by the canonical mutator', async () => {
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({ userStories: [{ id: 'US-001', passes: true }] }));
    await expect(reconcileCheckpoint(input)).rejects.toMatchObject({ code: 'CONFLICT', details: { code: 'CHECKPOINT_STORY_DISAPPEARED' } });
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({ userStories: [{ id: 'US-001', passes: true }, { id: 'US-002', passes: false }] }));
    mockedMarkPassed.mockResolvedValueOnce({ changed: false, storyFound: false });
    await expect(reconcileCheckpoint(input)).rejects.toMatchObject({ code: 'CONFLICT', details: { code: 'CHECKPOINT_STORY_RACE' } });
  });
});
