/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'fs';
import path from 'path';

describe('bounty feature policy migration', () => {
  test('persists one revisioned admin policy and immutable audit history outside pgboss', () => {
    const sql = fs.readFileSync(path.join(
      __dirname,
      '../../db/pg-migrations/20260730120000_bounty_feature_policy.sql',
    ), 'utf8');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS bounty_feature_policy');
    expect(sql).toContain('CHECK (mission_mode = \'bounty\')');
    expect(sql).toContain('bounty_feature_policy_audit_immutable');
    expect(sql).not.toContain('pgboss.');
  });
});
