/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';

const mockBindingRow = {
  binding_id: '10000000-0000-4000-8000-000000000001', binding_generation: 4,
  workspace_id: 'ws-1', binding_status: 'active',
  app_id: 12345, app_slug: 'rorca-test', registration_status: 'active',
  private_key_secret_id: '10000000-0000-4000-8000-000000000002', webhook_secret_id: '10000000-0000-4000-8000-000000000003',
  installation_record_id: '10000000-0000-4000-8000-000000000004', installation_id: 77, installation_status: 'active',
  account_id: 88, account_login: 'acme', account_type: 'Organization', repository_selection: 'selected',
  repository_id: 99, repo_owner: 'acme', repo_name: 'widgets',
  permissions: { metadata: 'read', actions: 'read', checks: 'write', statuses: 'write', contents: 'write', issues: 'read', pull_requests: 'write' },
  events: ['check_run', 'issues', 'pull_request', 'push'], last_validated_at: null, last_webhook_at: null, validation_error_code: null,
  provider_profile_verified_at: '2026-07-17T11:00:00.000Z', provider_hook_configured: true, signed_delivery_observed: false,
};

const mockTransactionQuery = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: jest.fn(async () => mockBindingRow),
  execute: jest.fn(async () => ({ rowCount: 1 })),
  transaction: jest.fn(async (operation: (client: { query: typeof mockTransactionQuery }) => Promise<unknown>) => (
    operation({ query: mockTransactionQuery })
  )),
}));

const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

jest.mock('../integration-vault', () => ({
  getIntegrationSecret: jest.fn(),
}));

import {
  assertGithubAppProviderProfile,
  clearGithubAppTokenCacheForTests,
  createGithubAppJwt,
  githubAppBindingHasVerifiedProfile,
  githubPermissionsForScmCapabilities,
  preflightGithubInstallationLease,
  reconcileGithubInstallationLeaseRevocation,
  resolveRepositoryInstallationToken,
  settleGithubInstallationLease,
  withTrustedGithubInstallationLeaseToken,
} from '../github-app-credential-provider';
import { execute, queryOne } from '../../db/index';
import { getIntegrationSecret } from '../integration-vault';

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as Response;
}

function providerFetch(expiresAt: () => string) {
  return jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/app/installations/77')) return response({
      id: 77, app_id: 12345, repository_selection: 'selected', suspended_at: null,
      account: { id: 88, login: 'acme', type: 'Organization' },
    });
    if (url.endsWith('/app/installations/77/access_tokens')) {
      const requested = JSON.parse(String(init?.body ?? '{}')).permissions;
      return response({ token: 'ghs_short_lived_secret', expires_at: expiresAt(), repository_selection: 'selected',
        permissions: requested, repositories: [{ id: 99 }] });
    }
    if (url.endsWith('/repos/acme/widgets')) return response({ id: 99, full_name: 'acme/widgets' });
    if (url.endsWith('/installation/token') && init?.method === 'DELETE') return response(null, 204);
    throw new Error(`unexpected URL ${url}`);
  });
}

