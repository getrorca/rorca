/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseBreakMarkers,
  resolveMarkersForChanges,
  type PublicRouteSnapshot,
} from '../index';

const oldHash = `sha256:${'a'.repeat(64)}`;
const newHash = `sha256:${'b'.repeat(64)}`;
const route = (hash: string): PublicRouteSnapshot => ({
  method: 'POST',
  path: '/api/example',
  parameters: [],
  responseSchema: {},
  hash,
});
const changes = {
  added: [], removed: [], downgraded: [],
  changed: [{ before: route(oldHash), after: route(newHash), reason: 'hash_changed' as const }],
};

test('legacy, stale-base, and wrong-hash markers cannot authorize an exact contract break', () => {
  const legacy = '<!-- contract-break: 2026-07-21 POST /api/example -->';
  const exact = `<!-- contract-break-v2: 2026-07-21 POST /api/example ${oldHash} ${newHash} -->`;
  const wrong = `<!-- contract-break-v2: 2026-07-21 POST /api/example sha256:${'c'.repeat(64)} ${newHash} -->`;
  const reference = new Date('2026-07-21T12:00:00Z');

  assert.deepEqual(resolveMarkersForChanges(changes, parseBreakMarkers(legacy), reference).uncovered, ['POST /api/example']);
  assert.deepEqual(resolveMarkersForChanges(changes, parseBreakMarkers(wrong), reference).uncovered, ['POST /api/example']);
  assert.deepEqual(
    resolveMarkersForChanges(changes, parseBreakMarkers(exact), reference, new Set([exact])).uncovered,
    ['POST /api/example'],
  );
  assert.deepEqual(resolveMarkersForChanges(changes, parseBreakMarkers(exact), reference), {
    covered: ['POST /api/example'], uncovered: [], expired: [],
  });
});

test('future and expired exact markers do not authorize a break', () => {
  const future = `<!-- contract-break-v2: 2026-07-22 POST /api/example ${oldHash} ${newHash} -->`;
  const expired = `<!-- contract-break-v2: 2026-06-01 POST /api/example ${oldHash} ${newHash} -->`;
  const reference = new Date('2026-07-21T12:00:00Z');
  assert.deepEqual(resolveMarkersForChanges(changes, parseBreakMarkers(future), reference).uncovered, ['POST /api/example']);
  assert.deepEqual(resolveMarkersForChanges(changes, parseBreakMarkers(expired), reference).expired, ['POST /api/example']);
});
