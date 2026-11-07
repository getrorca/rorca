// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  PG_BOSS_INTEGRATION_SUITE_NAMES,
  pgBossTestSchema,
} from './pg-boss-test-schema';

describe('pgBossTestSchema', () => {
  it('keeps the preinstalled integration schema set closed', () => {
    expect(PG_BOSS_INTEGRATION_SUITE_NAMES).toEqual([
      'cancel',
      'concurrency',
      'dlq',
      'integration',
      'load',
      'restart',
      'scheduler',
      'zero_downtime',
    ]);
    expect(() => pgBossTestSchema('uninstalled')).toThrow(
      'Unprovisioned pg-boss integration suite schema suffix: uninstalled',
    );
  });
});
