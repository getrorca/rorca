/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { GithubProviderBindingSchema, ProviderBindingSchema } from '../authority-provider-adapter';
import { GitHubAuthorityProviderAdapter } from '../github-authority-provider-adapter';
import { GITHUB_EXECUTION_FOUNDATION_ARCHITECTURE } from '../github-execution-foundation-architecture';
import type { GithubAppBindingRecord } from '../github-app-credential-provider';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SECRET_VALUE_FIELD = /installationToken|appJwt|privateKey|\bpat\b|sshKey/i;

const BINDING: GithubAppBindingRecord = {
  bindingId: '11111111-1111-4111-8111-111111111111',
  bindingGeneration: 3,
  workspaceId: 'workspace-one',
  status: 'active',
  appId: 10,
  appSlug: 'rorca',
  registrationStatus: 'active',
  privateKeySecretId: '22222222-2222-4222-8222-222222222222',
  webhookSecretId: '33333333-3333-4333-8333-333333333333',
  installationRecordId: '44444444-4444-4444-8444-444444444444',
  installationId: 77,
  installationStatus: 'active',
  accountId: 55,
  accountLogin: 'getrorca',
  accountType: 'Organization',
  repositorySelection: 'selected',
  repositoryId: 88,
  repoOwner: 'getrorca',
  repoName: 'rorca',
  permissions: { contents: 'write' },
  events: ['push'],
  lastValidatedAt: '2026-08-21T00:00:00.000Z',
  lastWebhookAt: null,
  validationErrorCode: null,
  providerProfileVerifiedAt: '2026-08-21T00:00:00.000Z',
  providerHookConfigured: true,
  signedDeliveryObserved: false,
};

test('architecture reports exactly one canonical GitHub execution owner per surface', () => {
  const report = GITHUB_EXECUTION_FOUNDATION_ARCHITECTURE;
  expect(report).toMatchObject({
    defaultDeliveryAdapterId: 'local-review-bundle',
    githubOptIn: true,
  });
  expect(report.installationTokenProvider[0]).toMatchObject({
    implementation: expect.stringContaining('#preflightGithubInstallationLease'),
    settlement: expect.stringContaining('#settleGithubInstallationLease'),
    revocationReconciliation: expect.stringContaining('#reconcileGithubInstallationLeaseRevocation'),
    capabilityMapper: expect.stringContaining('#githubPermissionsForScmCapabilities'),
    trustedInjector: expect.stringContaining('#withTrustedGithubInstallationLeaseToken'),
    cache: 'module-memory-only',
  });

  for (const surface of [
    report.providerBindingContract,
    report.appRegistration,
    report.repositoryBinding,
    report.installationTokenProvider,
    report.settingsApi,
    report.settingsUi,
    report.adapterImplementation,
  ]) {
    expect(surface).toHaveLength(1);
  }

  const ownedFiles = [
    report.providerBindingContract[0],
    report.appRegistration[0].owner,
    report.repositoryBinding[0].reader.split('#')[0],
    report.installationTokenProvider[0].implementation.split('#')[0],
    report.settingsApi[0].router,
    report.settingsUi[0].component,
    report.adapterImplementation[0].implementation.split('#')[0],
    report.adapterImplementation[0].reconciler.split('#')[0],
    report.adapterImplementation[0].selector.split('#')[0],
  ];
  expect(new Set(ownedFiles)).toHaveProperty('size', 7);
  for (const file of ownedFiles) expect(fs.existsSync(path.join(REPO_ROOT, file))).toBe(true);
  expect(report.adapterImplementation[0]).toMatchObject({
    attemptTable: 'provider_operation_attempts',
    receiptTable: 'provider_operation_receipts',
  });
});

