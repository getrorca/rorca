/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PoolClient } from 'pg';
import {
  claimDispatchForWorker,
  claimDispatchPublication,
  pipelineTriggerRequestHash,
} from '../dispatch-publication';
import { createStoryExecutionManifest } from '../story-execution-packet';
import { createStoryAttemptResult, evaluateStoryCloseout } from '../story-closeout';
import {
  assertCampaignTriggerBinding,
  buildProviderNeutralCompletionValidation,
  campaignDispatchAuthorizationHash,
  parseCampaignDispatchAuthorization,
  prepareCampaignDispatchPublication,
  requireCampaignServiceAuthentication,
  setCampaignDispatchPause,
  type CampaignDispatchAuthorization,
} from '../campaign-dispatch-authorization';
import { storyLifecycleFixture } from './fixtures/story-execution-manifest.fixture';

const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

const SHA = 'a'.repeat(40);
const MANIFEST_HASH = 'b'.repeat(64);
const REQUEST_HASH = `sha256:${'c'.repeat(64)}`;
const NOW = '2026-07-27T00:00:00.000Z';
const EXPIRES = '2099-07-27T01:00:00.000Z';

function authorization(overrides: Partial<CampaignDispatchAuthorization> = {}): CampaignDispatchAuthorization {
  const body: Omit<CampaignDispatchAuthorization, 'authorizationHash'> = {
    schemaVersion: 'hermes.campaign-dispatch-authorization.v1',
    manifestHash: MANIFEST_HASH,
    campaignId: 'campaign-1',
    waveId: 'wave-1',
    workspaceId: 'workspace-1',
    repository: 'owner/repository',
    repositoryHost: 'github.com',
    sha: SHA,
    specId: 'spec-1',
    specRevision: 'spec-revision-1',
    storyId: 'ROR-29',
    attemptFence: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'campaign:v3:key',
    arm: {
      receiptId: '101', decisionId: '101', operatorId: 'human-1', campaignId: 'campaign-1',
      manifestHash: MANIFEST_HASH, workspaceId: 'workspace-1', specId: 'campaign-arm-spec',
      specRevision: 'arm-revision-1', phaseId: 'merge', gateId: 'campaign-arm',
      decisionType: 'merge_approval', expiresAt: EXPIRES,
    },
    gate: {
      status: 'accepted', workspaceId: 'workspace-1', specId: 'spec-1',
      specRevision: 'spec-revision-1', sha: SHA, gateId: 'wave-gate', phaseId: 'merge',
      decisionType: 'merge_approval', decisionId: '102', signer: 'human-2', expiresAt: EXPIRES,
    },
    linear: [{
      status: 'accepted', issue: 'ROR-24', state: 'Done', approvalLabel: 'approved',
      updatedAt: NOW, workspaceId: 'linear-team', sourceRef: 'https://linear.app/team/issue/ROR-24',
    }],
    git: {
      sha: SHA, repository: 'owner/repository', remoteHost: 'github.com',
      remoteUrl: 'git@github.com:owner/repository.git', clean: true, detached: true,
      root: '/workspace', observedAt: NOW,
    },
    workspace: {
      workspaceId: 'workspace-1', repository: 'owner/repository', repositoryHost: 'github.com',
      source: 'github-app-installation', repositoryId: '123',
      bindingId: '11111111-1111-4111-8111-111111111112', observedAt: NOW,
    },
    pauseFileAbsent: true,
    issuedAt: NOW,
    expiresAt: EXPIRES,
  };
  return { authorizationHash: campaignDispatchAuthorizationHash(body), ...body, ...overrides };
}

function executionManifestInput(agent: 'claude' | 'opencode' | 'codex' | 'pi' = 'codex') {
  return {
    identity: { workspaceId: 'workspace-1', specId: 'spec-1', storyId: 'ROR-29', runId: 42, attempt: 1 },
    revisions: { specRevision: 'spec-revision-1', storyRevision: `sha256:${'d'.repeat(64)}` },
    executionMode: 'impl' as const,
    lifecycle: storyLifecycleFixture('workspace-1', 'spec-1', 'ROR-29'),
    execution: {
      agent, model: 'gpt-5', effort: null, terminal: 'ansi-html' as const,
      worktree: { enabled: true, path: '/worktree/run-42', branch: 'feat/spec-1', baseRevision: SHA },
      merge: { enabled: false, strategy: 'branch-only' as const, targetBranch: null },
    },
    validationPlan: [],
    evidenceExpectations: [],
    repositoryProfile: { profileId: 'default', changePolicy: 'code_required' as const, noCodeReason: null, runtimeMetadataPaths: [] },
    commandSafety: {
      profileId: 'default', guardVersion: 'v1', guardedWorkingDirectory: '/worktree/run-42',
      allowedWorkingDirectories: ['/worktree/run-42'], blockedCommandPatterns: [], redactedEnvironmentKeys: [],
      allowBackendJest: true, baselineFailurePolicy: 'block' as const,
    },
  };
}
const executionManifest = createStoryExecutionManifest(executionManifestInput());