beforeEach(() => {
  clearGithubAppTokenCacheForTests();
  jest.clearAllMocks();
  (queryOne as jest.Mock).mockImplementation(async (sql: string) => {
    if (sql.includes('WHERE authority_grant_id = $1')) return null;
    if (sql.includes('SELECT l.state AS lease_state')) {
      return { lease_state: 'active', binding_status: 'active', binding_generation: mockBindingRow.binding_generation };
    }
    return mockBindingRow;
  });
  (execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
  mockTransactionQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM github_app_workspace_bindings')) {
      return {
        rows: [{
          id: mockBindingRow.binding_id,
          status: mockBindingRow.binding_status,
          binding_generation: mockBindingRow.binding_generation,
          repository_id: mockBindingRow.repository_id,
          repo_owner: mockBindingRow.repo_owner,
          repo_name: mockBindingRow.repo_name,
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  });
  (getIntegrationSecret as jest.Mock).mockResolvedValue(privateKey);
});

describe('GitHub App RS256 JWT', () => {
  test('has bounded backdated claims and a valid RS256 signature', () => {
    const now = new Date('2026-07-17T12:00:00.000Z');
    const jwt = createGithubAppJwt(12345, privateKey, now);
    const [headerPart, payloadPart, signaturePart] = jwt.split('.');
    expect(JSON.parse(Buffer.from(headerPart, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(payloadPart, 'base64url').toString())).toEqual({
      iat: Math.floor(now.getTime() / 1000) - 60,
      exp: Math.floor(now.getTime() / 1000) + 540,
      iss: '12345',
    });
    expect(crypto.verify('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`), keyPair.publicKey, Buffer.from(signaturePart, 'base64url'))).toBe(true);
    expect(jwt).not.toContain(privateKey.slice(0, 20));
  });

  test('rejects non-RSA and malformed keys', () => {
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => createGithubAppJwt(12345, ec)).toThrow('must be RSA');
    expect(() => createGithubAppJwt(12345, 'not a key')).toThrow('valid PEM');
  });
});

describe('exact GitHub App provider profile', () => {
  test('rejects unknown grants, broader levels, missing permissions, and extra events', () => {
    expect(() => assertGithubAppProviderProfile(mockBindingRow.permissions, mockBindingRow.events)).not.toThrow();
    expect(() => assertGithubAppProviderProfile({ ...mockBindingRow.permissions, administration: 'write' }, mockBindingRow.events))
      .toThrow('do not match the supported profile');
    expect(() => assertGithubAppProviderProfile({ ...mockBindingRow.permissions, issues: 'write' }, mockBindingRow.events))
      .toThrow('do not match the supported profile');
    const { checks: _checks, ...missingChecks } = mockBindingRow.permissions;
    expect(() => assertGithubAppProviderProfile(missingChecks, mockBindingRow.events)).toThrow('do not match the supported profile');
    expect(() => assertGithubAppProviderProfile(mockBindingRow.permissions, [...mockBindingRow.events, 'deployment']))
      .toThrow('do not match the supported profile');
    expect(() => assertGithubAppProviderProfile(mockBindingRow.permissions, [...mockBindingRow.events, 'push']))
      .toThrow('do not match the supported profile');
  });
});

describe('repository-scoped installation token provider', () => {
  test('separates configured provider hook from observed delivery and expires stale profiles', async () => {
    const binding = await import('../github-app-credential-provider').then(module => module.getWorkspaceGithubAppBinding('ws-1'));
    expect(binding?.signedDeliveryObserved).toBe(false);
    expect(githubAppBindingHasVerifiedProfile(binding, new Date('2026-07-18T10:59:59.000Z'))).toBe(true);
    expect(githubAppBindingHasVerifiedProfile(binding, new Date('2026-07-18T11:00:01.000Z'))).toBe(false);
    expect(githubAppBindingHasVerifiedProfile(binding ? { ...binding, providerHookConfigured: false } : null, new Date('2026-07-17T12:00:00.000Z'))).toBe(false);
    expect(githubAppBindingHasVerifiedProfile(
      binding ? { ...binding, validationErrorCode: 'token_mint_probe_failed' } : null,
      new Date('2026-07-17T12:00:00.000Z'),
    )).toBe(false);
  });

  test('uses bounded single-flight and then the in-memory cache without serializing secrets', async () => {
    const now = new Date('2026-07-17T12:00:00.000Z');
    const fetchMock = providerFetch(() => new Date(now.getTime() + 5 * 60_000).toISOString());
    const options = { fetch: fetchMock as unknown as typeof fetch, now: () => now };
    const [first, second] = await Promise.all([
      resolveRepositoryInstallationToken('ws-1', { owner: 'acme', name: 'widgets' }, { checks: 'write' }, options),
      resolveRepositoryInstallationToken('ws-1', { owner: 'acme', name: 'widgets' }, { checks: 'write' }, options),
    ]);
    const cached = await resolveRepositoryInstallationToken('ws-1', { owner: 'acme', name: 'widgets' }, { checks: 'write' }, options);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      repository_ids: [99], permissions: { checks: 'write', metadata: 'read' },
    });
    expect(first?.token).toBe('ghs_short_lived_secret');
    expect(second?.metadata.repositoryId).toBe(99);
    expect(cached?.metadata.source).toBe('github-app-installation');
    expect(JSON.stringify(first?.metadata)).not.toContain('ghs_short_lived_secret');
  });

  test('refreshes when cached token enters expiry skew', async () => {
    let now = new Date('2026-07-17T12:00:00.000Z');
    const fetchMock = providerFetch(() => new Date(now.getTime() + 2 * 60_000).toISOString());
    const options = { fetch: fetchMock as unknown as typeof fetch, now: () => now };
    await resolveRepositoryInstallationToken('ws-1', { owner: 'acme', name: 'widgets' }, {}, options);
    now = new Date(now.getTime() + 70_000);
    await resolveRepositoryInstallationToken('ws-1', { owner: 'acme', name: 'widgets' }, {}, options);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  test('rejects a provider token response that is not exactly repository-scoped', async () => {
    const now = new Date('2026-07-17T12:00:00.000Z');
    const fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith('/app/installations/77')) return response({
        id: 77, app_id: 12345, repository_selection: 'selected', suspended_at: null,
        account: { id: 88, login: 'acme', type: 'Organization' },
      });
      return response({
        token: 'ghs_too_broad', expires_at: new Date(now.getTime() + 300_000).toISOString(), repository_selection: 'selected',
        permissions: { checks: 'write' }, repositories: [{ id: 99 }, { id: 100 }],
      });
    });
    await expect(resolveRepositoryInstallationToken('ws-1', { owner: 'acme', name: 'widgets' }, {}, {
      fetch: fetchMock as unknown as typeof fetch, now: () => now,
    })).rejects.toThrow('unusable repository token');
    expect(JSON.stringify((execute as jest.Mock).mock.calls)).not.toContain('ghs_too_broad');
  });

  test('rejects unknown or broader token grants and isolates cache by exact permission profile', async () => {
    const now = new Date('2026-07-17T12:00:00.000Z');
    const fetchMock = providerFetch(() => new Date(now.getTime() + 300_000).toISOString());
    await resolveRepositoryInstallationToken('ws-1', { owner: 'acme', name: 'widgets' }, { checks: 'write' }, {
      fetch: fetchMock as unknown as typeof fetch, now: () => now,
    });
    await resolveRepositoryInstallationToken('ws-1', { owner: 'acme', name: 'widgets' }, { statuses: 'write' }, {
      fetch: fetchMock as unknown as typeof fetch, now: () => now,
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);

    clearGithubAppTokenCacheForTests();
    const confused = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/app/installations/77')) return response({
        id: 77, app_id: 12345, repository_selection: 'selected', suspended_at: null,
        account: { id: 88, login: 'acme', type: 'Organization' },
      });
      if (url.endsWith('/access_tokens')) {
        const requested = JSON.parse(String(init?.body ?? '{}')).permissions;
        return response({ token: 'ghs_confused', expires_at: new Date(now.getTime() + 300_000).toISOString(),
          repository_selection: 'selected', permissions: { ...requested, administration: 'write' }, repositories: [{ id: 99 }] });
      }
      return response({ id: 99, full_name: 'acme/widgets' });
    });
    await expect(resolveRepositoryInstallationToken('ws-1', { owner: 'acme', name: 'widgets' }, { checks: 'write' }, {
      fetch: confused as unknown as typeof fetch, now: () => now,
    })).rejects.toThrow('permission profile is not exact');
    expect(JSON.stringify((execute as jest.Mock).mock.calls)).not.toContain('ghs_confused');
  });

  test('fails before provider calls on repository mismatch', async () => {
    const now = new Date('2026-07-17T12:00:00.000Z');
    const fetchMock = providerFetch(() => new Date(now.getTime() + 300_000).toISOString());
    await expect(resolveRepositoryInstallationToken('ws-1', { owner: 'acme', name: 'other' }, {}, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    })).rejects.toThrow('does not match');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('invalidates binding on provider installation drift and never returns a token', async () => {
    const fetchMock = jest.fn(async () => response({
      id: 77, app_id: 99999, repository_selection: 'selected', suspended_at: null,
      account: { id: 88, login: 'acme', type: 'Organization' },
    }));
    await expect(resolveRepositoryInstallationToken('ws-1', { owner: 'acme', name: 'widgets' }, {}, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => new Date('2026-07-17T12:00:00.000Z'),
    })).rejects.toThrow('no longer matches');
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("status = 'invalid'"), [mockBindingRow.binding_id, 'installation_identity_mismatch']);
    expect(JSON.stringify((execute as jest.Mock).mock.calls)).not.toContain('ghs_');
  });

  test('invalidates the binding on an authoritative provider 404 without retaining its body', async () => {
    const fetchMock = jest.fn(async () => response({ message: 'secret ghs_body repository details' }, 404));
    await expect(resolveRepositoryInstallationToken('ws-1', { owner: 'acme', name: 'widgets' }, {}, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => new Date('2026-07-17T12:00:00.000Z'),
    })).rejects.toThrow('resource is unavailable');
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("status = 'invalid'"), [mockBindingRow.binding_id, 'installation_provider_rejected']);
    expect(JSON.stringify((execute as jest.Mock).mock.calls)).not.toContain('ghs_body');
  });
});

