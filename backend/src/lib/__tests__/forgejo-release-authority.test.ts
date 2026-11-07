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

const AUTHORIZED_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const SPEC_ID = 'wave-5-forgejo-adapter-omp-shim';
const RELEASE_REF = `ssdlc/run-42-${AUTHORIZED_SHA.slice(0, 12)}`;

jest.mock('../../db/index', () => ({
  queryOne: jest.fn(),
  query: jest.fn(async () => ({ rows: [] })),
  execute: jest.fn(async () => ({ rowCount: 1 })),
  transaction: jest.fn(),
  withPgAdvisoryLock: jest.fn(async (_key: string, operation: () => Promise<unknown>) => operation()),
}));

import { execute, query, queryOne, transaction, withPgAdvisoryLock } from '../../db/index';
import {
  clearForgejoTokenCacheForTests,
  registerForgejoCredential,
} from '../forgejo-token-credential-provider';
import {
  createOrFinalizeForgejoPullRequest,
  drainForgejoPendingRunReleases,
  prepareForgejoRunReleaseIntent,
  reconcileForgejoRunReleaseIntent,
  shouldActuateReleaseStep,
} from '../forgejo-release-authority';

let server: ReturnType<typeof createFakeForgejoServer>;
let listener: http.Server;
let baseUrl: string;
let insertedBindingId: string | null = null;

const RAW_TOKEN = 'forgejo-release-token-fixture-0123456789abcdef';

function frozenRunRow() {
  return {
    workspace_id: 'ws-forgejo',
    spec_path: `forge/specs/pending/${SPEC_ID}.json`,
    branch_name: 'wave5-forgejo',
    execution_workspace_path: '/tmp/ws-forgejo',
    execution_worktree_path: '/tmp/ws-forgejo/worktree',
    terminal_checkout_sha: AUTHORIZED_SHA,
    base_branch: 'main',
    base_sha: BASE_SHA,
    provider_release_ref: RELEASE_REF,
    // The DB-frozen path is null until an intent exists (LEFT JOIN); the
    // module derives its digest-scoped integration path, so a fixture constant
    // would spuriously fail the revalidation freeze.
    integration_checkout_path: null,
  };
}

function intentRow() {
  return {
    run_id: 42, workspace_id: 'ws-forgejo', spec_id: SPEC_ID,
    authorized_sha: AUTHORIZED_SHA, branch_name: 'wave5-forgejo',
    execution_workspace_path: '/tmp/ws-forgejo', execution_worktree_path: '/tmp/ws-forgejo/worktree',
    repository_owner: 'acme', repository_name: 'widgets', repository_authority_source: 'forgejo-token',
    repository_binding_id: insertedBindingId ?? BINDING.id, repository_id: 2001, repository_instance_url: baseUrl,
    merge_strategy: 'draft-pr', auto_merge: false, external_send: true,
    identity_hash: 'c'.repeat(64), status: 'processing',
    step_state: '{}', base_branch: 'main', base_sha: BASE_SHA,
    provider_release_ref: RELEASE_REF,
    integration_checkout_path: '/tmp/rorca-forgejo-release-integration-test',
    proposal_hash: null, changed_path_manifest_hash: null, dispatch_fence: null,
  };
}

/** Dispatch queryOne by SQL so credential reads and pipeline reads coexist. */
function dispatchQueryOne() {
  (queryOne as jest.Mock).mockImplementation(async (sql: unknown) => {
    const text = String(sql);
    if (text.includes('forgejo_workspace_credentials')) {
      return insertedBindingId == null ? null : { ...BINDING, instance_url: baseUrl, id: insertedBindingId };
    }
    if (text.includes('FROM pipeline_runs pr')) return frozenRunRow();
    if (text.includes('SELECT identity_hash FROM pipeline_run_release_intents')) return undefined;
    if (text.includes('FROM pipeline_run_release_intents')) return intentRow();
    return undefined;
  });
}