function decisionRows(auth: CampaignDispatchAuthorization): Array<{
  id: string; workspace_id: string; spec_slug: string; spec_version: string;
  phase_id: string; gate_id: string; decision_type: CampaignDispatchAuthorization['gate']['decisionType'];
  subject_type: string; subject_value: string; principal_id: string;
  policy_authorized: boolean; expires_at: string; revoked_at: string | null;
}> {
  return [
    {
      id: auth.arm.decisionId, workspace_id: auth.workspaceId, spec_slug: auth.arm.specId,
      spec_version: auth.arm.specRevision, phase_id: auth.arm.phaseId, gate_id: auth.arm.gateId,
      decision_type: auth.arm.decisionType, subject_type: 'artifact_digest',
      subject_value: `sha256:${auth.manifestHash}`, principal_id: auth.arm.operatorId,
      policy_authorized: true, expires_at: auth.arm.expiresAt, revoked_at: null,
    },
    {
      id: auth.gate.decisionId, workspace_id: auth.workspaceId, spec_slug: auth.specId,
      spec_version: auth.specRevision, phase_id: auth.gate.phaseId, gate_id: auth.gate.gateId,
      decision_type: auth.gate.decisionType, subject_type: 'commit_sha', subject_value: auth.sha,
      principal_id: auth.gate.signer, policy_authorized: true,
      expires_at: auth.gate.expiresAt, revoked_at: null,
    },
  ];
}

interface FakeState {
  paused?: boolean;
  revokedArm?: boolean;
  existing?: Record<string, unknown>;
  insertCount: number;
  walCount: number;
}

function fakeClient(auth: CampaignDispatchAuthorization, state: FakeState): Pick<PoolClient, 'query'> {
  return {
    query: jest.fn(async (sqlValue: unknown, params: unknown[] = []) => {
      const sql = String(sqlValue).replace(/\s+/g, ' ');
      if (sql.includes('SELECT generation, state') && sql.includes('FROM campaign_dispatch_controls')) {
        return { rows: [{ generation: 3, state: state.paused ? 'paused' : 'active', db_now: NOW }] };
      }
      if (sql.includes('FROM ssdlc_decisions')) {
        const rows = decisionRows(auth);
        if (state.revokedArm) rows[0].revoked_at = NOW;
        return { rows };
      }
      if (sql.includes('FROM github_app_workspace_bindings binding')) {
        return { rows: [{
          binding_id: auth.workspace.bindingId, repository_id: Number(auth.workspace.repositoryId),
          repo_owner: 'owner', repo_name: 'repository', binding_status: 'active',
          registration_status: 'active', installation_status: 'active', superseded_at: null,
        }] };
      }
      if (sql.includes('FROM pipeline_runs WHERE id = $1 FOR UPDATE')) {
        return { rows: [{
          id: 42, workspace_id: auth.workspaceId, spec_path: `forge/specs/approved/${auth.specId}.json`,
          status: 'queued', idempotency_key: auth.idempotencyKey, dispatch_request_hash: REQUEST_HASH,
          expected_story_ids: [auth.storyId], agent_type: 'codex', auto_worktree: true,
          auto_merge: false, merge_strategy: 'branch-only', orchestration_mode: 'sequential',
          parallelism: 1, campaign_dispatch_authorization_hash: null,
        }] };
      }
      if (sql.includes('FROM story_execution_manifests')) return { rows: [{ payload: executionManifest }] };
      if (sql.includes('FROM pipeline_dispatch_publications WHERE run_id')) {
        return { rows: [{ boss_job_id: '22222222-2222-5222-a222-222222222222', state: 'preparing', lease_owner: 'owner-1', lease_expires_at: EXPIRES, request_hash: REQUEST_HASH, effective_options_hash: REQUEST_HASH }] };
      }
      if (sql.includes('FROM campaign_dispatch_authorizations') && sql.includes('FOR UPDATE')) {
        return { rows: state.existing ? [state.existing] : [] };
      }
      if (sql.includes('INSERT INTO campaign_dispatch_authorizations')) {
        state.insertCount += 1;
        return { rows: [{ authorization_hash: auth.authorizationHash, run_id: 42, request_hash: REQUEST_HASH, idempotency_key: auth.idempotencyKey, consumed_at: NOW, expires_at: EXPIRES, control_generation: 3, payload_snapshot: {} }] };
      }
      if (sql.includes('UPDATE pipeline_dispatch_publications')) {
        return { rows: [{ boss_job_id: '22222222-2222-5222-a222-222222222222' }] };
      }
      if (sql.includes("VALUES ('campaign_dispatch_authorization_consumed'")) state.walCount += 1;
      return { rows: [], rowCount: 1, params };
    }),
  } as unknown as Pick<PoolClient, 'query'>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTransaction.mockImplementation(async (callback: (client: Pick<PoolClient, 'query'>) => unknown) => callback(fakeClient(authorization(), { insertCount: 0, walCount: 0 })));
});

