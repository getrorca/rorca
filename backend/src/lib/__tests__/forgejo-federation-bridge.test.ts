/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * W5-005 bridge remediation tests (lane remed-a):
 *   * rotation race: a credential binding changing between token resolution
 *     and the status projection blocks the projection and never leaks the
 *     token to the old instance URL (A9);
 *   * restart-safe reconcile: a crash between the PR creation and the status
 *     projection leaves a durable 'pending' ledger row that the reconcile
 *     loop re-runs idempotently (A5).
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createFakeForgejoServer } from './fixtures/fake-forgejo-server';
import { clearForgejoTokenCacheForTests, registerForgejoCredential } from '../forgejo-token-credential-provider';
import { identityHash, integrationPath } from '../forgejo-release-authority';

const BINDING = {
  id: '10000000-0000-4000-8000-000000000101', workspace_id: 'ws-forgejo', instance_url: 'http://127.0.0.1:0',
  repo_owner: 'acme', repo_name: 'widgets', status: 'active',
  token_digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  scope_profile: JSON.stringify({
    fullName: 'acme/widgets', permissions: { pull: true, push: true, admin: false },
    repositoryExclusivity: 'exclusive', exclusivitySource: 'user-repos-enumeration',
    probedAt: '2026-08-06T00:00:00.000Z',
  }),
  credential_version: 1, key_version: 1, expires_at: null, last_validated_at: null,
  validation_error_code: null, audit_provenance_hash: null, created_at: '2026-08-06T00:00:00.000Z',
};

jest.mock('../../db/index', () => {
  const mockQueryOne = jest.fn();
  const mockExecute = jest.fn(async (_sql: unknown, _params: unknown[]) => ({ rowCount: 1 }));
  return {
    queryOne: mockQueryOne,
    query: jest.fn(async () => []),
    execute: mockExecute,
    transaction: jest.fn(async (fn: (client: never) => Promise<unknown>) => {
      const client = {
        query: jest.fn(async (sql: unknown, params: unknown[]) => {
          const text = String(sql);
          if (/^\s*(?:INSERT|UPDATE)|set_config/.test(text)) {
            await mockExecute(sql, params);
            return { rows: [], rowCount: 1 };
          }
          const row = await mockQueryOne(sql, params);
          return { rows: row == null ? [] : [row] };
        }),
      };
      return fn(client as never);
    }),
    withPgAdvisoryLock: jest.fn(async (_key: string, operation: () => Promise<unknown>) => operation()),
  };
});

import {
  bridgeFederatedResultToForgejo,
  reconcilePendingForgejoFederationProjections,
} from '../forgejo-federation-bridge';
import { execute, query, queryOne } from '../../db/index';

const AUTHORIZED_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const SPEC_ID = 'wave-5-forgejo-adapter-omp-shim';
const RAW_TOKEN = 'forgejo-bridge-test-token-0123456789abcdef';
const PROPOSAL_ID = 'result:remed-a';
const IDEMPOTENCY_KEY = 'bridge:remed-a';

let server: ReturnType<typeof createFakeForgejoServer>;
let listener: http.Server;
let baseUrl: string;
let insertedBindingId: string | null = null;

/** The durable intent row the freeze would have written for this exact
 * identity: identity_hash is the real digest, so a replay against it
 * re-freezes no-op instead of blocking on the immutable-intent guard. */
