/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Forgejo authority adapter contract tests.
 *
 * The invariant under test: the adapter is a pure projection over the existing
 * workspace Forgejo credential registry. It never mints tokens, never performs
 * network I/O, never exposes secret values, and fails closed on any non-active
 * binding. The binding reader is injectable so the projection is testable
 * without a credential store.
 */

import { ForgejoAuthorityProviderAdapter, forgejoBindingIsHealthy } from '../forgejo-authority-provider-adapter';
import type { ForgejoCredentialBinding } from '../forgejo-token-credential-provider';
import type { ForgejoProviderBinding } from '../authority-provider-adapter';

function binding(overrides: Partial<ForgejoCredentialBinding> = {}): ForgejoCredentialBinding {
  return {
    bindingId: 'fgb-001',
    workspaceId: 'ws-test',
    instanceUrl: 'https://forgejo-vps.tail7a4b39.ts.net',
    owner: 'rorca',
    name: 'rorca',
    status: 'active',
    tokenDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    scopeProfile: { repositoryId: 42 },
    credentialVersion: 1,
    keyVersion: 1,
    expiresAt: null,
    lastValidatedAt: '2026-08-21T00:00:00.000Z',
    validationErrorCode: null,
    auditProvenanceHash: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    webhookSecretEncrypted: null,
    webhookSecretPreviousEncrypted: null,
    webhookSecretVersion: 0,
    ...overrides,
  };
}

describe('ForgejoAuthorityProviderAdapter', () => {
  it('returns null when no credential binding exists', async () => {
    const adapter = new ForgejoAuthorityProviderAdapter(async () => null);
    expect(await adapter.getProviderBinding('ws-test')).toBeNull();
  });

  it('projects an active binding without exposing the token', async () => {
    const adapter = new ForgejoAuthorityProviderAdapter(async () => binding());
    const projected = await adapter.getProviderBinding('ws-test') as ForgejoProviderBinding | null;
    expect(projected).not.toBeNull();
    expect(projected!.providerId).toBe('forgejo');
    expect(projected!.bindingId).toBe('fgb-001');
    expect(projected!.instanceUrl).toBe('https://forgejo-vps.tail7a4b39.ts.net');
    expect(projected!.repository).toEqual({ owner: 'rorca', name: 'rorca' });
    expect(projected!.repositoryId).toBe(42);
    expect(projected!.bindingStatus).toBe('active');
    expect(projected!.registrationStatus).toBe('active');
    expect(projected!.installationStatus).toBe('active');
    expect(projected!.providerProfileVerified).toBe(true);
    expect(JSON.stringify(projected)).not.toContain('tokenDigest');
    expect(JSON.stringify(projected)).not.toContain('sha256:0000000000000000000000000000000000000000000000000000000000000000');
  });

  it('references the token by the registry row id, never by value', async () => {
    const adapter = new ForgejoAuthorityProviderAdapter(async () => binding());
    const projected = await adapter.getProviderBinding('ws-test') as ForgejoProviderBinding | null;
    expect(projected!.secretReferences).toContainEqual({ purpose: 'token', secretId: 'fgb-001' });
  });

  it('adds a webhook-verification reference only when a webhook secret exists', async () => {
    const plain = await new ForgejoAuthorityProviderAdapter(async () => binding())
      .getProviderBinding('ws-test') as ForgejoProviderBinding | null;
    expect(plain!.secretReferences).toHaveLength(1);

    const withWebhook = await new ForgejoAuthorityProviderAdapter(async () => binding({ webhookSecretEncrypted: 'ciphertext' }))
      .getProviderBinding('ws-test') as ForgejoProviderBinding | null;
    expect(withWebhook!.secretReferences).toHaveLength(2);
    expect(withWebhook!.secretReferences).toContainEqual({ purpose: 'webhook-verification', secretId: 'fgb-001' });
  });

  it('fails closed on non-active, revoked, or unvalidated bindings', async () => {
    const disabled = await new ForgejoAuthorityProviderAdapter(async () => binding({ status: 'disabled' }))
      .getProviderBinding('ws-test') as ForgejoProviderBinding | null;
    expect(disabled!.bindingStatus).toBe('disabled');
    expect(disabled!.installationStatus).toBe('suspended');
    expect(disabled!.providerProfileVerified).toBe(false);

    const revoked = await new ForgejoAuthorityProviderAdapter(async () => binding({ status: 'revoked' }))
      .getProviderBinding('ws-test') as ForgejoProviderBinding | null;
    expect(revoked!.bindingStatus).toBe('disabled');
    expect(forgejoBindingIsHealthy(revoked)).toBe(false);

    const unvalidated = await new ForgejoAuthorityProviderAdapter(async () => binding({ validationErrorCode: 'probe_rejected' }))
      .getProviderBinding('ws-test') as ForgejoProviderBinding | null;
    expect(unvalidated!.providerProfileVerified).toBe(false);
  });

  it('exposes the canonical contract version, descriptor, and capabilities', async () => {
    const adapter = new ForgejoAuthorityProviderAdapter();
    expect(adapter.contractVersion).toBe('rorca.authority-provider-adapter.v1');
    expect(adapter.descriptor.adapterId).toBe('forgejo');
    expect(adapter.descriptor.kind).toBe('provider');
    expect(adapter.descriptor.optional).toBe(true);
    expect(adapter.capabilities).toEqual([
      'scm.repository.read',
      'scm.branch.write',
      'scm.pull_request.write',
      'scm.checks.read',
      'scm.review.request',
    ]);
  });

  it('is healthy only for an active, validated, versioned binding', () => {
    const healthy: ForgejoProviderBinding = {
      providerId: 'forgejo',
      bindingId: 'fgb-001',
      workspaceId: 'ws-test',
      bindingStatus: 'active',
      registrationStatus: 'active',
      installationStatus: 'active',
      instanceUrl: 'https://forgejo-vps.tail7a4b39.ts.net',
      repositoryId: 42,
      repository: { owner: 'rorca', name: 'rorca' },
      secretReferences: [{ purpose: 'token', secretId: 'fgb-001' }],
      providerProfileVerified: true,
    };
    const adapter = new ForgejoAuthorityProviderAdapter();
    expect(adapter.isBindingHealthy(healthy)).toBe(true);
    const malformed = { ...healthy, instanceUrl: 'not-a-url' };
    expect(adapter.isBindingHealthy(malformed)).toBe(false);
    expect(forgejoBindingIsHealthy(healthy)).toBe(true);
    expect(forgejoBindingIsHealthy({ ...healthy, providerProfileVerified: false })).toBe(false);
    expect(forgejoBindingIsHealthy({ ...healthy, bindingStatus: 'disabled' })).toBe(false);
  });
});
