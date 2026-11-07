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
  '../pg-migrations/20260821090300_browser_session_broker_profiles.sql',
), 'utf8');

describe('browser session broker profile persistence migration', () => {
  it('stores a metadata-only core ProviderBinding with an opaque SecretStore reference', () => {
    expect(migration).toContain('CREATE TABLE rorca.browser_profile_bindings');
    expect(migration).toContain('profile_secret_ref UUID');
    expect(migration).toContain('external_provider TEXT NOT NULL');
    expect(migration).toContain('account_alias TEXT NOT NULL');
    expect(migration).toContain('allowed_origins TEXT[] NOT NULL');
    expect(migration).toContain('profile_generation INTEGER NOT NULL');
    expect(migration).toContain('retention_mode TEXT NOT NULL');
    expect(migration).toContain('provider_health TEXT NOT NULL');
    expect(migration).toContain('session_health TEXT NOT NULL');
    expect(migration).toContain('enrollment_provenance JSONB NOT NULL');
    expect(migration).not.toMatch(/profile_(?:bytes|data|blob|ciphertext)|encrypted_profile|customer_id/i);
    expect(migration).not.toMatch(/(?:password|cookie|totp_seed|passkey_private|recovery_code)\s+(?:TEXT|BYTEA|JSONB)/i);
  });

  it('makes provider, account, workspace, origin policy, retention, and provenance immutable', () => {
    expect(migration).toContain('CREATE UNIQUE INDEX browser_profile_bindings_identity_idx');
    expect(migration).toContain('(external_provider, lower(account_alias))');
    for (const immutableField of [
      'NEW.workspace_id <> OLD.workspace_id',
      'NEW.external_provider <> OLD.external_provider',
      'NEW.account_alias <> OLD.account_alias',
      'NEW.allowed_origins <> OLD.allowed_origins',
      'NEW.retention_mode <> OLD.retention_mode',
      'NEW.enrollment_provenance <> OLD.enrollment_provenance',
    ]) expect(migration).toContain(immutableField);
  });

  it('atomically revokes active leases and appends redacted lifecycle evidence', () => {
    expect(migration).toContain('CREATE TABLE rorca.authority_provider_leases');
    expect(migration).toMatch(/UPDATE rorca\.authority_provider_leases[\s\S]+SET state = 'revoked'/);
    expect(migration).toContain("NEW.lifecycle_state NOT IN ('quarantined', 'deleted')");
    expect(migration).toContain('INSERT INTO rorca.authority_provider_receipts');
    expect(migration).toContain("'secretMaterial', '[redacted]'");
    expect(migration).toContain("rorca.digest(convert_to(lifecycle_evidence::text, 'UTF8'), 'sha256')");
    expect(migration).toContain('Provider authority receipts are append-only');
    expect(migration).toContain('hard deletion is forbidden');
  });

  it('leaves pg-boss application-managed and grants no profile storage to PUBLIC', () => {
    expect(migration).not.toMatch(/pgboss\./i);
    expect(migration).toContain('REVOKE ALL ON TABLE rorca.browser_profile_bindings FROM PUBLIC');
    expect(migration).toContain('GRANT SELECT,INSERT,UPDATE ON rorca.browser_profile_bindings');
    expect(migration).not.toContain('GRANT DELETE ON rorca.browser_profile_bindings');
  });
});
