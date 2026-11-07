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
  '../pg-migrations/20260823090200_browser_session_broker_leases.sql',
), 'utf8');

describe('browser session broker grant and lease migration', () => {
  it('binds immutable grants and leases to the complete authority scope without profile material', () => {
    expect(migration).toContain('CREATE TABLE rorca.authority_provider_grants');
    for (const binding of [
      'binding_id UUID NOT NULL',
      'workspace_id TEXT NOT NULL',
      'external_provider TEXT NOT NULL',
      'run_id TEXT NOT NULL',
      'story_id TEXT NOT NULL',
      'purpose TEXT NOT NULL',
      'profile_generation INTEGER NOT NULL',
      'allowed_origins TEXT[] NOT NULL',
      'allowed_actions TEXT[] NOT NULL',
      'maximum_concurrent_runners INTEGER NOT NULL',
      'evidence_contract JSONB NOT NULL',
      'retention_mode TEXT NOT NULL',
      'destruction_policy TEXT NOT NULL',
    ]) expect(migration).toContain(binding);
    expect(migration).not.toMatch(/profile_(?:bytes|path|data|blob|ciphertext)|cookie\s+(?:TEXT|BYTEA|JSONB)/i);
  });

  it('persists provisioning, active, uncertain, terminal, heartbeat, and concurrency fences', () => {
    expect(migration).toContain("state IN ('provisioning', 'active', 'revoked', 'expired', 'uncertain')");
    expect(migration).toContain('last_heartbeat_at TIMESTAMPTZ');
    expect(migration).toContain('maximum_concurrent_runners BETWEEN 1 AND 16');
    expect(migration).toContain('authority_provider_leases_heartbeat_idx');
    expect(migration).toContain('authority_provider_leases_runner_identity_idx');
    expect(migration).toContain("OLD.state = 'uncertain' AND NEW.state NOT IN ('uncertain', 'revoked')");
    expect(migration).toContain('Browser authority lease bindings and policy are immutable');
  });

  it('records redacted denial and reconciliation evidence and revokes every open state on profile lifecycle changes', () => {
    expect(migration).toContain("'browser_security_denied'");
    expect(migration).toContain("'browser_lease_uncertain'");
    expect(migration).toContain("'browser_lease_reconciled'");
    expect(migration).toContain("state IN ('provisioning', 'active', 'uncertain')");
    expect(migration).toContain("revocation_reason = 'profile_' || NEW.lifecycle_state");
    expect(migration).toContain("'secretMaterial', '[redacted]'");
  });

  it('retains grants and leases and grants only the runtime principal access', () => {
    expect(migration).toContain('hard deletion is forbidden');
    expect(migration).toContain('REVOKE ALL ON TABLE rorca.authority_provider_grants FROM PUBLIC');
    expect(migration).toContain('GRANT SELECT,INSERT,UPDATE ON rorca.authority_provider_grants');
    expect(migration).not.toContain('GRANT DELETE ON rorca.authority_provider_grants');
    expect(migration).not.toMatch(/pgboss\./i);
  });
});