describe('repository-scoped SCM installation leases', () => {
  const fullCapabilities = [
    'scm.repository.read',
    'scm.branch.write',
    'scm.pull_request.write',
    'scm.checks.read',
    'scm.review.request',
  ] as const;
  const baseRequest = {
    workspaceId: 'ws-1',
    bindingId: mockBindingRow.binding_id,
    bindingGeneration: mockBindingRow.binding_generation,
    authorityGrantId: '20000000-0000-4000-8000-000000000001',
    repository: { id: 99, owner: 'acme', name: 'widgets' },
    capabilities: fullCapabilities,
  };

  test('maps the reviewed grant to an exact downscoped token and persists no credential values', async () => {
    const now = new Date('2026-07-17T12:00:00.000Z');
    const fetchMock = providerFetch(() => new Date(now.getTime() + 5 * 60_000).toISOString());

    expect(githubPermissionsForScmCapabilities(fullCapabilities)).toEqual({
      checks: 'read',
      contents: 'write',
      metadata: 'read',
      pull_requests: 'write',
    });

    expect(githubPermissionsForScmCapabilities(['scm.repository.read'])).toEqual({
      contents: 'read',
      metadata: 'read',
    });
    expect(githubPermissionsForScmCapabilities(['scm.branch.write'])).toEqual({
      contents: 'write',
      metadata: 'read',
    });
    expect(githubPermissionsForScmCapabilities(['scm.pull_request.write'])).toEqual({
      metadata: 'read',
      pull_requests: 'write',
    });
    expect(githubPermissionsForScmCapabilities(['scm.checks.read'])).toEqual({
      checks: 'read',
      metadata: 'read',
    });
    expect(githubPermissionsForScmCapabilities(['scm.review.request'])).toEqual({
      metadata: 'read',
      pull_requests: 'write',
    });
    const lease = await preflightGithubInstallationLease(baseRequest, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });

    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      repository_ids: [99],
      permissions: { checks: 'read', contents: 'write', metadata: 'read', pull_requests: 'write' },
    });
    expect(lease).toMatchObject({
      source: 'github-app-installation',
      workspaceId: 'ws-1',
      bindingId: mockBindingRow.binding_id,
      bindingGeneration: 4,
      installationId: 77,
      repository: { id: 99, owner: 'acme', name: 'widgets' },
      permissions: { checks: 'read', contents: 'write', metadata: 'read', pull_requests: 'write' },
    });
    expect(lease.permissions).not.toHaveProperty('actions');
    expect(lease.permissions).not.toHaveProperty('administration');
    expect(lease.permissions).not.toHaveProperty('deployments');
    expect(lease.permissions).not.toHaveProperty('secrets');
    expect(lease.permissions).not.toHaveProperty('releases');
    expect(JSON.stringify(lease)).not.toContain('ghs_short_lived_secret');
    expect(JSON.stringify((execute as jest.Mock).mock.calls)).not.toContain('ghs_short_lived_secret');
    expect(JSON.stringify((execute as jest.Mock).mock.calls)).not.toContain(privateKey);

    await withTrustedGithubInstallationLeaseToken(lease.leaseId, async (token, metadata) => {
      expect(token).toBe('ghs_short_lived_secret');
      expect(metadata.repository).toEqual({ id: 99, owner: 'acme', name: 'widgets' });
    }, () => now);
    const settlement = await settleGithubInstallationLease(lease.leaseId, 'completed', {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });
    expect(settlement).toEqual({
      leaseId: lease.leaseId,
      state: 'settled',
      settlementKind: 'revoked',
      expiresAt: lease.expiresAt,
    });
    await expect(withTrustedGithubInstallationLeaseToken(
      lease.leaseId,
      async () => 'unreachable',
      () => now,
    )).rejects.toThrow('not usable');
    expect(fetchMock.mock.calls[3][0]).toBe('https://api.github.com/installation/token');
    expect(fetchMock.mock.calls[3][1]?.method).toBe('DELETE');
    (queryOne as jest.Mock).mockResolvedValueOnce({
      state: 'settled',
      expires_at: lease.expiresAt,
      settlement_kind: 'revoked',
      provider_binding_id: mockBindingRow.binding_id,
    });
    await expect(settleGithubInstallationLease(lease.leaseId, 'completed', {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    })).resolves.toEqual(settlement);
  });

  test('rechecks persisted binding authority before each trusted token use', async () => {
    const now = new Date('2026-07-17T12:00:00.000Z');
    const fetchMock = providerFetch(() => new Date(now.getTime() + 5 * 60_000).toISOString());
    const lease = await preflightGithubInstallationLease(baseRequest, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });
    (queryOne as jest.Mock).mockResolvedValueOnce({
      lease_state: 'active',
      binding_status: 'disabled',
      binding_generation: mockBindingRow.binding_generation + 1,
    });

    await expect(withTrustedGithubInstallationLeaseToken(
      lease.leaseId,
      async () => 'unreachable',
      () => now,
    )).rejects.toThrow('not usable');
  });

  test('revokes a minted token when disable wins the final binding fence', async () => {
    const now = new Date('2026-07-17T12:00:00.000Z');
    const fetchMock = providerFetch(() => new Date(now.getTime() + 5 * 60_000).toISOString());
    mockTransactionQuery.mockImplementationOnce(async () => ({
      rows: [{
        id: mockBindingRow.binding_id,
        status: 'disabled',
        binding_generation: mockBindingRow.binding_generation + 1,
        repository_id: mockBindingRow.repository_id,
        repo_owner: mockBindingRow.repo_owner,
        repo_name: mockBindingRow.repo_name,
      }],
      rowCount: 1,
    }));

    await expect(preflightGithubInstallationLease(baseRequest, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    })).rejects.toThrow('authority changed');
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('https://api.github.com/installation/token');
    expect(fetchMock.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
    expect(mockTransactionQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO provider_authority_leases'))).toBe(false);
  });

  test('compensates a crash after token mint and retries with one usable installation lease', async () => {
    const now = new Date('2026-07-17T12:00:00.000Z');
    const fetchMock = providerFetch(() => new Date(now.getTime() + 5 * 60_000).toISOString());
    let crashNextInsert = true;
    mockTransactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM github_app_workspace_bindings')) {
        return {
          rows: [{
            id: mockBindingRow.binding_id,
            status: mockBindingRow.binding_status,
            binding_generation: mockBindingRow.binding_generation,
            repository_id: mockBindingRow.repository_id,
            repo_owner: mockBindingRow.repo_owner,
            repo_name: mockBindingRow.repo_name,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO provider_authority_leases') && crashNextInsert) {
        crashNextInsert = false;
        throw new Error('simulated crash after token mint');
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(preflightGithubInstallationLease(baseRequest, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    })).rejects.toThrow('simulated crash after token mint');
    const lease = await preflightGithubInstallationLease(baseRequest, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });

    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/access_tokens'))).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url, init]) => (
      String(url).endsWith('/installation/token') && init?.method === 'DELETE'
    ))).toHaveLength(1);
    expect(mockTransactionQuery.mock.calls.filter(([sql]) => (
      String(sql).includes('INSERT INTO provider_authority_leases')
    ))).toHaveLength(2);
    await expect(withTrustedGithubInstallationLeaseToken(
      lease.leaseId,
      async (_token, metadata) => metadata.leaseId,
      () => now,
    )).resolves.toBe(lease.leaseId);
  });

  test('rejects replayed authority grants before minting another installation token', async () => {
    const now = new Date('2026-07-17T12:00:00.000Z');
    const fetchMock = providerFetch(() => new Date(now.getTime() + 5 * 60_000).toISOString());
    let persistedLeaseId: string | null = null;
    (queryOne as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.includes('WHERE authority_grant_id = $1')) {
        return persistedLeaseId ? { id: persistedLeaseId } : null;
      }
      if (sql.includes('SELECT l.state AS lease_state')) {
        return { lease_state: 'active', binding_status: 'active', binding_generation: mockBindingRow.binding_generation };
      }
      return mockBindingRow;
    });

    const lease = await preflightGithubInstallationLease(baseRequest, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });
    persistedLeaseId = lease.leaseId;
    await expect(preflightGithubInstallationLease(baseRequest, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    })).rejects.toThrow('authority grant has already been leased');

    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/access_tokens'))).toHaveLength(1);
    expect(mockTransactionQuery.mock.calls.filter(([sql]) => (
      String(sql).includes('INSERT INTO provider_authority_leases')
    ))).toHaveLength(1);
  });

  test('compensates a concurrent authority-grant replay race and returns a domain conflict', async () => {
    const now = new Date('2026-07-17T12:00:00.000Z');
    const fetchMock = providerFetch(() => new Date(now.getTime() + 5 * 60_000).toISOString());
    const uniqueViolation = Object.assign(new Error('duplicate authority grant'), { code: '23505' });
    mockTransactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM github_app_workspace_bindings')) {
        return {
          rows: [{
            id: mockBindingRow.binding_id,
            status: mockBindingRow.binding_status,
            binding_generation: mockBindingRow.binding_generation,
            repository_id: mockBindingRow.repository_id,
            repo_owner: mockBindingRow.repo_owner,
            repo_name: mockBindingRow.repo_name,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO provider_authority_leases')) throw uniqueViolation;
      return { rows: [], rowCount: 1 };
    });

    await expect(preflightGithubInstallationLease(baseRequest, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    })).rejects.toThrow('authority grant has already been leased');
    expect(fetchMock.mock.calls.filter(([url, init]) => (
      String(url).endsWith('/installation/token') && init?.method === 'DELETE'
    ))).toHaveLength(1);
  });

  test('rejects every unhealthy or stale binding before any provider token request', async () => {
    const now = new Date('2026-07-17T12:00:00.000Z');
    const fetchMock = providerFetch(() => new Date(now.getTime() + 5 * 60_000).toISOString());
    const reject = async (
      row: Record<string, unknown> | null,
      request: typeof baseRequest,
      message: string,
    ) => {
      (queryOne as jest.Mock).mockResolvedValueOnce(row);
      await expect(preflightGithubInstallationLease(request, {
        fetch: fetchMock as unknown as typeof fetch,
        now: () => now,
      })).rejects.toThrow(message);
    };

    await reject(null, baseRequest, 'No GitHub App binding exists');
    await reject({ ...mockBindingRow, binding_status: 'disabled' }, baseRequest, 'binding or registration is inactive');
    await reject({ ...mockBindingRow, installation_status: 'suspended' }, baseRequest, 'installation is suspended or removed');
    await reject({ ...mockBindingRow, provider_profile_verified_at: '2026-07-15T00:00:00.000Z' }, baseRequest, 'verification is stale');
    await reject({ ...mockBindingRow, provider_profile_verified_at: null }, baseRequest, 'profile is unverified');
    await reject({ ...mockBindingRow, validation_error_code: 'token_mint_probe_failed' }, baseRequest, 'profile is unverified');
    const { contents: _contents, ...permissionDeficient } = mockBindingRow.permissions;
    await reject({ ...mockBindingRow, permissions: permissionDeficient }, baseRequest, 'lacks required repository permissions');
    await reject(mockBindingRow, { ...baseRequest, bindingGeneration: 3 }, 'generation is stale');
    await reject(mockBindingRow, {
      ...baseRequest,
      repository: { id: 100, owner: 'acme', name: 'other' },
    }, 'does not match the immutable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects a non-mintable installation without creating a lease row', async () => {
    const now = new Date('2026-07-17T12:00:00.000Z');
    const fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith('/app/installations/77')) return response({
        id: 77,
        app_id: 12345,
        repository_selection: 'selected',
        suspended_at: null,
        account: { id: 88, login: 'acme', type: 'Organization' },
      });
      return response({ token: 'ghs_provider_body_must_not_escape' }, 422);
    });

    await expect(preflightGithubInstallationLease(baseRequest, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    })).rejects.toThrow('rejected the request parameters');
    expect((execute as jest.Mock).mock.calls.some(([sql]) => String(sql).includes('INSERT INTO provider_authority_leases'))).toBe(false);
    expect(JSON.stringify((execute as jest.Mock).mock.calls)).not.toContain('ghs_provider_body_must_not_escape');
  });

  test('settles by verified expiry without reusing or revoking an expired cached token', async () => {
    let now = new Date('2026-07-17T12:00:00.000Z');
    const expiresAt = new Date(now.getTime() + 2 * 60_000).toISOString();
    const fetchMock = providerFetch(() => expiresAt);
    const lease = await preflightGithubInstallationLease(baseRequest, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });
    now = new Date(now.getTime() + 3 * 60_000);
    clearGithubAppTokenCacheForTests();
    (queryOne as jest.Mock).mockResolvedValueOnce({
      state: 'active',
      expires_at: expiresAt,
      settlement_kind: null,
      provider_binding_id: mockBindingRow.binding_id,
    });

    await expect(settleGithubInstallationLease(lease.leaseId, 'expired', {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    })).resolves.toMatchObject({ state: 'settled', settlementKind: 'verified_expiry' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('clears a failed revocation, records reconciliation, and invalidates the binding', async () => {
    const now = new Date('2026-07-17T12:00:00.000Z');
    const provider = providerFetch(() => new Date(now.getTime() + 5 * 60_000).toISOString());
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/installation/token')) return response({ token: 'ghs_error_body' }, 500);
      return provider(url, init);
    });
    const lease = await preflightGithubInstallationLease(baseRequest, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });

    await expect(settleGithubInstallationLease(lease.leaseId, 'failed', {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    })).resolves.toMatchObject({ state: 'reconciliation_required', settlementKind: 'revocation_failed' });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("status = 'invalid'"), [
      mockBindingRow.binding_id,
      'lease_revocation_failed',
    ]);
    expect(JSON.stringify((execute as jest.Mock).mock.calls)).not.toContain('ghs_error_body');
    (queryOne as jest.Mock).mockResolvedValueOnce({
      state: 'reconciliation_required',
      expires_at: lease.expiresAt,
      settlement_kind: 'revocation_failed',
      provider_binding_id: mockBindingRow.binding_id,
    });
    await expect(settleGithubInstallationLease(lease.leaseId, 'failed')).resolves.toMatchObject({
      state: 'reconciliation_required',
      settlementKind: 'revocation_failed',
    });
  });

  test('reconciles a crash after provider revocation without revoking or using the token twice', async () => {
    const now = new Date('2026-07-17T12:00:00.000Z');
    const fetchMock = providerFetch(() => new Date(now.getTime() + 5 * 60_000).toISOString());
    const lease = await preflightGithubInstallationLease(baseRequest, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });
    (execute as jest.Mock).mockRejectedValueOnce(new Error('simulated crash after provider revocation'));

    await expect(settleGithubInstallationLease(lease.leaseId, 'completed', {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    })).rejects.toThrow('simulated crash after provider revocation');
    (queryOne as jest.Mock).mockResolvedValueOnce({
      state: 'active',
      expires_at: lease.expiresAt,
      settlement_kind: null,
      provider_binding_id: mockBindingRow.binding_id,
    });
    await expect(settleGithubInstallationLease(lease.leaseId, 'completed', {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    })).resolves.toMatchObject({
      state: 'reconciliation_required',
      settlementKind: 'revocation_failed',
    });
    expect(fetchMock.mock.calls.filter(([url, init]) => (
      String(url).endsWith('/installation/token') && init?.method === 'DELETE'
    ))).toHaveLength(1);
    await expect(withTrustedGithubInstallationLeaseToken(
      lease.leaseId,
      async () => 'unreachable',
      () => now,
    )).rejects.toThrow('not usable');

    (queryOne as jest.Mock).mockResolvedValueOnce({
      state: 'reconciliation_required',
      expires_at: lease.expiresAt,
      settlement_kind: 'revocation_failed',
      provider_binding_id: mockBindingRow.binding_id,
    });
    await expect(reconcileGithubInstallationLeaseRevocation(
      baseRequest.workspaceId,
      lease.leaseId,
      new Date(lease.expiresAt),
    )).resolves.toMatchObject({
      state: 'settled',
      settlementKind: 'verified_expiry',
    });
  });

  test('a read-side expiry check is the only settlement path after revocation failure', async () => {
    const expiresAt = '2026-07-17T12:05:00.000Z';
    const persisted = {
      state: 'reconciliation_required',
      expires_at: expiresAt,
      settlement_kind: 'revocation_failed',
      provider_binding_id: mockBindingRow.binding_id,
    };
    (queryOne as jest.Mock).mockResolvedValue(persisted);

    await expect(reconcileGithubInstallationLeaseRevocation(
      'ws-1',
      '30000000-0000-4000-8000-000000000001',
      new Date('2026-07-17T12:04:59.999Z'),
    )).resolves.toMatchObject({
      state: 'reconciliation_required',
      settlementKind: 'revocation_failed',
    });
    expect(execute).not.toHaveBeenCalled();

    await expect(reconcileGithubInstallationLeaseRevocation(
      'ws-1',
      '30000000-0000-4000-8000-000000000001',
      new Date(expiresAt),
    )).resolves.toMatchObject({
      state: 'settled',
      settlementKind: 'verified_expiry',
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("state = 'reconciliation_required'"),
      ['30000000-0000-4000-8000-000000000001', 'ws-1', expiresAt],
    );
  });
});