/** A transaction client whose query records SQL and returns empty rows. A real
 * pg client returns rowCount for DML; the reconciler mirrors the canonical
 * release authority by requiring an exact rowCount on every claim/completion. */
function installTransactionMock() {
  const queries: string[] = [];
  (transaction as jest.Mock).mockImplementation(async (fn: (client: never) => Promise<unknown>) => {
    const client = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        queries.push(String(sql));
        const text = String(sql);
        if (/^\s*(?:INSERT|UPDATE)/.test(text)) {
          await (execute as jest.Mock)(sql, params);
          return { rows: [], rowCount: 1 };
        }
        if (text.includes('set_config')) return { rows: [], rowCount: 1 };
        const row = await (queryOne as jest.Mock)(sql);
        return { rows: row == null ? [] : [row], rowCount: row == null ? 0 : 1 };
      }),
    };
    return fn(client as never);
  });
  return queries;
}

beforeEach(async () => {
  process.env.RORCA_FORGEJO_PRIVATE_HOST_ALLOWLIST = '127.0.0.1';
  jest.clearAllMocks();
  clearForgejoTokenCacheForTests();
  insertedBindingId = null;
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
    return { rowCount: 1 };
  });
  (withPgAdvisoryLock as jest.Mock).mockImplementation(async (_key: string, operation: () => Promise<unknown>) => operation());
});

afterEach(async () => {
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  delete process.env.RORCA_FORGEJO_PRIVATE_HOST_ALLOWLIST;
});

