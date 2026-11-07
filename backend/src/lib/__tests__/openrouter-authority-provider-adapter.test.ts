/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { OpenRouterAuthorityProviderAdapter } from '../openrouter-authority-provider-adapter';
import { ForbiddenError, UnprocessableError } from '../errors';

describe('OpenRouterAuthorityProviderAdapter (OSR-001)', () => {
  const workspaceId = 'ws-1';
  const bindingId = crypto.randomUUID();
  const providerAccountId = 'account-1';
  const credential = 'sk-or-v1-management-key-value';
  const fingerprint = `sha256:${crypto.createHash('sha256').update(credential, 'utf8').digest('hex')}`;

  const binding = {
    providerId: 'openrouter' as const,
    bindingId,
    workspaceId,
    bindingStatus: 'active' as const,
    providerAccountId,
    generation: 1,
    managementSecretReference: {
      secretId: crypto.randomUUID(),
      fingerprint,
    },
    policyLimits: {
      maxCreditUsd: 10,
      maxUsage: 1000,
      allowedLimitResets: ['daily'],
      includeByokInLimit: false,
    },
    approvedOperations: ['list_keys', 'verify_binding', 'create_limited_key'],
    health: {
      providerAccountVerified: true,
      completionProbeRejected: true,
      verifiedAt: new Date().toISOString(),
      validationErrorCode: null,
    },
  };

  const store = {
    readBinding: jest.fn(),
    readBindingForWorkspace: jest.fn(),
    markBindingVerified: jest.fn(),
    saveResources: jest.fn(),
    assertResourceOwned: jest.fn(),
    markResourceStatus: jest.fn(),
  };

  const secretStore = {
    resolveManagementCredential: jest.fn(),
    storeRuntimeCredential: jest.fn(),
  };

  const transport = {
    request: jest.fn(),
  };

  let adapter: OpenRouterAuthorityProviderAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new OpenRouterAuthorityProviderAdapter(store as any, secretStore as any, transport as any);
  });

  describe('Redaction and Security', () => {
    it('never returns the management credential in metadata', async () => {
      store.readBinding.mockResolvedValue(binding);
      secretStore.resolveManagementCredential.mockResolvedValue(credential);
      
      transport.request.mockResolvedValue({
        status: 200,
        headers: new Headers({ 'x-openrouter-account-id': providerAccountId }),
        body: { data: [ { hash: 'key-1', name: 'test-key', limit: 1, usage: 0 } ] },
      });

      const keys = await adapter.listKeys({ workspaceId, bindingId, bindingGeneration: 1, providerAccountId });
      
      const serialized = JSON.stringify(keys);
      expect(serialized).not.toContain(credential);
      expect(keys[0].resourceId).toBe('key-1');
    });

    it('rejects the verify probe if the management credential can call completions', async () => {
      store.readBinding.mockResolvedValue(binding);
      secretStore.resolveManagementCredential.mockResolvedValue(credential);
      
      // Probe 1: Keys list (verification that it's a valid key)
      transport.request.mockResolvedValueOnce({
        status: 200,
        headers: new Headers({ 'x-openrouter-account-id': providerAccountId }),
        body: { data: [] },
      });

      // Probe 2: Completion (should be rejected)
      transport.request.mockResolvedValueOnce({
        status: 200, // FAILS: should be 401/403
        headers: new Headers(),
        body: { choices: [{ message: { content: 'hi' } }] },
      });

      await expect(adapter.verify({ workspaceId, bindingId, bindingGeneration: 1, providerAccountId }))
        .rejects.toThrow(UnprocessableError);
      
      expect(transport.request).toHaveBeenCalledTimes(2);
    });

    it('does not include the credential in error messages when provider fails', async () => {
      store.readBinding.mockResolvedValue(binding);
      secretStore.resolveManagementCredential.mockResolvedValue(credential);
      
      transport.request.mockResolvedValue({
        status: 400,
        headers: new Headers(),
        body: { error: { message: `Invalid key: ${credential}` } },
      });

      try {
        await adapter.listKeys({ workspaceId, bindingId, bindingGeneration: 1, providerAccountId });
        throw new Error('Should have thrown');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).not.toContain(credential);
      }
    });

    it('does not include the runtime credential in error messages during creation', async () => {
      store.readBinding.mockResolvedValue(binding);
      secretStore.resolveManagementCredential.mockResolvedValue(credential);
      
      const runtimeKey = 'sk-or-v1-new-runtime-key';
      transport.request.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: {
          key: runtimeKey,
          data: { hash: 'key-2', name: 'new-key', limit: 5, usage: 0 }
        },
      });

      secretStore.storeRuntimeCredential.mockRejectedValue(new Error(`Failed to store ${runtimeKey}`));

      try {
        await adapter.createLimitedKey({
          workspaceId,
          bindingId,
          bindingGeneration: 1,
          providerAccountId,
          name: 'new-key',
          creditLimitUsd: 5,
          limitReset: null,
          usageLimit: null,
        });
        throw new Error('Should have thrown');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).not.toContain(runtimeKey);
      }
    });
  });

  describe('Authorization Boundaries', () => {
    it('fails if workspace does not match the binding', async () => {
      store.readBinding.mockResolvedValue({ ...binding, workspaceId: 'other-ws' });
      
      await expect(adapter.listKeys({ workspaceId, bindingId, bindingGeneration: 1, providerAccountId }))
        .rejects.toThrow(ForbiddenError);
    });

    it('fails if generation is stale', async () => {
      store.readBinding.mockResolvedValue({ ...binding, generation: 2 });
      
      await expect(adapter.listKeys({ workspaceId, bindingId, bindingGeneration: 1, providerAccountId }))
        .rejects.toThrow(ForbiddenError);
    });

    it('fails if the binding is disabled', async () => {
      store.readBinding.mockResolvedValue({ ...binding, bindingStatus: 'disabled' });
      
      await expect(adapter.listKeys({ workspaceId, bindingId, bindingGeneration: 1, providerAccountId }))
        .rejects.toThrow(ForbiddenError);
    });
  });
});
