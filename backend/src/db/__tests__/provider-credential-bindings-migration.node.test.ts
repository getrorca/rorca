/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const migrationDirectory = path.join(__dirname, '..', 'pg-migrations');
const migrationName = '20260821090000_provider_credential_bindings.sql';
const migrationPath = path.join(migrationDirectory, migrationName);
const sql = readFileSync(migrationPath, 'utf8');

describe('provider credential binding migration', () => {
  it('uses a unique migration ledger version', () => {
    const matchingVersions = readdirSync(migrationDirectory)
      .filter((file) => file.startsWith('20260821090000_'));
    assert.deepEqual(matchingVersions, [migrationName]);
  });

  it('creates one provider-neutral core inventory with no credential value column', () => {
    assert.match(sql, /CREATE TABLE rorca\.provider_credential_bindings/);
    assert.doesNotMatch(sql, /CREATE TABLE[^;]*stripe/i);
    assert.doesNotMatch(sql, /\b(?:encrypted_)?(?:key|secret)_value\b/i);
    assert.match(sql, /secret_store_reference TEXT NOT NULL/);
    assert.match(sql, /fingerprint TEXT NOT NULL CHECK \(fingerprint ~ '\^sha256:/);
  });

  it('binds exact mode and credential class into immutable generation identity', () => {
    assert.match(sql, /mode TEXT NOT NULL CHECK \(mode IN \('test', 'live'\)\)/);
    assert.match(sql, /credential_class TEXT NOT NULL CHECK/);
    assert.match(sql, /binding_generation BIGINT NOT NULL CHECK \(binding_generation > 0\)/);
    assert.match(sql, /provider credential binding identity and generation are immutable/);
  });

  it('prevents references and fingerprints from being reused across modes or workspaces', () => {
    assert.match(sql, /UNIQUE \(provider, secret_store_reference\)/);
    assert.match(sql, /UNIQUE \(provider, target_binding_reference\)/);
    assert.match(sql, /UNIQUE \(provider, fingerprint\)/);
    assert.doesNotMatch(sql, /UNIQUE \(provider, mode, (?:secret_store_reference|target_binding_reference|fingerprint)\)/);
  });

  it('rejects secret-shaped values and keeps runtime access read-only', () => {
    assert.match(sql, /credential-shaped values are forbidden/);
    assert.match(sql, /\(\(sk\|rk\)_\(test\|live\)_/);
    assert.match(sql, /whsec_/);
    assert.match(sql, /GRANT SELECT ON TABLE rorca\.provider_credential_bindings TO %I', runtime_user/);
    assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE)[^;\n]*runtime_user/i);
  });
});