test('matches the exact Hermes pipeline-trigger-request v1 hash vector', () => {
  expect(pipelineTriggerRequestHash({ z: 2, a: { b: 1 } }))
    .toBe('sha256:985c65135b331550d0d37f16d76cc47bf2411636e0c97c8945aa5d0a9b7513b5');
});

test('parses exact Hermes v1 canonical hash and trigger binding', () => {
  const auth = parseCampaignDispatchAuthorization(authorization());
  expect(auth.authorizationHash).toBe('d6cdaa0661182f9e11a9284bb96404b8006b58b244cd800ff2e62f3924e13ec0');
  expect(() => assertCampaignTriggerBinding({
    authorization: auth,
    workspaceId: auth.workspaceId,
    specPath: `forge/specs/approved/${auth.specId}.json`,
    storyId: auth.storyId,
    idempotencyKey: auth.idempotencyKey,
    requestHash: REQUEST_HASH,
    autoWorktree: true,
    autoMerge: false,
    mergeStrategy: 'branch-only',
    triggerType: 'manual',
    orchestrationMode: 'sequential',
    parallelism: 1,
    forceSequential: true,
    executionEnvironment: 'remote-rorca',
  })).not.toThrow();
});

test('requires the canonical Hermes service principal, not an email-shaped hosted identity', () => {
  expect(() => requireCampaignServiceAuthentication({ user: { id: 'hosted-user', email: 'hermes@rorca.internal' } }))
    .toThrow(/authenticated Hermes service credential/);
  expect(() => requireCampaignServiceAuthentication({ user: { id: 'rorca-hermes-service', email: 'hermes@rorca.internal' } }))
    .not.toThrow();
});

test('rejects authorization-body tampering, readiness overrides, and credential-bearing Git remotes', () => {
  const auth = authorization();
  expect(() => parseCampaignDispatchAuthorization({ ...auth, storyId: 'ROR-28' })).toThrow(/hash/);
  expect(() => assertCampaignTriggerBinding({
    authorization: auth, workspaceId: auth.workspaceId, specPath: `forge/specs/approved/${auth.specId}.json`,
    storyId: auth.storyId, idempotencyKey: auth.idempotencyKey, requestHash: REQUEST_HASH,
    autoWorktree: true, autoMerge: false, mergeStrategy: 'branch-only', triggerType: 'manual',
    orchestrationMode: 'sequential', parallelism: 1, forceSequential: true,
    executionEnvironment: 'remote-rorca', readinessOverrideRequested: true,
  })).toThrow(/never permits/);
  const unsafe = authorization();
  unsafe.git.remoteUrl = 'https://secret-token@github.com/owner/repository.git';
  const { authorizationHash: _ignored, ...unsafeBody } = unsafe;
  unsafe.authorizationHash = campaignDispatchAuthorizationHash(unsafeBody);
  expect(() => parseCampaignDispatchAuthorization(unsafe)).toThrow(/credential-free/);
});

