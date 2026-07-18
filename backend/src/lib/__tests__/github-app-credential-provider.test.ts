/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';

const mockBindingRow = {
  binding_id: '10000000-0000-4000-8000-000000000001', workspace_id: 'ws-1', binding_status: 'active',
  app_id: 12345, app_slug: 'rorca-test', registration_status: 'active',
  private_key_secret_id: '10000000-0000-4000-8000-000000000002', webhook_secret_id: '10000000-0000-4000-8000-000000000003',
  installation_record_id: '10000000-0000-4000-8000-000000000004', installation_id: 77, installation_status: 'active',
  account_id: 88, account_login: 'acme', account_type: 'Organization', repository_selection: 'selected',
  repository_id: 99, repo_owner: 'acme', repo_name: 'widgets',
  permissions: { metadata: 'read', actions: 'write', checks: 'write', statuses: 'write', contents: 'write', issues: 'read', pull_requests: 'write' },
  events: ['check_run', 'issues', 'pull_request', 'push'], last_validated_at: null, last_webhook_at: null, validation_error_code: null,
  provider_profile_verified_at: '2026-07-17T11:00:00.000Z', provider_hook_configured: true, signed_delivery_observed: false,
};

jest.mock('../../db/index', () => ({
  queryOne: jest.fn(async () => mockBindingRow),
  execute: jest.fn(async () => ({ rowCount: 1 })),
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
  resolveRepositoryInstallationToken,
} from '../github-app-credential-provider';
import { execute, queryOne } from '../../db/index';
import { getIntegrationSecret } from '../integration-vault';

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
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
    throw new Error(`unexpected URL ${url}`);
  });
}

beforeEach(() => {
  clearGithubAppTokenCacheForTests();
  jest.clearAllMocks();
  (queryOne as jest.Mock).mockResolvedValue(mockBindingRow);
  (execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
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
    const fetchMock = providerFetch(() => new Date(Date.now() + 300_000).toISOString());
    await expect(resolveRepositoryInstallationToken('ws-1', { owner: 'acme', name: 'other' }, {}, {
      fetch: fetchMock as unknown as typeof fetch,
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
