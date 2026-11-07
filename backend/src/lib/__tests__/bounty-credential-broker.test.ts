/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { BountyCredentialBroker, FORBIDDEN_CREDENTIAL_ACTIONS, headersForRedirect } from '../bounty-credential-broker';

const binding = {
  workspaceId: 'ws-1', programId: '11111111-1111-4111-8111-111111111111',
  missionId: '22222222-2222-4222-8222-222222222222', accountId: 'acct-1', role: 'researcher',
  origin: 'https://target.example', actions: ['login', 'submit'], adapter: 'playwright-trusted', epoch: 1,
  expiresAt: '2099-01-01T00:00:00.000Z',
};

describe('BountyCredentialBroker', () => {
  test('returns only an opaque fully-bound handle and redeems on exact approved destination', () => {
    const broker = new BountyCredentialBroker();
    const issued = broker.issue(binding, { username: 'canary-user', password: 'CANARY_SECRET' });
    expect(issued).toMatchObject(binding);
    expect(JSON.stringify(issued)).not.toContain('CANARY_SECRET');
    expect(broker.redeem(issued.handle, { adapter: binding.adapter, origin: binding.origin, action: 'login', epoch: 1 }))
      .toEqual({ username: 'canary-user', password: 'CANARY_SECRET' });
    expect(() => broker.redeem(issued.handle, { adapter: binding.adapter, origin: 'https://evil.example', action: 'login', epoch: 1 })).toThrow();
  });

  test.each(FORBIDDEN_CREDENTIAL_ACTIONS)('keeps autonomous %s flow absent', (action) => {
    expect(() => new BountyCredentialBroker().issue({ ...binding, actions: [action] }, { token: 'CANARY_SECRET' })).toThrow();
  });

  test('opens a bounded hold and closes the browser partition after repeated login/CAPTCHA loops', async () => {
    const lifecycle = { holdMission: jest.fn(), closeBrowserPartition: jest.fn() };
    const broker = new BountyCredentialBroker(lifecycle);
    const { handle } = broker.issue(binding, { token: 'CANARY_SECRET' });
    expect(await broker.reportFailure(handle, 'login')).toEqual({ held: false });
    expect(await broker.reportFailure(handle, 'captcha')).toEqual({ held: false });
    expect(await broker.reportFailure(handle, 'login')).toEqual({ held: true });
    expect(lifecycle.holdMission).toHaveBeenCalledWith(expect.objectContaining({ missionId: binding.missionId }), 'auth_circuit_open');
    expect(lifecycle.closeBrowserPartition).toHaveBeenCalled();
    expect(() => broker.redeem(handle, { adapter: binding.adapter, origin: binding.origin, action: 'login', epoch: 1 })).toThrow();
  });

  test('revocation blocks use, closes partitions, and makes the prior epoch stale', async () => {
    const lifecycle = { holdMission: jest.fn(), closeBrowserPartition: jest.fn() };
    const broker = new BountyCredentialBroker(lifecycle);
    const { handle } = broker.issue(binding, { token: 'CANARY_SECRET' });
    await expect(broker.revoke(handle)).resolves.toEqual({ epoch: 2 });
    expect(lifecycle.closeBrowserPartition).toHaveBeenCalled();
    expect(() => broker.issue(binding, { token: 'new' })).toThrow('epoch is stale');
  });

  test('strips ambient credentials only on cross-origin redirects', () => {
    const headers = { Authorization: 'Bearer CANARY_SECRET', Cookie: 'session=CANARY_SECRET', 'X-Trace': 'ok' };
    expect(headersForRedirect(headers, 'https://target.example/a', 'https://other.example/b')).toEqual({ 'X-Trace': 'ok' });
    expect(headersForRedirect(headers, 'https://target.example/a', 'https://target.example/b')).toEqual(headers);
  });
});
