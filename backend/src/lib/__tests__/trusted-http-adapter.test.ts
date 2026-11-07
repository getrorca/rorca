/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';
import { admitProgramPolicy } from '../bounty-scope';
import { trustedHttpRequest, type TrustedHttpDependencies, type TrustedHttpTransportResponse } from '../trusted-http-adapter';

const hash = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const policy = () => admitProgramPolicy({
  workspaceId: 'w', programId: 'p', effectiveFrom: '2026-01-01T00:00:00Z', generation: 1,
  sources: [{ sourceId: 's', bytes: 'terms', claimedHash: hash('terms') }],
  assertion: { assertionId: 'a', humanId: 'h', authenticatedAt: '2026-01-01T00:00:00Z' },
  limits: { requestsPerMinute: 10, maximumDataBytes: 1024 },
  rules: [{ effect: 'allow', scheme: 'https', host: '*.target.example.com', path: '/', methods: ['GET', 'POST'], actions: ['observe'], accountRoles: ['scanner'] }],
});
const request = { workspaceId: 'w', programId: 'p', generation: 1, url: 'https://api.target.example.com/', method: 'GET', action: 'observe' as const, credentialRole: 'scanner' };
async function* chunks(...values: string[]) { for (const value of values) yield Buffer.from(value); }
const response = (overrides: Partial<TrustedHttpTransportResponse> = {}): TrustedHttpTransportResponse => ({ status: 200, headers: { 'content-length': '2' }, body: chunks('ok'), connectedAddress: '93.184.216.34', peerServername: 'api.target.example.com', ...overrides });
const deps = (overrides: Partial<TrustedHttpDependencies> = {}): TrustedHttpDependencies => ({
  resolve: async () => ({ canonicalNames: [], addresses: [{ address: '93.184.216.34', family: 4 }] }),
  send: async () => response(), ...overrides,
});

describe('trusted-host governed HTTP adapter', () => {
  test('pins one public answer and binds URL Host/SNI while returning bounded evidence', async () => {
    const send = jest.fn(async (r) => { expect(r).toMatchObject({ hostname: 'api.target.example.com', servername: 'api.target.example.com', pinnedAddress: '93.184.216.34' }); return response(); });
    const result = await trustedHttpRequest(policy(), request, deps({ send }));
    expect(result.body.toString()).toBe('ok'); expect(result.evidence[0]).toMatchObject({ outcome: 'response', bytes: 2 });
  });

  test.each([
    [{ canonicalNames: [], addresses: [{ address: '127.0.0.1', family: 4 as const }] }, /unsafe/],
    [{ canonicalNames: [], addresses: [{ address: '93.184.216.34', family: 4 as const }, { address: '169.254.169.254', family: 4 as const }] }, /mixed/],
    [{ canonicalNames: ['evil.test'], addresses: [{ address: '93.184.216.34', family: 4 as const }] }, /CNAME/],
  ])('rejects private, mixed and escaped CNAME DNS sets', async (answer, message) => {
    await expect(trustedHttpRequest(policy(), request, deps({ resolve: async () => answer }))).rejects.toThrow(message);
  });

  test('detects rebinding/SNI mismatch at the transport boundary', async () => {
    await expect(trustedHttpRequest(policy(), request, deps({ send: async () => response({ connectedAddress: '93.184.216.35' }) }))).rejects.toThrow(/authority mismatch/);
    await expect(trustedHttpRequest(policy(), request, deps({ send: async () => response({ peerServername: 'evil.test' }) }))).rejects.toThrow(/authority mismatch/);
  });

  test('forbids agent authority, proxy, cookie and framing headers', async () => {
    for (const name of ['Host', 'Proxy-Authorization', 'Forwarded', 'Cookie', 'Authorization', 'Transfer-Encoding', 'Connection']) {
      await expect(trustedHttpRequest(policy(), { ...request, headers: { [name]: 'x' } }, deps())).rejects.toThrow(/header/);
    }
  });

  test('reauthorizes redirects, strips typed credentials cross-origin, rejects downgrade and loops', async () => {
    let calls = 0;
    const send = jest.fn(async (r) => ++calls === 1
      ? response({ status: 302, headers: { location: 'https://other.target.example.com/' }, body: chunks(), connectedAddress: r.pinnedAddress, peerServername: r.servername })
      : response({ connectedAddress: r.pinnedAddress, peerServername: r.servername }));
    await trustedHttpRequest(policy(), { ...request, authorization: 'Bearer secret', cookie: 'sid=x' }, deps({ send }));
    expect(send.mock.calls[1][0].headers).not.toHaveProperty('authorization');
    await expect(trustedHttpRequest(policy(), request, deps({ send: async () => response({ status: 302, headers: { location: 'http://api.target.example.com/' }, body: chunks() }) }))).rejects.toThrow(/downgrade/);
    await expect(trustedHttpRequest(policy(), request, deps({ send: async () => response({ status: 302, headers: { location: '/' }, body: chunks() }) }))).rejects.toThrow(/loop/);
  });

  test('rejects smuggling ambiguity and decompression bombs before exposure', async () => {
    await expect(trustedHttpRequest(policy(), request, deps({ send: async () => response({ headers: { 'content-length': '2', 'transfer-encoding': 'chunked' } }) }))).rejects.toThrow(/smuggling/);
    await expect(trustedHttpRequest(policy(), request, deps({ send: async () => response({ headers: {}, body: chunks('bomb') }) }), { maxResponseBytes: 2 })).rejects.toThrow(/limit/);
  });

  test('propagates cancellation and never exposes a partial response', async () => {
    const controller = new AbortController();
    const promise = trustedHttpRequest(policy(), { ...request, signal: controller.signal }, deps({ resolve: async (_h, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))) }));
    controller.abort(); await expect(promise).rejects.toThrow(/cancelled/);
  });
});
