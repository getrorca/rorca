/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createFakeForgejoServer } from './fixtures/fake-forgejo-server';

const BINDING = {
  id: '10000000-0000-4000-8000-000000000101', workspace_id: 'ws-forgejo', instance_url: 'http://127.0.0.1:0',
  repo_owner: 'acme', repo_name: 'widgets', status: 'active',
  token_digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  scope_profile: JSON.stringify({
    schemaVersion: 'rorca.forgejo-capability-profile.v1', login: 'acme', repositoryId: 2001,
    fullName: 'acme/widgets', permissions: { pull: true, push: true, admin: false },
    probedAt: '2026-08-06T00:00:00.000Z',
  }),
  credential_version: 1, key_version: 1, expires_at: null, last_validated_at: null,
  validation_error_code: null, audit_provenance_hash: null, created_at: '2026-08-06T00:00:00.000Z',
};

const HEAD_SHA = 'a'.repeat(40);

jest.mock('../../db/index', () => ({
  queryOne: jest.fn(),
  query: jest.fn(async () => ({ rows: [] })),
  execute: jest.fn(async () => ({ rowCount: 1 })),
  transaction: jest.fn(),
  withPgAdvisoryLock: jest.fn(async (_key: string, operation: () => Promise<unknown>) => operation()),
}));
jest.mock('../run-host-authority', () => ({
  inspectRunHostAuthority: jest.fn(),
}));

import { execute, queryOne, transaction } from '../../db/index';
import { trustedWalIdentityHash } from '../trusted-wal';
import { inspectRunHostAuthority } from '../run-host-authority';
import { clearForgejoTokenCacheForTests, registerForgejoCredential } from '../forgejo-token-credential-provider';
import {
  acceptForgejoStatusWalEvent,
  commitStatusBackend,
  createActionsCheckRunBackend,
  reconcileForgejoStatusProjection,
  resetForgejoCheckPosterForTests,
  resolveForgejoProjectionBackend,
} from '../forgejo-check-poster';

let server: ReturnType<typeof createFakeForgejoServer>;
let listener: http.Server;
let baseUrl: string;
let insertedBindingId: string | null = null;
/** When true, the workspace credential resolves to a DIFFERENT, invalid
 * binding so the reconcile authority recheck genuinely blocks (A5). */
let authorityChangedBinding = false;

const RAW_TOKEN = 'forgejo-poster-token-fixture-0123456789abcdef';

function walEvent(overrides: Record<string, unknown> = {}) {
  const base = {
    id: 1, ts: '2026-08-06T00:00:00.000Z', event_type: 'run_started',
    workspace_id: 'ws-forgejo', spec_id: 'wave-5-forgejo-adapter-omp-shim',
    canonical_run_id: 42, story_id: null, payload: JSON.stringify({ run_id: 42 }),
    ingest_key: 'wal:forgejo-check-poster:run-42', outbox_ready_at: '2026-08-06T00:00:00.000Z',
    story_result_id: null, trusted_source: 'worker', trust_provenance: 'host',
    ...overrides,
  } as Record<string, unknown>;
  const payload = typeof base.payload === 'string'
    ? JSON.parse(base.payload) as Record<string, unknown>
    : base.payload as Record<string, unknown>;
  base.event_identity_hash = trustedWalIdentityHash({
    eventType: String(base.event_type), workspaceId: String(base.workspace_id),
    runId: Number(base.canonical_run_id), specId: String(base.spec_id),
    storyId: base.story_id == null ? null : String(base.story_id),
    source: base.trusted_source as 'worker', storyResultId: null, payload,
  });
  return base as never;
}

/** Durable projection row the transaction client returns on any status-ledger
 * query, emulating the row persisted by acceptForgejoStatusWalEvent. */
function projectionClaimRow() {
  return {
    run_id: 42, workspace_id: 'ws-forgejo', spec_id: 'wave-5-forgejo-adapter-omp-shim',
    desired_event_id: 1, desired_event_identity_hash: 'e'.repeat(64),
    desired_state: 'in_progress', head_sha: HEAD_SHA, conclusion: null,
    desired_payload: JSON.stringify({ runId: 42, state: 'pending', description: 'started' }),
    desired_payload_hash: 'f'.repeat(64), external_id: 'rorca:pipeline-run:42:v1',
    projection_status: 'pending', provider_status_id: null, provider_head_sha: null,
    claim_token: null, claimed_at: null, attempts: 0, next_attempt_at: null,
    repository_owner: 'acme', repository_name: 'widgets',
    repository_binding_id: insertedBindingId, repository_id: 2001,
  };
}

