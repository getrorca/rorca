/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { fetchForgejoWithTimeout } from '../forgejo-token-credential-provider';

const resolvePublic = async () => ['93.184.216.34'];

afterEach(() => {
  delete process.env.RORCA_FORGEJO_PRIVATE_HOST_ALLOWLIST;
});

test('Forgejo probe refuses a redirect hop into metadata without a metadata call', async () => {
  const fetchImpl = jest.fn(async () => new Response(null, {
    status: 302,
    headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
  })) as unknown as typeof fetch;
  await expect(fetchForgejoWithTimeout(
    fetchImpl,
    'https://forgejo.example.test/api/v1/user',
    {},
    500,
    resolvePublic,
  )).rejects.toMatchObject({ code: 'OUTBOUND_TARGET_FORBIDDEN' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('Forgejo probe fails closed before JSON parsing when body exceeds its bound', async () => {
  const fetchImpl = jest.fn(async () => new Response('x'.repeat(256 * 1024 + 1), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;
  await expect(fetchForgejoWithTimeout(
    fetchImpl,
    'https://forgejo.example.test/api/v1/user',
    {},
    500,
    resolvePublic,
  )).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
});

test('Forgejo probe validates and follows only a bounded same-origin redirect', async () => {
  const fetchImpl = jest.fn()
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: '/api/v1/user/' } }))
    .mockResolvedValueOnce(new Response('{"id":1}', { status: 200 }));
  const response = await fetchForgejoWithTimeout(
    fetchImpl as unknown as typeof fetch,
    'https://forgejo.example.test/api/v1/user',
    {},
    500,
    resolvePublic,
  );
  expect(await response.json()).toEqual({ id: 1 });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fetchImpl.mock.calls[1][0]).toBe('https://forgejo.example.test/api/v1/user/');
});

test('Forgejo bounded transport preserves mutation method and body without redirect replay', async () => {
  const fetchImpl = jest.fn(async () => new Response('{\"ok\":true}', { status: 201 })) as unknown as typeof fetch;
  await fetchForgejoWithTimeout(
    fetchImpl,
    'https://forgejo.example.test/api/v1/repos/acme/widgets/statuses/abc',
    { method: 'POST', headers: { Authorization: 'token redacted' }, body: '{\"state\":\"success\"}' },
    500,
    resolvePublic,
  );
  expect(fetchImpl).toHaveBeenCalledWith(
    'https://forgejo.example.test/api/v1/repos/acme/widgets/statuses/abc',
    expect.objectContaining({ method: 'POST', body: '{\"state\":\"success\"}', redirect: 'manual' }),
  );
});