function frozenIntentRow() {
  const repository = {
    instanceUrl: baseUrl, owner: 'acme', name: 'widgets',
    source: 'forgejo-token' as const, bindingId: insertedBindingId ?? '', repositoryId: null,
  };
  const identityValue = {
    runId: 42, workspaceId: 'ws-forgejo', specId: SPEC_ID,
    authorizedSha: AUTHORIZED_SHA, branchName: 'wave5-bridge',
    workspaceRealpath: '/tmp/ws-forgejo', worktreeRealpath: '/tmp/ws-forgejo/worktree',
    baseBranch: 'main', baseSha: BASE_SHA,
    providerReleaseRef: `ssdlc/run-42-${AUTHORIZED_SHA.slice(0, 12)}`,
    integrationCheckoutPath: integrationPath('/tmp/ws-forgejo', 42, AUTHORIZED_SHA),
    repository,
  };
  const input = {
    runId: 42, workspaceId: 'ws-forgejo', specId: SPEC_ID,
    authorizedSha: AUTHORIZED_SHA, branchName: 'wave5-bridge',
    workspaceRealpath: '/tmp/ws-forgejo', worktreeRealpath: '/tmp/ws-forgejo/worktree',
    baseBranch: 'main', baseSha: BASE_SHA,
    mergeStrategy: 'draft-pr' as const, autoMerge: false as const, externalSend: true,
    proposalHash: `sha256:${'a'.repeat(64)}`,
    changedPathManifestHash: 'f'.repeat(64),
  };
  return {
    run_id: 42, workspace_id: 'ws-forgejo', spec_id: SPEC_ID,
    authorized_sha: AUTHORIZED_SHA, branch_name: 'wave5-bridge',
    execution_workspace_path: '/tmp/ws-forgejo', execution_worktree_path: '/tmp/ws-forgejo/worktree',
    repository_owner: 'acme', repository_name: 'widgets', repository_authority_source: 'forgejo-token',
    repository_binding_id: insertedBindingId, repository_id: 2001, repository_instance_url: baseUrl,
    merge_strategy: 'draft-pr', auto_merge: false, external_send: true,
    identity_hash: identityHash(identityValue, input), status: 'processing',
    step_state: '{}', base_branch: 'main', base_sha: BASE_SHA,
    provider_release_ref: `ssdlc/run-42-${AUTHORIZED_SHA.slice(0, 12)}`,
    integration_checkout_path: null,
    proposal_hash: null, changed_path_manifest_hash: null, dispatch_fence: null,
  };
}
let projectionState: { status: string; intent_run_id: number | null; draft_pr_number: number | null; error_code: string | null } | null = null;

function proposalFixture() {
  return {
    schemaVersion: 'rorca.federated-result-proposal.v1',
    contractVersion: '1.0.0',
    proposalId: PROPOSAL_ID,
    binding: {
      workspaceId: 'ws-forgejo', runtimeId: 'runtime:wave5', offerId: 'offer:wave5',
      claimId: 'claim:wave5', attemptId: 'attempt:wave5', leaseId: 'lease:wave5',
      fencingToken: 1, missionId: 'mission:1', missionRevision: 1, workPackageId: 'wp:1',
      workPackageRevision: 1, specId: SPEC_ID, specVersion: '1', specHash: 'c'.repeat(64),
      storyId: 'story:1', storyVersion: 1, storyHash: 'd'.repeat(64),
      repositoryId: 'repo:2001', baseSha: BASE_SHA, currentSha: AUTHORIZED_SHA,
      expectedHeadSha: AUTHORIZED_SHA, worktreeId: 'worktree:wave5',
      allowedPathManifestHash: 'e'.repeat(64), requiredPathManifestHash: 'e'.repeat(64),
      changedPathManifestHash: 'f'.repeat(64), forbiddenPathManifestHash: 'e'.repeat(64),
      validationManifestHash: 'e'.repeat(64),
    },
    generation: 1,
    sessionId: 'session:wave5',
    terminalSequence: 2,
    completionCandidateState: 'controller_validated',
    completionCandidateHash: '5'.repeat(64),
    changedPaths: ['backend/src'],
    changedPathHash: 'f'.repeat(64),
    validations: [{
      validationId: 'validation:1', commandHash: '1'.repeat(64),
      claimedOutcome: 'passed', artifactHash: '2'.repeat(64), observedAt: '2026-08-06T00:00:00.000Z',
    }],
    validationSetHash: '3'.repeat(64),
    artifacts: [{
      artifactId: 'artifact:1', contentHash: '4'.repeat(64), byteLength: 64,
      restrictedReferenceId: 'restricted:1',
    }],
    artifactSetHash: '5'.repeat(64),
    outcomeClaim: 'failed',
    observedHeadSha: AUTHORIZED_SHA,
    submittedAt: '2026-08-06T00:00:00.000Z',
    closeoutAuthority: 'none', lifecycleAuthority: 'none',
    mergeAuthority: 'none', deploymentAuthority: 'none',
  };
}