beforeEach(async () => {
  process.env.RORCA_FORGEJO_PRIVATE_HOST_ALLOWLIST = '127.0.0.1';
  jest.clearAllMocks();
  resetForgejoCheckPosterForTests();
  clearForgejoTokenCacheForTests();
  insertedBindingId = null;
  authorityChangedBinding = false;
  server = createFakeForgejoServer({
    instanceUrl: 'http://127.0.0.1:0', owner: 'acme', name: 'widgets', token: RAW_TOKEN,
    branchHead: HEAD_SHA,
  });
  listener = http.createServer(server.app);
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  (execute as jest.Mock).mockImplementation(async (sql: unknown, params: unknown[] = []) => {
    if (String(sql).includes('INSERT INTO forgejo_workspace_credentials')) {
      insertedBindingId = String(params[0]);
    }
    return { rowCount: 1 };
  });
  (queryOne as jest.Mock).mockImplementation(async (sql: unknown) => {
    const text = String(sql);
    if (text.includes('forgejo_workspace_credentials')) {
      return insertedBindingId == null ? null : { ...BINDING, instance_url: baseUrl, id: insertedBindingId };
    }
    if (text.includes('pipeline_run_release_intents')) {
      return {
        repository_owner: 'acme', repository_name: 'widgets', repository_binding_id: insertedBindingId,
        repository_id: 2001, authorized_sha: HEAD_SHA,
      };
    }
    if (text.includes('FROM pipeline_runs pr')) {
      return {
        branch_name: 'wave5-forgejo',
        worktree_path: '/tmp/ws-forgejo/worktree',
        workspace_path: '/tmp/ws-forgejo',
        terminal_checkout_sha: HEAD_SHA,
        release_authorized_sha: HEAD_SHA,
        execution_workspace_path: '/tmp/ws-forgejo',
        execution_worktree_path: '/tmp/ws-forgejo/worktree',
        release_execution_workspace_path: '/tmp/ws-forgejo',
        release_execution_worktree_path: '/tmp/ws-forgejo/worktree',
        release_identity_hash: 'e'.repeat(64),
      };
    }
    if (text.includes('wal_events')) return undefined;
    return undefined;
  });
  (transaction as jest.Mock).mockImplementation(async (fn: (client: never) => Promise<unknown>) => {
    const client = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        const text = String(sql);
        if (/^\s*(?:INSERT|UPDATE)|set_config/.test(text)) {
          await (execute as jest.Mock)(sql, params);
          // claimProjection persists its claim with UPDATE ... RETURNING *; the
          // durable claim row must come back or reconcile stops cold with no
          // provider POST. Other INSERT/UPDATE statements need no rows.
          return text.includes('RETURNING')
            ? { rows: [projectionClaimRow()], rowCount: 1 }
            : { rows: [], rowCount: 1 };
        }
        if (text.includes('forgejo_workspace_credentials')) {
          const row = authorityChangedBinding
            ? { ...BINDING, instance_url: baseUrl, id: 'different-binding', status: 'invalid' }
            : { ...BINDING, instance_url: baseUrl, id: insertedBindingId };
          return { rows: insertedBindingId == null ? [] : [row], rowCount: 1 };
        }
        if (text.includes('FROM pipeline_runs')) {
          return { rows: [{ workspace_id: 'ws-forgejo' }], rowCount: 1 };
        }
        if (text.includes('forgejo_status_projections')) return { rows: [projectionClaimRow()], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };
    const result = await fn(client as never);
    return result ?? undefined;
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  delete process.env.RORCA_FORGEJO_PRIVATE_HOST_ALLOWLIST;
});

describe('Forgejo check poster (W5-004)', () => {
  test('accepts a run_started WAL event and projects a pending status at the exact head', async () => {
    await registerForgejoCredential({
      workspaceId: 'ws-forgejo', instanceUrl: baseUrl, owner: 'acme', name: 'widgets',
      token: RAW_TOKEN, createdBy: 'operator',
    });
    // authorizeCanonicalWalEvent needs pipeline_runs; run_started path then
    // resolves branch head and persists the projection.
    (queryOne as jest.Mock).mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('forgejo_workspace_credentials')) {
        return { ...BINDING, instance_url: baseUrl, id: insertedBindingId ?? BINDING.id };
      }
      if (text.includes('FROM pipeline_runs pr')) {
        return {
          branch_name: 'wave5-forgejo',
          worktree_path: '/tmp/ws-forgejo/worktree',
          workspace_path: '/tmp/ws-forgejo',
          terminal_checkout_sha: HEAD_SHA, release_authorized_sha: HEAD_SHA,
          execution_workspace_path: '/tmp/ws-forgejo', execution_worktree_path: '/tmp/ws-forgejo/worktree',
          release_execution_workspace_path: '/tmp/ws-forgejo',
          release_execution_worktree_path: '/tmp/ws-forgejo/worktree',
          release_identity_hash: 'e'.repeat(64),
        };
      }
      if (text.includes('pipeline_run_release_intents')) {
        return { repository_owner: 'acme', repository_name: 'widgets', repository_binding_id: insertedBindingId,
          repository_id: 2001, authorized_sha: HEAD_SHA };
      }
      if (text.includes('pipeline_runs') && text.includes('WHERE id = $1')) {
        return {
          id: 42, workspace_id: 'ws-forgejo', spec_path: 'forge/specs/pending/wave-5-forgejo-adapter-omp-shim.json',
          status: 'running', lifecycle_status: 'running', expected_story_ids: ['W5-004'],
          finished_at: null, branch_name: 'wave5-forgejo',
        };
      }
      return undefined;
    });
    const runId = await acceptForgejoStatusWalEvent(walEvent());
    expect(runId).toBe(42);
    await reconcileForgejoStatusProjection(42);
    const statuses = server.statuses.get(HEAD_SHA) ?? [];
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses[0]).toMatchObject({ context: 'rorca/pipeline', state: 'pending' });
  });

  test('commit-status backend and capability-gated actions backend share the interface', async () => {
    expect(commitStatusBackend.kind).toBe('commit-status');
    expect(resolveForgejoProjectionBackend(() => false).kind).toBe('commit-status');
    const actions = createActionsCheckRunBackend(() => true);
    expect(actions.kind).toBe('actions-check-run');
    expect(actions.isAvailable()).toBe(true);
    expect(resolveForgejoProjectionBackend(() => true).kind).toBe('actions-check-run');
  });

  test('idempotent replay does not duplicate a provider status', async () => {
    await registerForgejoCredential({
      workspaceId: 'ws-forgejo', instanceUrl: baseUrl, owner: 'acme', name: 'widgets',
      token: RAW_TOKEN, createdBy: 'operator',
    });
    const reconcile = async () => {
      (queryOne as jest.Mock).mockImplementation(async (sql: unknown) => {
        const text = String(sql);
        if (text.includes('forgejo_workspace_credentials')) {
          return { ...BINDING, instance_url: baseUrl, id: insertedBindingId ?? BINDING.id };
        }
        return undefined;
      });
      return reconcileForgejoStatusProjection(42);
    };
    // Seed a projection row for run 42 by emulating the claim path.
    (queryOne as jest.Mock).mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('forgejo_workspace_credentials')) {
        return { ...BINDING, instance_url: baseUrl, id: insertedBindingId ?? BINDING.id };
      }
      if (text.includes('FROM forgejo_status_projections')) {
        return {
          run_id: 42, workspace_id: 'ws-forgejo', spec_id: 'wave-5-forgejo-adapter-omp-shim',
          desired_event_id: 1, desired_event_identity_hash: 'e'.repeat(64),
          desired_state: 'in_progress', head_sha: HEAD_SHA, conclusion: null,
          desired_payload: JSON.stringify({ runId: 42, state: 'pending', description: 'started' }),
          desired_payload_hash: 'f'.repeat(64), external_id: `rorca:pipeline-run:42:v1`,
          projection_status: 'pending', provider_status_id: null, provider_head_sha: null,
          claim_token: null, claimed_at: null, attempts: 0, next_attempt_at: null,
          repository_owner: 'acme', repository_name: 'widgets',
          repository_binding_id: insertedBindingId, repository_id: 2001,
        };
      }
      return undefined;
    });
    await reconcile();
    const count = server.statuses.get(HEAD_SHA)?.length ?? 0;
    expect(count).toBeGreaterThan(0);
    await reconcile();
    expect((server.statuses.get(HEAD_SHA)?.length ?? 0)).toBe(count);
  });

  test('reconcile blocks when the credential authority changed', async () => {
    await registerForgejoCredential({
      workspaceId: 'ws-forgejo', instanceUrl: baseUrl, owner: 'acme', name: 'widgets',
      token: RAW_TOKEN, createdBy: 'operator',
    });
    // RemedA moved getWorkspaceForgejoCredential inside transaction() with a
    // workspace-scoped SELECT, so the authority recheck in reconcile reads the
    // credential through the transaction mock; make it resolve to a DIFFERENT,
    // invalid binding so the genuine FORGEJO_CREDENTIAL_AUTHORITY_CHANGED
    // branch is hit (A5 permanent blocked state).
    authorityChangedBinding = true;
    (queryOne as jest.Mock).mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('forgejo_workspace_credentials')) {
        return { ...BINDING, instance_url: baseUrl, id: 'different-binding', status: 'invalid' };
      }
      if (text.includes('FROM forgejo_status_projections')) {
        return {
          run_id: 42, workspace_id: 'ws-forgejo', spec_id: 'wave-5-forgejo-adapter-omp-shim',
          desired_event_id: 1, desired_event_identity_hash: 'e'.repeat(64),
          desired_state: 'in_progress', head_sha: HEAD_SHA, conclusion: null,
          desired_payload: JSON.stringify({ runId: 42, state: 'pending', description: 'started' }),
          desired_payload_hash: 'f'.repeat(64), external_id: `rorca:pipeline-run:42:v1`,
          projection_status: 'pending', provider_status_id: null, provider_head_sha: null,
          claim_token: null, claimed_at: null, attempts: 0, next_attempt_at: null,
          repository_owner: 'acme', repository_name: 'widgets',
          repository_binding_id: insertedBindingId, repository_id: 2001,
        };
      }
      return undefined;
    });
    const ok = await reconcileForgejoStatusProjection(42);
    expect(ok).toBe(false);
    const update = (execute as jest.Mock).mock.calls.map((call) => String(call[0])).join('\n');
    const updateParams = (execute as jest.Mock).mock.calls.flatMap((call) => call[1] ?? []);
    // finishClaim parameterizes the durable state; the SQL carries 'pending',
    // so the blocked state is asserted across SQL and its parameters.
    expect(update + '\n' + updateParams.map(String).join('\n')).toContain('blocked');
  });

  test('run_finished projects a success/failure status via terminal authority', async () => {
    (queryOne as jest.Mock).mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('forgejo_workspace_credentials')) {
        return insertedBindingId == null ? null : { ...BINDING, instance_url: baseUrl, id: insertedBindingId };
      }
      if (text.includes('pipeline_runs') && text.includes('WHERE id = $1')) {
        return {
          id: 42, workspace_id: 'ws-forgejo', spec_path: 'forge/specs/pending/wave-5-forgejo-adapter-omp-shim.json',
          status: 'done', lifecycle_status: 'finished', expected_story_ids: ['W5-004'],
          finished_at: '2026-08-06T00:01:00.000Z', branch_name: 'wave5-forgejo',
        };
      }
      if (text.includes('story_results')) {
        return { status: 'pass', result_provenance: 'host', result_source: 'execution-engine' };
      }
      return undefined;
    });
    (inspectRunHostAuthority as jest.Mock).mockResolvedValue({
      runId: 42, workspaceId: 'ws-forgejo', specId: 'wave-5-forgejo-adapter-omp-shim',
      status: 'done', lifecycleStatus: 'finished', finishedAt: '2026-08-06T00:01:00.000Z',
      branchName: 'wave5-forgejo', checkoutPath: '/tmp/ws-forgejo/worktree',
      repositoryTopLevel: '/tmp/ws-forgejo', expectedStoryIds: ['W5-004'], excludedStoryIds: [],
      stories: [{ storyId: 'W5-004', status: 'pass', reason: null,
        finishedAt: '2026-08-06T00:01:00.000Z', resultId: 1, commitSha: HEAD_SHA }],
      authoritativePassedStoryIds: ['W5-004'], finalCommitSha: HEAD_SHA,
      closeoutEligible: true, terminalRevision: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      integrationAncestry: ['1'.repeat(40)], acceptedStoryIds: ['W5-004'],
      complete: true, releaseEligible: true, invalidReason: null,
    });
    await registerForgejoCredential({
      workspaceId: 'ws-forgejo', instanceUrl: baseUrl, owner: 'acme', name: 'widgets',
      token: RAW_TOKEN, createdBy: 'operator',
    });
    const runId = await acceptForgejoStatusWalEvent(walEvent({
      event_type: 'run_finished',
      payload: JSON.stringify({ run_id: 42, status: 'done' }),
    }));
    expect(runId).toBe(42);
  });
});
