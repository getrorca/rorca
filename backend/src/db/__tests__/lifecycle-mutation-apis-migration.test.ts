/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const migration = fs.readFileSync(
  path.resolve(__dirname, '..', 'pg-migrations', '20260715190000_lifecycle_mutation_apis.sql'),
  'utf8',
);

describe('LFC-014 lifecycle mutation migration', () => {
  test('persists bounded replay identity and completed response state', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS lifecycle_mutation_requests');
    expect(migration).toContain('UNIQUE (workspace_id, operation, idempotency_key)');
    expect(migration).toContain("status IN ('pending', 'completed')");
    expect(migration).toContain('request_hash ~');
    expect(migration).toContain('response_body JSONB');
  });

  test('adds retry expiry/idempotency without hand-managing pg-boss', () => {
    expect(migration).toContain('preview_identity_hash');
    expect(migration).toContain('expires_at TIMESTAMPTZ');
    expect(migration).toContain('idx_pipeline_retry_preview_idempotency');
    expect(migration).not.toMatch(/CREATE\s+(?:TABLE|INDEX)[\s\S]*pgboss\./i);
  });
});