test.each(['claude', 'opencode', 'codex'] as const)('validates provider-neutral %s closeout without a Pi completion packet', (agent) => {
  const manifest = createStoryExecutionManifest(executionManifestInput(agent));
  const attempt = createStoryAttemptResult({
    identity: { ...manifest.identity },
    revisions: { ...manifest.revisions },
    manifestHash: manifest.manifestHash,
    agentProcess: { agent, model: null, effort: null, processId: 123, sessionId: `${agent}-session` },
    startedAt: NOW,
    finishedAt: '2026-07-27T00:01:00.000Z',
    termination: { kind: 'exited', exitCode: 0 },
    outputReferences: [],
    proposedCompletionPacket: {
      manifestHash: manifest.manifestHash,
      identity: { ...manifest.identity },
      revisions: { ...manifest.revisions },
      proposal: 'complete',
      summary: `${agent} proposed completion through the provider-neutral attempt contract.`,
      criterionEvidence: [],
    },
    observedFiles: [{ path: 'src/change.ts', changeType: 'modified', runtimeMetadata: false, observer: 'host' }],
    observedCommits: [],
    hostValidationObservations: [],
    knownIssues: [],
  });
  const scoped = {
    workspaceId: manifest.identity.workspaceId, specId: manifest.identity.specId,
    runId: manifest.identity.runId, storyId: manifest.identity.storyId,
    manifestHash: manifest.manifestHash, specRevision: manifest.revisions.specRevision,
    storyRevision: manifest.revisions.storyRevision,
  };
  const commit = {
    workspaceId: manifest.identity.workspaceId, specId: manifest.identity.specId,
    runId: manifest.identity.runId, storyId: manifest.identity.storyId,
    sha: SHA, branch: manifest.execution.worktree.branch!, message: 'story commit',
    author: 'rorca-execution-engine', committedAt: NOW, observedBy: 'worktree_branch' as const,
  };
  const closeout = evaluateStoryCloseout({
    manifest,
    attempt,
    host: {
      identity: { ...manifest.identity },
      activeSubjectRevision: { commitSha: SHA, worktreePath: manifest.execution.worktree.path!, branch: manifest.execution.worktree.branch! },
      repository: { worktreeClean: true, changedFiles: ['src/change.ts'], runtimeMetadataFiles: [], headBeforeValidation: SHA, headAfterValidation: SHA },
      validations: [], criterionEvidence: [], storyCommits: [commit],
      progress: { ...scoped, reportsComplete: true },
      storyResult: { ...scoped, status: 'pass' },
    },
  });
  expect(closeout.status).toBe('accepted');
  const validation = buildProviderNeutralCompletionValidation({
    runId: 42, workspaceId: 'workspace-1',
    story: { storyId: 'ROR-29', status: 'pass', resultProvenance: 'host', resultSource: 'execution-engine', integrated: true, commitSha: SHA },
    manifest, attempt, closeout,
  });
  expect(validation).toMatchObject({ status: 'validated', agent, closeoutDecisionId: closeout.decisionId });
  expect(validation).not.toHaveProperty('completionPacket');
});

test('rejects secret-bearing pause rationale before persistence', async () => {
  await expect(setCampaignDispatchPause({
    workspaceId: 'workspace-1', campaignId: 'campaign-1', paused: true,
    reason: 'pause Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
    actor: 'operator@example.com', idempotencyKey: 'pause-request-1',
  })).rejects.toThrow(/credential material/);
  expect(mockTransaction).not.toHaveBeenCalled();
});