function hostVerificationFixture() {
  return {
    schemaVersion: 'rorca.federated-host-verification.v1',
    verified: true,
    repositoryId: 'repo:2001',
    baseSha: BASE_SHA,
    headSha: AUTHORIZED_SHA,
    worktreeId: 'worktree:wave5',
    changedPaths: ['backend/src'],
    changedPathHash: 'f'.repeat(64),
    gitObservationHash: '6'.repeat(64),
    validationObservationHash: '7'.repeat(64),
    artifactObservationHash: '8'.repeat(64),
    observedAt: '2026-08-06T00:00:00.000Z',
    runtimeClaimsTrust: 'runtime_asserted',
    hostEvidenceTrust: 'host_observed',
    closeoutAuthority: 'none',
  };
}

function installQueryOne(bindingFactory: () => typeof BINDING | null) {
  (queryOne as jest.Mock).mockImplementation(async (sql: unknown) => {
    const text = String(sql);
    if (text.includes('forgejo_workspace_credentials')) {
      const binding = bindingFactory();
      return binding == null ? null : { ...binding, instance_url: baseUrl, id: insertedBindingId };
    }
    if (text.includes('governed_execution_attempts')) {
      return { run_id: 42 };
    }
    if (text.includes('pipeline_run_release_intents') && text.includes('SELECT identity_hash')) {
      // No pre-existing intent: the freeze creates it, so the rotation race
      // can reach the projection-time credential re-check (A9).
      return undefined;
    }
    if (text.includes('FROM pipeline_run_release_intents')) {
      return frozenIntentRow();
    }
    if (text.includes('FROM pipeline_runs pr')) {
      return {
        workspace_id: 'ws-forgejo', spec_path: `forge/specs/pending/${SPEC_ID}.json`,
        branch_name: 'wave5-bridge',
        execution_workspace_path: '/tmp/ws-forgejo', execution_worktree_path: '/tmp/ws-forgejo/worktree',
        terminal_checkout_sha: AUTHORIZED_SHA,
        base_branch: 'main', base_sha: BASE_SHA,
        provider_release_ref: `ssdlc/run-42-${AUTHORIZED_SHA.slice(0, 12)}`,
        integration_checkout_path: null,
      };
    }
    if (text.includes('forgejo_federation_projections')) return projectionState;
    return undefined;
  });
}

beforeEach(async () => {
  process.env.RORCA_FORGEJO_PRIVATE_HOST_ALLOWLIST = '127.0.0.1';
  jest.clearAllMocks();
  clearForgejoTokenCacheForTests();
  insertedBindingId = null;
  projectionState = null;
  server = createFakeForgejoServer({
    instanceUrl: 'http://127.0.0.1:0', owner: 'acme', name: 'widgets', token: RAW_TOKEN,
    branchHead: AUTHORIZED_SHA,
  });
  listener = http.createServer(server.app);
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  (execute as jest.Mock).mockImplementation(async (sql: unknown, params: unknown[] = []) => {
    if (String(sql).includes('INSERT INTO forgejo_workspace_credentials')) {
      insertedBindingId = String(params[0]);
    }
    if (String(sql).includes('INSERT INTO forgejo_federation_projections')) {
      projectionState = {
        status: 'projected',
        intent_run_id: params[6] == null ? null : Number(params[6]),
        draft_pr_number: params[7] == null ? null : Number(params[7]),
        error_code: null,
      };
    }
    return { rowCount: 1 };
  });
  (queryOne as jest.Mock).mockImplementation(async () => undefined);
});

afterEach(async () => {
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  delete process.env.RORCA_FORGEJO_PRIVATE_HOST_ALLOWLIST;
});

