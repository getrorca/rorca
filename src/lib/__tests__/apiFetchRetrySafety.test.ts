/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, clearTokens } from '../apiFetch';

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestCalls(path: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(path));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  clearTokens();
});

describe('apiFetch network replay safety', () => {
  it('retries a GET within the bounded network retry budget', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(apiFetch<{ ok: boolean }>('/api/read-model')).resolves.toEqual({ ok: true });

    const calls = requestCalls('/api/read-model');
    expect(calls).toHaveLength(3);
    expect(calls[0]?.[1]).toBe(calls[1]?.[1]);
    expect(calls[1]?.[1]).toBe(calls[2]?.[1]);
  });

  it('does not replay a POST without an idempotency key and reports an unknown outcome', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: 'csrf-token' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const request = apiFetch('/api/mutations', {
      method: 'POST',
      body: JSON.stringify({ action: 'create' }),
    });

    await expect(request).rejects.toMatchObject({
      status: 0,
      code: 'REQUEST_OUTCOME_UNKNOWN',
      details: {
        method: 'POST',
        path: '/api/mutations',
        outcome: 'unknown',
        reconciliationRequired: true,
        automaticallyRetried: false,
      },
    });
    await expect(request).rejects.toThrow(/outcome is unknown.*Reconcile server state before retrying/i);
    expect(requestCalls('/api/mutations')).toHaveLength(1);
  });

  it('retries a POST with the caller supplied stable key and reuses the exact body and request', async () => {
    const body = JSON.stringify({ action: 'create' });
    const idempotencyKey = 'mission-create-7f9e';
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: 'csrf-token' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValueOnce(jsonResponse({ receiptId: 'receipt-1' }));

    await expect(apiFetch('/api/mutations', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body,
    })).resolves.toEqual({ receiptId: 'receipt-1' });

    const calls = requestCalls('/api/mutations');
    expect(calls).toHaveLength(3);
    expect(calls[0]?.[1]).toBe(calls[1]?.[1]);
    expect(calls[1]?.[1]).toBe(calls[2]?.[1]);
    for (const [, init] of calls) {
      expect(init?.body).toBe(body);
      expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(idempotencyKey);
    }
  });

  it('preserves the caller key and body across the one-time CSRF refresh retry', async () => {
    const body = JSON.stringify({ action: 'approve' });
    const idempotencyKey = 'approval-43-stable';
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: 'csrf-old' }))
      .mockResolvedValueOnce(jsonResponse({ code: 'CSRF_INVALID', message: 'expired token' }, 422))
      .mockResolvedValueOnce(jsonResponse({ token: 'csrf-new' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(apiFetch('/api/approvals', {
      method: 'POST',
      headers: new Headers({ 'Idempotency-Key': idempotencyKey }),
      body,
    })).resolves.toEqual({ ok: true });

    const calls = requestCalls('/api/approvals');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]?.body).toBe(body);
    expect(calls[1]?.[1]?.body).toBe(body);
    expect(new Headers(calls[0]?.[1]?.headers).get('Idempotency-Key')).toBe(idempotencyKey);
    expect(new Headers(calls[1]?.[1]?.headers).get('Idempotency-Key')).toBe(idempotencyKey);
    expect(new Headers(calls[0]?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf-old');
    expect(new Headers(calls[1]?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf-new');
  });

  it('does not retry an aborted request', async () => {
    const controller = new AbortController();
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    controller.abort();
    fetchMock.mockRejectedValueOnce(abortError);

    await expect(apiFetch('/api/read-model', { signal: controller.signal })).rejects.toBe(abortError);
    expect(requestCalls('/api/read-model')).toHaveLength(1);
  });
});