test('serializable consumption binds a non-Pi manifest and application outbox exactly once', async () => {
  const auth = authorization();
  const state: FakeState = { insertCount: 0, walCount: 0 };
  const client = fakeClient(auth, state);
  mockTransaction.mockImplementation(async (callback: (value: typeof client) => unknown) => callback(client));
  const result = await prepareCampaignDispatchPublication({ authorization: auth, runId: 42, owner: 'owner-1', requestHash: REQUEST_HASH, effectiveOptionsHash: REQUEST_HASH, payload: { runId: 42 } });
  expect(result.consumption).toMatchObject({ state: 'consumed', runId: 42, authorizationHash: auth.authorizationHash });
  expect(result.consumption.execution).toEqual([expect.objectContaining({ agent: 'codex', attempt: 1, baseRevision: SHA })]);
  expect(state).toMatchObject({ insertCount: 1, walCount: 1 });
  expect(jest.mocked(client.query).mock.calls[0][0]).toContain('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
  const insert = jest.mocked(client.query).mock.calls.find((call) => String(call[0]).includes('INSERT INTO campaign_dispatch_authorizations'));
  expect(insert).toBeDefined();
  const insertParams = insert?.[1] as unknown as unknown[];
  const persistedSnapshot = JSON.parse(String(insertParams[22]));
  expect(persistedSnapshot).not.toHaveProperty('git.remoteUrl');
  expect(persistedSnapshot).not.toHaveProperty('git.root');
  expect(JSON.stringify(persistedSnapshot)).not.toContain('secret-token');
});

test.each([
  ['pause race', { paused: true }, /pause control/],
  ['arm revocation race', { revokedArm: true }, /arm authority/],
] as const)('fails closed when %s wins before consumption', async (_name, patch, expected) => {
  const auth = authorization();
  const state: FakeState = { insertCount: 0, walCount: 0, ...patch };
  const client = fakeClient(auth, state);
  mockTransaction.mockImplementation(async (callback: (value: typeof client) => unknown) => callback(client));
  await expect(prepareCampaignDispatchPublication({ authorization: auth, runId: 42, owner: 'owner-1', requestHash: REQUEST_HASH, effectiveOptionsHash: REQUEST_HASH, payload: { runId: 42 } })).rejects.toThrow(expected);
  expect(state.insertCount).toBe(0);
});

test('publisher and worker refuse a campaign-bound run without matching consumed authority', async () => {
  const client = {
    query: jest.fn(async (sqlValue: unknown) => {
      const sql = String(sqlValue).replace(/\s+/g, ' ');
      if (sql.includes('FROM pipeline_runs WHERE id = $1 FOR UPDATE')) {
        return { rows: [{
          workspace_id: 'workspace-1', status: 'queued', dispatch_request_hash: REQUEST_HASH,
          campaign_dispatch_authorization_hash: MANIFEST_HASH,
        }] };
      }
      if (sql.includes('FROM campaign_dispatch_authorizations')) {
        return { rows: [{ run_id: 42, request_hash: `sha256:${'e'.repeat(64)}` }] };
      }
      return { rows: [] };
    }),
  };
  mockTransaction.mockImplementation(async (callback: (value: typeof client) => unknown) => callback(client));

  await expect(claimDispatchPublication({
    runId: 42, workspaceId: 'workspace-1', expectedRequestHash: REQUEST_HASH,
  })).rejects.toThrow(/exact consumed/);
  await expect(claimDispatchForWorker({
    runId: 42, bossJobId: '22222222-2222-5222-a222-222222222222', payload: { runId: 42 }, workerId: 'worker-1',
  })).resolves.toEqual({ claimed: false, reason: 'campaign_authorization_mismatch', workspaceId: 'workspace-1' });
});

test('exact consumption replay is accepted while conflicting consumption is rejected', async () => {
  const auth = authorization();
  const exact = { authorization_hash: auth.authorizationHash, run_id: 42, request_hash: REQUEST_HASH, idempotency_key: auth.idempotencyKey, consumed_at: NOW, expires_at: EXPIRES, control_generation: 3, payload_snapshot: {} };
  let state: FakeState = { existing: exact, insertCount: 0, walCount: 0 };
  let client = fakeClient(auth, state);
  mockTransaction.mockImplementation(async (callback: (value: typeof client) => unknown) => callback(client));
  await expect(prepareCampaignDispatchPublication({ authorization: auth, runId: 42, owner: 'owner-1', requestHash: REQUEST_HASH, effectiveOptionsHash: REQUEST_HASH, payload: { runId: 42 } })).resolves.toMatchObject({ consumption: { runId: 42 } });
  expect(state).toMatchObject({ insertCount: 0, walCount: 0 });

  state = { existing: { ...exact, run_id: 43 }, insertCount: 0, walCount: 0 };
  client = fakeClient(auth, state);
  mockTransaction.mockImplementation(async (callback: (value: typeof client) => unknown) => callback(client));
  await expect(prepareCampaignDispatchPublication({ authorization: auth, runId: 42, owner: 'owner-1', requestHash: REQUEST_HASH, effectiveOptionsHash: REQUEST_HASH, payload: { runId: 42 } })).rejects.toThrow(/already consumed/);
});
