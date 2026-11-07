/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiFetch,
  apiFetchAuthorityMutation,
  apiFetchProviderMutation,
  clearTokens,
  hasOperatorCapability,
  setOperatorCapability,
} from '../apiFetch';
import {
  isBrowserProviderMutation,
  PROVIDER_MUTATION_ROUTES,
  providerMutationApiTemplate,
} from '../../../shared/contracts/provider-mutation-routes';

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  clearTokens();
  localStorage.clear();
  sessionStorage.clear();
});

describe('memory-only operator capability transport', () => {
  it('never attaches the capability to ordinary read or local-preview requests', async () => {
    setOperatorCapability('operator-preimage');
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await apiFetch('/api/workspaces/ws-1/github');
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.has('X-Rorca-Operator-Capability')).toBe(false);

    await expect(apiFetchProviderMutation('/api/workspaces/ws-1/github/pr-template-preview', {
      method: 'POST',
    })).rejects.toMatchObject({ code: 'NOT_PROVIDER_MUTATION' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('attaches the preimage only to the approved provider mutation after CSRF bootstrap', async () => {
    setOperatorCapability('operator-preimage');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await apiFetchProviderMutation('/api/workspaces/ws-1/github/webhook-ping', { method: 'POST' });

    const csrfHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const mutationHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(csrfHeaders.has('X-Rorca-Operator-Capability')).toBe(false);
    expect(mutationHeaders.get('X-Rorca-Operator-Capability')).toBe('operator-preimage');
    expect(mutationHeaders.get('X-CSRF-Token')).toBe('csrf-token');
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain('operator-preimage');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('carries the memory-only capability to an exact authority decision across app navigation', async () => {
    setOperatorCapability('operator-preimage');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const path = '/api/admin/execution-authority/workspaces/ws-1/requests/10000000-0000-4000-8000-000000000001/approve';

    await apiFetchAuthorityMutation(path, { method: 'POST' });

    const mutationHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(mutationHeaders.get('X-Rorca-Operator-Capability')).toBe('operator-preimage');
    expect(mutationHeaders.get('X-CSRF-Token')).toBe('csrf-token');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('derives exact browser allowlisting from the canonical route manifest and rejects path variants', () => {
    const browserRoutes = PROVIDER_MUTATION_ROUTES.filter((route) => route.browserExposed);
    expect(browserRoutes.map((route) => route.id)).toContain('workspace-github-oauth-disconnect');
    expect(browserRoutes.map((route) => route.id)).toContain('delivery-evidence-observe');

    for (const route of browserRoutes) {
      const canonical = providerMutationApiTemplate(route)
        .replace(':id', 'ws-1')
        .replace(':policyId', 'policy-1');
      expect(isBrowserProviderMutation(route.method, canonical), route.id).toBe(true);
      expect(isBrowserProviderMutation(route.method, `${canonical}/`), route.id).toBe(false);
      expect(isBrowserProviderMutation(route.method, canonical.replace('/github', '/GITHUB')), route.id).toBe(false);
      expect(isBrowserProviderMutation(route.method, canonical.replace('/github', '/%67ithub')), route.id).toBe(false);
      expect(isBrowserProviderMutation(route.method, canonical.replace('/github', '//github')), route.id).toBe(false);
      expect(isBrowserProviderMutation(route.method, canonical.replace('/ws-1/', '/../')), route.id).toBe(false);
    }
  });

  it('protects exact OAuth disconnect through the dedicated capability transport', async () => {
    setOperatorCapability('operator-preimage');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ disconnected: true }));

    await apiFetchProviderMutation('/api/workspaces/ws-1/github/disconnect-oauth', { method: 'POST' });
    const headers = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(headers.get('X-Rorca-Operator-Capability')).toBe('operator-preimage');
  });

  it('fails locally when locked and clears rejected capabilities without echoing them', async () => {
    await expect(apiFetchProviderMutation('/api/workspaces/ws-1/github/app/bind', { method: 'POST' }))
      .rejects.toMatchObject({ code: 'OPERATOR_CAPABILITY_REQUIRED' });
    expect(fetchMock).not.toHaveBeenCalled();

    setOperatorCapability('never-echo-this');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'Explicit local operator capability is required' }, 403));

    let message = '';
    try {
      await apiFetchProviderMutation('/api/workspaces/ws-1/github/app/bind', { method: 'POST' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('rejected and cleared');
    expect(message).not.toContain('never-echo-this');
    expect(hasOperatorCapability()).toBe(false);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
