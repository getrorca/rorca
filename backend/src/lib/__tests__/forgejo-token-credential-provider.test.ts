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

jest.mock('../../db/index', () => {
  const mockQueryOne = jest.fn();
  const mockExecute = jest.fn(async (_sql: unknown, _params: unknown[]) => ({ rowCount: 1 }));
  return {
    queryOne: mockQueryOne,
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
  };
});

import { execute, queryOne } from '../../db/index';
import {
  clearForgejoTokenCacheForTests,
  forgejoBindingHasFreshProbe,
  forgejoCredentialDigest,
  getWorkspaceForgejoCredential,
  probeForgejoCapability,
  reconcileForgejoCredentials,
  registerForgejoCredential,
  resolveWorkspaceForgejoToken,
  revokeForgejoCredential,
  rotateForgejoCredential,
} from '../forgejo-token-credential-provider';

let server: ReturnType<typeof createFakeForgejoServer>;
let listener: http.Server;
let baseUrl: string;
let insertedBindingId: string | null = null;

const RAW_TOKEN = 'forgejo-raw-token-fixture-0123456789abcdef';

beforeEach(async () => {
  process.env.RORCA_FORGEJO_PRIVATE_HOST_ALLOWLIST = '127.0.0.1';
  jest.clearAllMocks();
  clearForgejoTokenCacheForTests();
  insertedBindingId = null;
  server = createFakeForgejoServer({
    instanceUrl: 'http://127.0.0.1:0', owner: 'acme', name: 'widgets',
    userLogin: 'automation-bot', token: RAW_TOKEN,
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
  // The database starts with no binding; register() inserts one whose id is
  // captured here so later reads return the exact cached binding identity.
  (queryOne as jest.Mock).mockImplementation(async (sql: unknown) => {
    const text = String(sql);
    if (text.includes('forgejo_workspace_credentials')) {
      if (insertedBindingId == null) return null;
      return {
        ...BINDING, instance_url: baseUrl, id: insertedBindingId,
        token_digest: forgejoCredentialDigest('ws-forgejo', baseUrl, 'acme', 'widgets', RAW_TOKEN, 1, 1),
      };
    }
    return undefined;
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  delete process.env.RORCA_FORGEJO_PRIVATE_HOST_ALLOWLIST;
});

describe('Forgejo token credential provider (W5-002)', () => {
  test('exact capability probe accepts the bounded write profile and denies over-scope', async () => {
    const probe = await probeForgejoCapability('ws-forgejo', baseUrl, 'acme', 'widgets', RAW_TOKEN);
    expect(probe.profile.login).toBe('automation-bot');
    expect(probe.profile.permissions).toEqual({ pull: true, push: true, admin: false });
    expect(probe.repositoryId).toBe(2001);

    const overScoped = createFakeForgejoServer({
      instanceUrl: baseUrl, owner: 'acme', name: 'widgets', token: RAW_TOKEN,
      permissions: { admin: true, push: true, pull: true },
    });
    const overListener = http.createServer(overScoped.app);
    await new Promise<void>((resolve) => overListener.listen(0, '127.0.0.1', resolve));
    const overUrl = `http://127.0.0.1:${(overListener.address() as AddressInfo).port}`;
    await expect(probeForgejoCapability('ws-forgejo', overUrl, 'acme', 'widgets', RAW_TOKEN))
      .rejects.toThrow('not the exact bounded write profile');
    await new Promise<void>((resolve) => overListener.close(() => resolve()));
  });

  test('accepts an exact repository-scoped token when Forgejo denies user-profile APIs', async () => {
    const repositoryScoped = createFakeForgejoServer({
      instanceUrl: baseUrl, owner: 'acme', name: 'widgets', token: RAW_TOKEN,
      userLogin: 'automation-bot', repositoryScoped: true,
    });
    const scopedListener = http.createServer(repositoryScoped.app);
    await new Promise<void>((resolve) => scopedListener.listen(0, '127.0.0.1', resolve));
    const scopedUrl = `http://127.0.0.1:${(scopedListener.address() as AddressInfo).port}`;
    const probe = await probeForgejoCapability('ws-forgejo', scopedUrl, 'acme', 'widgets', RAW_TOKEN);
    expect(probe.profile).toMatchObject({
      login: null,
      principalId: null,
      principalResolution: 'repository-scoped-token',
      repositoryExclusivity: 'exclusive',
      exclusivitySource: 'writable-repository-search',
    });
    await new Promise<void>((resolve) => scopedListener.close(() => resolve()));
  });

  test('rejects indeterminate or non-exclusive repository scope (deny-on-unknown)', async () => {
    const indeterminate = createFakeForgejoServer({
      instanceUrl: baseUrl, owner: 'acme', name: 'widgets', token: RAW_TOKEN, accessibleRepos: null,
    });
    const indListener = http.createServer(indeterminate.app);
    await new Promise<void>((resolve) => indListener.listen(0, '127.0.0.1', resolve));
    const indUrl = `http://127.0.0.1:${(indListener.address() as AddressInfo).port}`;
    await expect(probeForgejoCapability('ws-forgejo', indUrl, 'acme', 'widgets', RAW_TOKEN))
      .rejects.toThrow('indeterminate');
    await new Promise<void>((resolve) => indListener.close(() => resolve()));

    const overScoped = createFakeForgejoServer({
      instanceUrl: baseUrl, owner: 'acme', name: 'widgets', token: RAW_TOKEN,
      accessibleRepos: ['acme/widgets', 'acme/other'],
    });
    const overListener = http.createServer(overScoped.app);
    await new Promise<void>((resolve) => overListener.listen(0, '127.0.0.1', resolve));
    const overUrl = `http://127.0.0.1:${(overListener.address() as AddressInfo).port}`;
    await expect(probeForgejoCapability('ws-forgejo', overUrl, 'acme', 'widgets', RAW_TOKEN))
      .rejects.toThrow('exclusive');
    await new Promise<void>((resolve) => overListener.close(() => resolve()));
  });

  test('denies wrong repository identity and rejected credentials', async () => {
    await expect(probeForgejoCapability('ws-forgejo', baseUrl, 'other', 'widgets', RAW_TOKEN))
      .rejects.toThrow('repository is unavailable');
    await expect(probeForgejoCapability('ws-forgejo', baseUrl, 'acme', 'other', RAW_TOKEN))
      .rejects.toThrow('repository is unavailable');
    const mismatchedIdentity = createFakeForgejoServer({
      instanceUrl: baseUrl, owner: 'acme', name: 'widgets', token: RAW_TOKEN,
      userLogin: 'automation-bot', repositoryOwnerLogin: 'other',
    });
    const mismatchListener = http.createServer(mismatchedIdentity.app);
    await new Promise<void>((resolve) => mismatchListener.listen(0, '127.0.0.1', resolve));
    const mismatchUrl = `http://127.0.0.1:${(mismatchListener.address() as AddressInfo).port}`;
    await expect(probeForgejoCapability('ws-forgejo', mismatchUrl, 'acme', 'widgets', RAW_TOKEN))
      .rejects.toThrow('repository identity does not match');
    await new Promise<void>((resolve) => mismatchListener.close(() => resolve()));

    const badToken = createFakeForgejoServer({
      instanceUrl: baseUrl, owner: 'acme', name: 'widgets', token: 'different-token-abcdefghijklmnop',
    });
    const badListener = http.createServer(badToken.app);
    await new Promise<void>((resolve) => badListener.listen(0, '127.0.0.1', resolve));
    const badUrl = `http://127.0.0.1:${(badListener.address() as AddressInfo).port}`;
    await expect(probeForgejoCapability('ws-forgejo', badUrl, 'acme', 'widgets', RAW_TOKEN))
      .rejects.toThrow('rejected the credential');
    await new Promise<void>((resolve) => badListener.close(() => resolve()));
  });

  test('register stores digest-only rows and never leaks the raw token', async () => {
    (queryOne as jest.Mock).mockResolvedValueOnce(null); // no existing binding
    const binding = await registerForgejoCredential({
      workspaceId: 'ws-forgejo', instanceUrl: baseUrl, owner: 'acme', name: 'widgets',
      token: RAW_TOKEN, createdBy: 'operator',
    });
    expect(binding.status).toBe('active');
    expect(binding.tokenDigest).toBe(forgejoCredentialDigest('ws-forgejo', baseUrl, 'acme', 'widgets', RAW_TOKEN, 1, 1));
    const allSql = (queryOne as jest.Mock).mock.calls.map((call) => String(call[0])).join('\n');
    const allParams = (queryOne as jest.Mock).mock.calls.flatMap((call) => call[1] ?? []);
    const executedSql = (execute as jest.Mock).mock.calls.map((call) => String(call[0])).join('\n');
    const executedParams = (execute as jest.Mock).mock.calls.flatMap((call) => call[1] ?? []);
    expect(allSql + executedSql).not.toContain(RAW_TOKEN);
    expect([...allParams, ...executedParams].map(String).join('\n')).not.toContain(RAW_TOKEN);
    expect(binding.tokenDigest).not.toContain(RAW_TOKEN);
  });

  test('resolves the raw token only for the active binding repository', async () => {
    (queryOne as jest.Mock).mockResolvedValueOnce(null); // no existing binding before register
    await registerForgejoCredential({
      workspaceId: 'ws-forgejo', instanceUrl: baseUrl, owner: 'acme', name: 'widgets',
      token: RAW_TOKEN, createdBy: 'operator',
    });
    const resolved = await resolveWorkspaceForgejoToken('ws-forgejo', {
      repository: { owner: 'acme', name: 'widgets' }, purpose: 'statuses-write',
    });
    expect(resolved?.token).toBe(RAW_TOKEN);
    expect(resolved?.metadata.source).toBe('forgejo-token');
    await expect(resolveWorkspaceForgejoToken('ws-forgejo', {
      repository: { owner: 'acme', name: 'other' },
    })).rejects.toThrow('does not match the workspace Forgejo credential');
  });

  test('denies resolution without an in-process raw token (deny-on-unknown)', async () => {
    (queryOne as jest.Mock).mockResolvedValue({ ...BINDING, instance_url: baseUrl });
    await expect(resolveWorkspaceForgejoToken('ws-forgejo')).rejects.toThrow('operator re-entry required');
  });

  test('rotation advances versions without rewriting identity; old token denied', async () => {
    (queryOne as jest.Mock).mockResolvedValueOnce(null);
    (queryOne as jest.Mock).mockResolvedValueOnce({ ...BINDING, instance_url: baseUrl });
    await registerForgejoCredential({
      workspaceId: 'ws-forgejo', instanceUrl: baseUrl, owner: 'acme', name: 'widgets',
      token: RAW_TOKEN, createdBy: 'operator',
    });
    const newToken = 'forgejo-rotated-token-abcdef0123456789';
    server.validTokens.add(newToken);
    (queryOne as jest.Mock).mockResolvedValueOnce({ ...BINDING, instance_url: baseUrl, credential_version: 1 });
    (queryOne as jest.Mock).mockResolvedValueOnce({ ...BINDING, instance_url: baseUrl, credential_version: 2, key_version: 2 });
    const rotated = await rotateForgejoCredential({
      workspaceId: 'ws-forgejo', instanceUrl: baseUrl, owner: 'acme', name: 'widgets',
      token: newToken, credentialVersion: 2, keyVersion: 2,
    });
    expect(rotated.credentialVersion).toBe(2);
    const resolved = await resolveWorkspaceForgejoToken('ws-forgejo');
    expect(resolved?.token).toBe(newToken);
    const sql = (execute as jest.Mock).mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('superseded_at = NOW()');
    expect(sql).not.toContain(RAW_TOKEN);
    expect(sql).not.toContain(newToken);
  });

  test('revocation and invalid-marking clear the cache and close resolution', async () => {
    (queryOne as jest.Mock).mockResolvedValueOnce(null);
    (queryOne as jest.Mock).mockResolvedValueOnce({ ...BINDING, instance_url: baseUrl });
    await registerForgejoCredential({
      workspaceId: 'ws-forgejo', instanceUrl: baseUrl, owner: 'acme', name: 'widgets',
      token: RAW_TOKEN, createdBy: 'operator',
    });
    await revokeForgejoCredential('ws-forgejo', 'operator_revoked');
    const revokeSql = (execute as jest.Mock).mock.calls.map((call) => String(call[0])).join('\n');
    expect(revokeSql).toContain("status = 'revoked'");
    (queryOne as jest.Mock).mockResolvedValue({ ...BINDING, instance_url: baseUrl, status: 'revoked' });
    await expect(resolveWorkspaceForgejoToken('ws-forgejo')).rejects.toThrow('not active');
  });

  test('binding freshness requires an exact bounded profile within the freshness window', () => {
    const binding = {
      bindingId: BINDING.id, workspaceId: BINDING.workspace_id, instanceUrl: baseUrl,
      owner: BINDING.repo_owner, name: BINDING.repo_name, status: 'active' as const,
      tokenDigest: BINDING.token_digest,
      scopeProfile: {
        schemaVersion: 'rorca.forgejo-capability-profile.v1', login: 'acme', repositoryId: 2001,
        fullName: 'acme/widgets', permissions: { pull: true, push: true, admin: false },
        probedAt: new Date().toISOString(),
      },
      credentialVersion: 1, keyVersion: 1, expiresAt: null, lastValidatedAt: null,
      validationErrorCode: null, auditProvenanceHash: null, createdAt: BINDING.created_at,
      webhookSecretEncrypted: null, webhookSecretPreviousEncrypted: null, webhookSecretVersion: 0,
    };
    expect(forgejoBindingHasFreshProbe(binding)).toBe(true);
    expect(forgejoBindingHasFreshProbe({ ...binding, status: 'invalid' as const })).toBe(false);
    expect(forgejoBindingHasFreshProbe(null)).toBe(false);
  });

  test('reconcile re-probes active bindings and marks failures invalid', async () => {
    (queryOne as jest.Mock).mockResolvedValueOnce(null);
    (queryOne as jest.Mock).mockResolvedValueOnce({ ...BINDING, instance_url: baseUrl });
    await registerForgejoCredential({
      workspaceId: 'ws-forgejo', instanceUrl: baseUrl, owner: 'acme', name: 'widgets',
      token: RAW_TOKEN, createdBy: 'operator',
    });
    server.validTokens.clear(); // probe will now fail
    const result = await reconcileForgejoCredentials(['ws-forgejo']);
    expect(result.invalidated).toBe(1);
    const sql = (execute as jest.Mock).mock.calls.map((call) => String(call[0])).join('\n');
    const params = (execute as jest.Mock).mock.calls.flatMap((call) => call[1] ?? []);
    // markForgejoCredentialInvalid parameterizes the error code; assert across
    // SQL and its parameters.
    expect(sql + '\n' + params.map(String).join('\n')).toContain('forgejo_probe_reconcile_failed');
  });

  test('binding freshness requires an exact bounded profile within the freshness window', () => {
    const fresh = forgejoBindingHasFreshProbe(getWorkspaceForgejoCredential as never);
    void fresh;
    expect(forgejoBindingHasFreshProbe(null)).toBe(false);
  });
});
