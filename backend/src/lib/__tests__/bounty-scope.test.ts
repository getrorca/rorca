/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';
import { admitProgramPolicy, authorizeObservation, normalizeHost, normalizeScopeRule } from '../bounty-scope';

const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const base = () => ({
  workspaceId: 'workspace-a', programId: 'program-a', effectiveFrom: '2026-01-01T00:00:00Z', generation: 4,
  sources: [{ sourceId: 'terms', bytes: 'immutable terms', claimedHash: hash('immutable terms') }],
  assertion: { assertionId: 'assertion-1', humanId: 'operator-1', authenticatedAt: '2026-01-01T00:00:00Z' },
  limits: { requestsPerMinute: 10, maximumDataBytes: 1024 },
  rules: [{ effect: 'allow' as const, scheme: 'https' as const, host: '*.api.example.com', path: '/v1', methods: ['GET'], actions: ['observe' as const] }],
});

describe('governed bounty scope admission', () => {
  test.each(['example.com.', 'éxample.com', '*.com', '*.co.uk', '127.1', '0177.0.0.1', '0x7f000001', '*.127.0.0.1'])(
    'rejects ambiguous IDNA, public-suffix wildcards, and alternate IP: %s', (host) => expect(() => normalizeHost(host)).toThrow(),
  );

  test.each(['/a%2fb', '/a%5Cb', '/a%2e%2e/b', '/a%20b', '\\admin'])(
    'rejects encoded separators and non-canonical paths: %s', (path) => expect(() => normalizeScopeRule({ ...base().rules[0], path })).toThrow(),
  );

  test('binds sources, identity, dates, normalized contract and revocable assertion', () => {
    const admitted = admitProgramPolicy(base());
    expect(admitted).toMatchObject({ status: 'admitted', workspaceId: 'workspace-a', programId: 'program-a', generation: 4 });
    expect(admitted.sourceHashes[0].hash).toBe(hash('immutable terms'));
    expect(admitted.contractHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(() => admitProgramPolicy({ ...base(), assertion: { ...base().assertion, revokedAt: '2026-02-01T00:00:00Z' } })).toThrow(/revoked/);
    expect(() => admitProgramPolicy({ ...base(), sources: [{ ...base().sources[0], bytes: 'changed' }] })).toThrow(/mismatch/);
  });

  test('contradictions and unresolved prose hold; deny overrides allow', () => {
    const rule = base().rules[0];
    expect(admitProgramPolicy({ ...base(), unresolvedProse: ['except reasonable use'] }).status).toBe('hold');
    const admission = admitProgramPolicy({ ...base(), rules: [rule, { ...rule, effect: 'deny' }] });
    expect(admission.status).toBe('hold');
    expect(authorizeObservation(admission, { workspaceId: 'workspace-a', programId: 'program-a', generation: 4, url: 'https://x.api.example.com/v1/users', method: 'GET', action: 'observe' })).toBe(false);
  });

  test('enforces boundaries, redirect/DNS rechecks, generations and cross-program isolation', () => {
    const admission = admitProgramPolicy(base());
    const request = { workspaceId: 'workspace-a', programId: 'program-a', generation: 4, url: 'https://x.api.example.com/v1/users', method: 'GET', action: 'observe' as const };
    expect(authorizeObservation(admission, request)).toBe(true);
    expect(authorizeObservation(admission, { ...request, url: 'https://x.api.example.com/v10' })).toBe(false);
    expect(authorizeObservation(admission, { ...request, url: 'https://api.example.com/v1' })).toBe(false);
    expect(authorizeObservation(admission, { ...request, url: 'https://x.api.example.com:444/v1' })).toBe(false);
    expect(authorizeObservation(admission, { ...request, programId: 'program-b' })).toBe(false);
    expect(authorizeObservation(admission, { ...request, generation: 5 })).toBe(false);
    expect(authorizeObservation(admission, request, [{ host: 'evil.example.net' }])).toBe(false);
    expect(authorizeObservation(admission, request, [{ host: 'y.api.example.com' }])).toBe(true);
    expect(authorizeObservation(admission, { ...request, url: 'https://user@x.api.example.com/v1' })).toBe(false);
  });
});
