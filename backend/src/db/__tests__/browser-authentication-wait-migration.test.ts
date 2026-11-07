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
  '../pg-migrations/20260824090000_browser_authentication_waits.sql',
), 'utf8');

describe('browser authentication wait migration', () => {
  it('binds exact lease/run/profile identity, typed states, redacted evidence, and separate expiry', () => {
    expect(migration).toContain('CREATE TABLE rorca.browser_authentication_requests');
    expect(migration).toContain('authority_provider_leases_authentication_identity_key');
    expect(migration).toContain('UNIQUE (id, binding_id, workspace_id, profile_generation)');
    for (const binding of [
      'lease_id UUID NOT NULL',
      'binding_id UUID NOT NULL',
      'workspace_id TEXT NOT NULL',
      'external_provider TEXT NOT NULL',
      'run_id TEXT NOT NULL',
      'story_id TEXT NOT NULL',
      'purpose TEXT NOT NULL',
      'profile_generation INTEGER NOT NULL',
      'step_type TEXT NOT NULL',
      'evidence JSONB NOT NULL',
      'takeover_checkpoint_digest TEXT NOT NULL',
      'authentication_expires_at TIMESTAMPTZ NOT NULL',
    ]) expect(migration).toContain(binding);
    expect(migration).toContain("'login_expired', 'consent', 'mfa', 'passkey', 'captcha'");
    expect(migration).toContain("'account_locked', 'provider_step_up', 'anti_automation'");
    expect(migration).not.toMatch(/profile_(?:bytes|path|data|blob|ciphertext)|recovery_endpoint|websocket_endpoint/i);
  });

  it('allows only health-revalidated one-shot resume and immutable terminal settlement', () => {
    expect(migration).toContain("state = 'RESUMED' AND disposition = 'resumed'");
    expect(migration).toContain("outcome_code = 'AUTHENTICATION_RESUMED'");
    expect(migration).toContain('resume_count BETWEEN 0 AND 1');
    expect(migration).toContain('Browser authentication completion requires health revalidation');
    expect(migration).toContain('Terminal browser authentication request state is immutable');
    expect(migration).toContain('browser_authentication_one_open_run_idx');
    for (const exactOutcome of [
      "state = 'CANCELLED' AND disposition = 'terminal'",
      "outcome_code = 'AUTHENTICATION_CANCELLED'",
      "state = 'DENIED' AND disposition = 'terminal'",
      "outcome_code = 'AUTHENTICATION_DENIED'",
      "state = 'EXPIRED' AND disposition = 'retryable'",
      "outcome_code = 'AUTHENTICATION_EXPIRED'",
      "state = 'UNHEALTHY' AND disposition = 'retryable'",
      "outcome_code = 'AUTHENTICATION_UNHEALTHY'",
      "state = 'POLICY_PROHIBITED' AND disposition = 'terminal'",
      "outcome_code = 'AUTHENTICATION_POLICY_PROHIBITED'",
    ]) expect(migration).toContain(exactOutcome);
    expect(migration).toContain("resolution_observation->>'challengePresent' = 'false'");
    expect(migration).toContain("resolution_observation->'health'->>'provider' = 'healthy'");
    expect(migration).toContain("resolution_observation->'health'->>'session' = 'healthy'");
  });

  it('retains requests and redacted receipts under runtime-principal-only access', () => {
    expect(migration).toContain('hard deletion is forbidden');
    expect(migration).toContain("'browser_authentication_requested'");
    expect(migration).toContain("'browser_authentication_revalidating'");
    expect(migration).toContain("'browser_authentication_resumed'");
    expect(migration).toContain("'browser_authentication_terminal'");
    expect(migration).toContain('REVOKE ALL ON TABLE rorca.browser_authentication_requests FROM PUBLIC');
    expect(migration).toContain('GRANT SELECT,INSERT,UPDATE ON rorca.browser_authentication_requests');
    expect(migration).not.toContain('GRANT DELETE ON rorca.browser_authentication_requests');
    expect(migration).not.toMatch(/pgboss\./i);
  });
});