test('canonical registration, binding, token provider, routes, and settings are reused without duplicates', () => {
  const migration = fs.readFileSync(path.join(
    REPO_ROOT,
    'backend/src/db/pg-migrations/20260715230000_github_app_credentials.sql',
  ), 'utf8');
  expect(migration.match(/CREATE TABLE IF NOT EXISTS github_app_registrations/g)).toHaveLength(1);
  expect(migration.match(/CREATE TABLE IF NOT EXISTS github_app_workspace_bindings/g)).toHaveLength(1);

  const server = fs.readFileSync(path.join(REPO_ROOT, 'backend/src/server.ts'), 'utf8');
  expect(server).toContain("import workspaceGithubRouter from './routes/workspace-github'");
  expect(server).toContain("import workspaceGithubAppRouter from './routes/workspace-github-app'");
  expect(server.match(/app\.use\('\/api\/workspaces', workspaceGithubRouter\)/g)).toHaveLength(1);
  expect(server.match(/app\.use\('\/api\/workspaces', workspaceGithubAppRouter\)/g)).toHaveLength(1);

  const settings = fs.readFileSync(path.join(REPO_ROOT, 'src/panels/SettingsPanel.tsx'), 'utf8');
  expect(settings.match(/import\('\.\/GitHubSettingsPanel'\)/g)).toHaveLength(1);
  expect(settings.match(/activeTab === 'github'/g)).toHaveLength(1);

  expect(fs.readdirSync(path.join(REPO_ROOT, 'backend/src/lib')).filter((name) => name === 'github-authority-provider-adapter.ts')).toHaveLength(1);
  expect(fs.readdirSync(path.join(REPO_ROOT, 'backend/src/routes')).filter((name) => name === 'workspace-github-app.ts')).toHaveLength(1);
  expect(fs.readdirSync(path.join(REPO_ROOT, 'src/panels')).filter((name) => name === 'GitHubSettingsPanel.tsx')).toHaveLength(1);
  expect(fs.existsSync(path.join(REPO_ROOT, 'backend/src/lib/github-token-cache.ts'))).toBe(false);
  expect(fs.existsSync(path.join(REPO_ROOT, 'backend/src/lib/github-vault.ts'))).toBe(false);
});

test('ProviderBinding projects identifiers and vault references but rejects credential values', async () => {
  const adapter = new GitHubAuthorityProviderAdapter(
    jest.fn().mockResolvedValue(BINDING),
    jest.fn().mockReturnValue(true),
  );
  const binding = await adapter.getProviderBinding('workspace-one');

  expect(binding).toEqual({
    providerId: 'github-app',
    bindingId: BINDING.bindingId,
    bindingGeneration: 3,
    workspaceId: BINDING.workspaceId,
    bindingStatus: 'active',
    registrationStatus: 'active',
    installationStatus: 'active',
    installationId: 77,
    repositoryId: 88,
    repository: { owner: 'getrorca', name: 'rorca' },
    secretReferences: [
      { purpose: 'app-signing', secretId: BINDING.privateKeySecretId },
      { purpose: 'webhook-verification', secretId: BINDING.webhookSecretId },
    ],
    providerProfileVerified: true,
  });
  expect(adapter.isBindingHealthy(binding)).toBe(true);
  if (!binding) throw new Error('Expected canonical GitHub binding');
  const { bindingGeneration: _bindingGeneration, ...withoutGeneration } = binding;
  expect(adapter.isBindingHealthy(withoutGeneration)).toBe(false);
  expect(adapter.isBindingHealthy({ ...binding, installationId: undefined })).toBe(false);
  expect(adapter.isBindingHealthy({
    ...binding,
    secretReferences: binding.secretReferences.slice(0, 1),
  })).toBe(false);
  expect(JSON.stringify(binding)).not.toMatch(SECRET_VALUE_FIELD);
  expect(() => ProviderBindingSchema.parse({ ...binding, installationToken: 'forbidden' })).toThrow();
  expect(() => ProviderBindingSchema.parse({ ...binding, appJwt: 'forbidden' })).toThrow();
  expect(() => ProviderBindingSchema.parse({ ...binding, privateKey: 'forbidden' })).toThrow();
  expect(() => ProviderBindingSchema.parse({ ...binding, pat: 'forbidden' })).toThrow();
  expect(() => ProviderBindingSchema.parse({ ...binding, sshKey: 'forbidden' })).toThrow();
});

test('core ProviderBinding contract accepts provider-specific public metadata, never credential values', () => {
  const forgejoBinding = ProviderBindingSchema.parse({
    providerId: 'forgejo',
    bindingId: 'forgejo-binding-one',
    workspaceId: 'workspace-one',
    instanceUrl: 'https://forgejo.example.test',
    bindingStatus: 'active',
    registrationStatus: 'active',
    installationStatus: 'active',
    repositoryId: 99,
    repository: { owner: 'getrorca', name: 'rorca-mirror' },
    secretReferences: [{ purpose: 'token', secretId: 'forgejo-binding-one' }],
    providerProfileVerified: true,
  });

  expect(forgejoBinding.providerId).toBe('forgejo');
  expect(forgejoBinding).not.toHaveProperty('installationId');
  expect(() => ProviderBindingSchema.parse({ ...forgejoBinding, token: 'forbidden' })).toThrow();
  expect(() => GithubProviderBindingSchema.parse({ ...forgejoBinding, providerId: 'github-app' })).toThrow();
});

test('GitHub adapter fails closed if its canonical reader returns another workspace binding', async () => {
  const adapter = new GitHubAuthorityProviderAdapter(
    jest.fn().mockResolvedValue({ ...BINDING, workspaceId: 'workspace-two' }),
    jest.fn().mockReturnValue(true),
  );

  await expect(adapter.getProviderBinding('workspace-one')).resolves.toBeNull();
});
