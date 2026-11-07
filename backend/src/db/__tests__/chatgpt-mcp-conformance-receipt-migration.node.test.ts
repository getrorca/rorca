/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(path.resolve(
  directory,
  '../pg-migrations/20260824110000_chatgpt_mcp_conformance_receipt.sql',
), 'utf8');

describe('ChatGPT MCP conformance receipt migration', () => {
  it('admits both isolated consumer receipts without adding a secret-bearing store', () => {
    assert.match(migration, /'claude_mcp_conformance_completed'/);
    assert.match(migration, /'chatgpt_mcp_conformance_completed'/);
    assert.match(migration, /ALTER TABLE rorca\.authority_provider_receipts/);
    assert.doesNotMatch(
      migration,
      /CREATE TABLE|access_token\s+(?:TEXT|BYTEA)|refresh_token\s+(?:TEXT|BYTEA)|cookie\s+(?:TEXT|BYTEA)/i,
    );
    assert.doesNotMatch(migration, /Categoric|Cashflow-App|pgboss\./i);
  });
});