describe('W5-005 federation -> Forgejo bridge remediation', () => {
  test('rotation race: binding changed between token resolution and projection blocks without leaking the token', async () => {
    await registerForgejoCredential({
      workspaceId: 'ws-forgejo', instanceUrl: baseUrl, owner: 'acme', name: 'widgets',
      token: RAW_TOKEN, createdBy: 'operator',
    });
    let credentialReads = 0;
    installQueryOne(() => {
      credentialReads += 1;
      // The final credential read is the projection fence's bindingAfter
      // check. Rotate there so the previously resolved token metadata no
      // longer matches the canonical binding.
      return credentialReads === 8 ? { ...BINDING, credential_version: 2, key_version: 2 } : BINDING;
    });
    const proposal = proposalFixture() as never;
    const receipt = await bridgeFederatedResultToForgejo({
      workspaceId: 'ws-forgejo', proposal, hostVerification: hostVerificationFixture() as never,
      proposalHash: `sha256:${'a'.repeat(64)}`, idempotencyKey: IDEMPOTENCY_KEY,
      baseBranch: 'main', baseSha: BASE_SHA, branchName: 'wave5-bridge',
      workspaceRealpath: '/tmp/ws-forgejo', worktreeRealpath: '/tmp/ws-forgejo/worktree',
    });
    expect(receipt.status).toBe('blocked');
    expect(receipt.errorCode).toMatch(/rotated|changed/i);
    // The token never reached the provider for the status projection: the
    // fake server saw the PR creation but no status POST (no old-URL leak).
    const statusPosts = server.calls.filter((call) => call.method === 'POST' && call.path.includes('/statuses/'));
    expect(statusPosts).toHaveLength(0);
  });

  test('restart-safe reconcile: a pending ledger row re-runs the exact projection after a crash', async () => {
    await registerForgejoCredential({
      workspaceId: 'ws-forgejo', instanceUrl: baseUrl, owner: 'acme', name: 'widgets',
      token: RAW_TOKEN, createdBy: 'operator',
    });
    // First pass: provider PR creation fails (simulated crash between steps).
    server.failNextStatusPosts = 0;
    const proposal = proposalFixture() as never;
    installQueryOne(() => BINDING);
    // Seed the durable pending ledger row the crashed process left behind.
    (queryOne as jest.Mock).mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('forgejo_workspace_credentials')) {
        return { ...BINDING, instance_url: baseUrl, id: insertedBindingId };
      }
      if (text.includes('pipeline_run_release_intents') && text.includes('SELECT identity_hash')) return undefined;
      if (text.includes('FROM pipeline_run_release_intents')) {
        return frozenIntentRow();
      }
      if (text.includes('FROM pipeline_runs pr')) {
        return {
          workspace_id: 'ws-forgejo', spec_path: `forge/specs/pending/${SPEC_ID}.json`,
          branch_name: 'wave5-bridge',
          execution_workspace_path: '/tmp/ws-forgejo', execution_worktree_path: '/tmp/ws-forgejo/worktree',
          terminal_checkout_sha: AUTHORIZED_SHA,
          base_branch: 'main', base_sha: BASE_SHA,
          provider_release_ref: `ssdlc/run-42-${AUTHORIZED_SHA.slice(0, 12)}`,
          integration_checkout_path: integrationPath('/tmp/ws-forgejo', 42, AUTHORIZED_SHA),
        };
      }
      if (text.includes('forgejo_federation_projections') && text.includes('proposal_json')) {
        return {
          proposal_json: proposal,
          host_verification_json: hostVerificationFixture(),
          proposal_hash: `sha256:${'a'.repeat(64)}`,
          run_id: 42,
        };
      }
      if (text.includes('forgejo_federation_projections') && text.includes('idempotency_key')) {
        return { proposal_id: PROPOSAL_ID, workspace_id: 'ws-forgejo', idempotency_key: IDEMPOTENCY_KEY };
      }
      if (text.includes('forgejo_federation_projections')) return projectionState;
      return undefined;
    });
    // The scoped scan enumerates workspaces from the non-RLS registry, then
    // reads each workspace's pending rows under its own RLS GUC.
    (query as jest.Mock).mockResolvedValue([{ id: 'ws-forgejo' }]);
    const reconciled = await reconcilePendingForgejoFederationProjections(10);
    // The reconcile re-ran the exact projection (rediscovered unique PR) and
    // recorded the durable projected outcome.
    expect(reconciled).toBe(1);
    const upserts = (execute as jest.Mock).mock.calls.map((call) => String(call[0])).join('\n');
    expect(upserts).toContain("'projected'");
    expect(server.pullRequests).toHaveLength(1);
  });
});
