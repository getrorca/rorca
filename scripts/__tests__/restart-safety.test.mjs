// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRestartSafeHealth } from '../lib/restart-safety.mjs';

test('accepts only confirmed bounded readiness with numeric zero active runs', () => {
  assert.doesNotThrow(() => assertRestartSafeHealth({
    db_connected: true,
    readiness: { confirmed: true },
    active_runs: 0,
  }));
});

for (const [name, health] of [
  ['unreachable/invalid response', null],
  ['database unavailable', { db_connected: false, readiness: { confirmed: true }, active_runs: 0 }],
  ['readiness timeout', { db_connected: false, readiness: { confirmed: false }, active_runs: null }],
  ['missing bounded readiness', { db_connected: true, active_runs: 0 }],
  ['string zero', { db_connected: true, readiness: { confirmed: true }, active_runs: '0' }],
  ['unknown count', { db_connected: true, readiness: { confirmed: true }, active_runs: null }],
  ['active run', { db_connected: true, readiness: { confirmed: true }, active_runs: 1 }],
]) {
  test(`fails closed for ${name}`, () => {
    assert.throws(() => assertRestartSafeHealth(health));
  });
}