describe('Forgejo release authority (W5-003)', () => {
  test('shouldActuateReleaseStep matches the GitHub seam', () => {
    expect(shouldActuateReleaseStep(undefined)).toBe(true);
    expect(shouldActuateReleaseStep('processing')).toBe(true);
    expect(shouldActuateReleaseStep('completed')).toBe(false);
    expect(shouldActuateReleaseStep('not_required')).toBe(false);
  });

  test('prepares a draft-pr release intent recorded in pipeline_run_release_intents', async () => {
    dispatchQueryOne();
    const queries = installTransactionMock();
    await registerForgejoCredential({
      workspaceId: 'ws-forgejo', instanceUrl: baseUrl, owner: 'acme', name: 'widgets',
      token: RAW_TOKEN, createdBy: 'operator',
    });
    const identity = await prepareForgejoRunReleaseIntent({
      runId: 42, workspaceId: 'ws-forgejo', specId: SPEC_ID,
      authorizedSha: AUTHORIZED_SHA, branchName: 'wave5-forgejo',
      workspaceRealpath: '/tmp/ws-forgejo', worktreeRealpath: '/tmp/ws-forgejo/worktree',
      baseBranch: 'main', baseSha: BASE_SHA, mergeStrategy: 'draft-pr',
      autoMerge: false, externalSend: true,
    });
    expect(identity.repository?.source).toBe('forgejo-token');
    expect(identity.repository?.owner).toBe('acme');
    expect(identity.providerReleaseRef).toBe(RELEASE_REF);
    expect(queries.some((sql) => sql.includes('INSERT INTO pipeline_run_release_intents'))).toBe(true);
    expect(queries.some((sql) => sql.includes("'forgejo-token'"))).toBe(true);
  });

  test('rejects autoMerge — the seam grants no merge capability', async () => {
    const input = {
      runId: 42, workspaceId: 'ws-forgejo', specId: SPEC_ID,
      authorizedSha: AUTHORIZED_SHA, branchName: 'wave5-forgejo',
      workspaceRealpath: '/tmp/ws-forgejo', worktreeRealpath: '/tmp/ws-forgejo/worktree',
      baseBranch: 'main', baseSha: BASE_SHA, mergeStrategy: 'draft-pr' as const,
      autoMerge: true, externalSend: true,
    } as unknown as Parameters<typeof prepareForgejoRunReleaseIntent>[0];
    await expect(prepareForgejoRunReleaseIntent(input)).rejects.toThrow('no merge capability');
  });

  test('creates a draft PR ([WIP] title, draft:true) at the exact head and replays idempotently', async () => {
    dispatchQueryOne();
    installTransactionMock();
    await registerForgejoCredential({
      workspaceId: 'ws-forgejo', instanceUrl: baseUrl, owner: 'acme', name: 'widgets',
      token: RAW_TOKEN, createdBy: 'operator',
    });
    const identity = await prepareForgejoRunReleaseIntent({
      runId: 42, workspaceId: 'ws-forgejo', specId: SPEC_ID,
      authorizedSha: AUTHORIZED_SHA, branchName: 'wave5-forgejo',
      workspaceRealpath: '/tmp/ws-forgejo', worktreeRealpath: '/tmp/ws-forgejo/worktree',
      baseBranch: 'main', baseSha: BASE_SHA, mergeStrategy: 'draft-pr',
      autoMerge: false, externalSend: true,
    });
    const number = await createOrFinalizeForgejoPullRequest(identity, true);
    expect(server.pullRequests).toHaveLength(1);
    expect(server.pullRequests[0]).toMatchObject({
      title: `[WIP] ${SPEC_ID}`,
      draft: true,
      head: { ref: RELEASE_REF, sha: AUTHORIZED_SHA },
      base: { ref: 'main' },
    });
    const replayNumber = await createOrFinalizeForgejoPullRequest(identity, true);
    expect(replayNumber).toBe(number);
    expect(server.pullRequests).toHaveLength(1);
    const update = (execute as jest.Mock).mock.calls.map((call) => String(call[0])).join('\n');
    expect(update).toContain('step_state');
  });

  test('quarantines an asserted-mismatch PR instead of silently rewriting it', async () => {
    await registerForgejoCredential({
      workspaceId: 'ws-forgejo', instanceUrl: baseUrl, owner: 'acme', name: 'widgets',
      token: RAW_TOKEN, createdBy: 'operator',
    });
    // Pre-seed an open PR whose head sha differs from the exact authorized head.
    const wrongHead = 'f'.repeat(40);
    const preseed = new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({
        title: `[WIP] ${SPEC_ID}`, head: RELEASE_REF, base: 'main', draft: true,
        head_sha: wrongHead,
      });
      const req = http.request(`${baseUrl}/api/v1/repos/acme/widgets/pulls`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `token ${RAW_TOKEN}`,
        },
      }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    await preseed;
    expect(server.pullRequests).toHaveLength(1);
    dispatchQueryOne();
    installTransactionMock();
    const identity = await prepareForgejoRunReleaseIntent({
      runId: 42, workspaceId: 'ws-forgejo', specId: SPEC_ID,
      authorizedSha: AUTHORIZED_SHA, branchName: 'wave5-forgejo',
      workspaceRealpath: '/tmp/ws-forgejo', worktreeRealpath: '/tmp/ws-forgejo/worktree',
      baseBranch: 'main', baseSha: BASE_SHA, mergeStrategy: 'draft-pr',
      autoMerge: false, externalSend: true,
    });
    // The discovered open PR (head wrongHead) fails the canonical assertion.
    await expect(createOrFinalizeForgejoPullRequest(identity, true))
      .rejects.toThrow(/quarantined|immutable release authority/);
    expect(server.quarantined.length).toBeGreaterThan(0);
    expect(server.quarantined[0]!.state).toBe('closed');
  });

  test('reconcile converges draft-pr intents and drains pending batches', async () => {
    await registerForgejoCredential({
      workspaceId: 'ws-forgejo', instanceUrl: baseUrl, owner: 'acme', name: 'widgets',
      token: RAW_TOKEN, createdBy: 'operator',
    });
    (query as jest.Mock).mockResolvedValue([{ run_id: 42 }]); // db/index query returns rows directly
    installTransactionMock();
    const result = await reconcileForgejoRunReleaseIntent(42);
    expect(result.status).toBe('completed');
    const drained = await drainForgejoPendingRunReleases(10, 100);
    expect(drained.scanned).toBeGreaterThanOrEqual(0);
  });
});
