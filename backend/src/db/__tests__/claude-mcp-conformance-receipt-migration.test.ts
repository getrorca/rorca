/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(path.resolve(
  __dirname,
  '../pg-migrations/20260824100100_claude_mcp_conformance_receipt.sql',
), 'utf8');

describe('Claude MCP conformance receipt migration', () => {
  it('adds exactly the final append-only receipt event without a secret-bearing store', () => {
    expect(migration).toContain("'claude_mcp_conformance_completed'");
    expect(migration).toContain('ALTER TABLE rorca.authority_provider_receipts');
    expect(migration).not.toMatch(/CREATE TABLE|access_token\s+(?:TEXT|BYTEA)|refresh_token\s+(?:TEXT|BYTEA)|cookie\s+(?:TEXT|BYTEA)/i);
    expect(migration).not.toMatch(/pgboss\./i);
  });
});
