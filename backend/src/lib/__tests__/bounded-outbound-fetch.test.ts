/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { boundedOutboundFetch } from '../bounded-outbound-fetch';

describe('bounded outbound HTTP policy', () => {
  test.each([
    'http://127.0.0.1/admin',
    'http://10.0.0.8/internal',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/admin',
    'file:///var/run/docker.sock',
  ])('rejects forbidden target %s before transport', async (target) => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    await expect(boundedOutboundFetch(target, {
      fetchImpl,
      maxResponseBytes: 1024,
      connectionTimeoutMs: 100,
      totalTimeoutMs: 500,
    })).rejects.toMatchObject({ code: expect.stringMatching(/OUTBOUND_TARGET_FORBIDDEN|VALIDATION_ERROR/) });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('validates a redirect destination and refuses metadata without calling it', async () => {
    const fetchImpl = jest.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
    })) as unknown as typeof fetch;
    await expect(boundedOutboundFetch('https://public.example.test/start', {
      fetchImpl,
      resolveHostname: async () => ['93.184.216.34'],
      maxResponseBytes: 1024,
      connectionTimeoutMs: 100,
      totalTimeoutMs: 500,
    })).rejects.toMatchObject({ code: 'OUTBOUND_TARGET_FORBIDDEN' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('fails closed when a streamed decompressed body exceeds the byte budget', async () => {
    const fetchImpl = jest.fn(async () => new Response('x'.repeat(1025), {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })) as unknown as typeof fetch;
    await expect(boundedOutboundFetch('https://public.example.test/large', {
      fetchImpl,
      resolveHostname: async () => ['93.184.216.34'],
      maxResponseBytes: 1024,
      connectionTimeoutMs: 100,
      totalTimeoutMs: 500,
    })).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  test('allows an explicitly authorized private host while retaining byte limits', async () => {
    const fetchImpl = jest.fn(async () => new Response('ok')) as unknown as typeof fetch;
    const response = await boundedOutboundFetch('http://127.0.0.1:3000/health', {
      fetchImpl,
      allowedPrivateHosts: new Set(['127.0.0.1']),
      maxResponseBytes: 16,
      connectionTimeoutMs: 100,
      totalTimeoutMs: 500,
    });
    expect(await response.text()).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
