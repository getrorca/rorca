/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  declareHermesAuthority,
  hermesAuthorityHeaders,
  parseHermesAuthority,
  requiredHermesAuthorityMode,
  requireHermesAction,
} from '../hermes-authority';

function requestWith(headers: Record<string, string>) {
  return { headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])) } as any;
}

describe('Hermes authority contract', () => {
  test.each([
    ['intent', 'service-audit'],
    ['persist', 'operator-dispatch'],
    ['subscription', 'service-audit'],
    ['watchdog', 'operator-dispatch'],
    ['dispatch', 'operator-dispatch'],
  ] as const)('declares and parses the %s cross-surface action', (action, mode) => {
    const declaration = declareHermesAuthority(action, mode);
    expect(parseHermesAuthority(requestWith(hermesAuthorityHeaders(declaration)))).toEqual(declaration);
  });

  test.each([
    ['persist', 'service-audit'],
    ['watchdog', 'service-audit'],
    ['dispatch', 'service-audit'],
    ['intent', 'operator-dispatch'],
    ['subscription', 'operator-dispatch'],
  ] as const)('denies mode escalation or downgrade for %s', (action, mode) => {
    expect(() => declareHermesAuthority(action, mode)).toThrow(/authority/);
  });

  test.each([
    ['intent', 'service-audit'],
    ['persist', 'operator-dispatch'],
    ['subscription', 'service-audit'],
    ['watchdog', 'operator-dispatch'],
    ['dispatch', 'operator-dispatch'],
  ] as const)('defines one shared required mode for the %s surface', (action, mode) => {
    expect(requiredHermesAuthorityMode(action)).toBe(mode);
  });

  test('denies missing declarations rather than inferring fallback authority', () => {
    expect(() => parseHermesAuthority(requestWith({}))).toThrow(/headers are required/);
  });

  test('binds the declared action and mode at the consuming surface', () => {
    const declaration = declareHermesAuthority('persist', 'operator-dispatch');
    expect(() => requireHermesAction(declaration, 'persist')).not.toThrow();
    expect(() => requireHermesAction(declaration, 'watchdog'))
      .toThrow(/does not permit this action/);
  });

  test('revalidates audit identity at every consuming surface', () => {
    const forged = {
      ...declareHermesAuthority('subscription', 'service-audit'),
      auditIdentity: 'local-admin@rorca.local',
    };
    expect(() => requireHermesAction(forged, 'subscription')).toThrow(/Invalid Hermes authority declaration/);
  });

  test('fails closed when the configured audit identity is blank', () => {
    const original = process.env.RORCA_HERMES_SERVICE_EMAIL;
    process.env.RORCA_HERMES_SERVICE_EMAIL = '   ';
    try {
      expect(() => declareHermesAuthority('intent', 'service-audit')).toThrow(/not configured/);
    } finally {
      if (original === undefined) delete process.env.RORCA_HERMES_SERVICE_EMAIL;
      else process.env.RORCA_HERMES_SERVICE_EMAIL = original;
    }
  });
});
