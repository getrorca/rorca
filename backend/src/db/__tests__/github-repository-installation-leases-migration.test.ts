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
  '..',
  'pg-migrations',
  '20260823120200_github_repository_installation_leases.sql',
), 'utf8');

test('binding authority changes advance a database-managed generation fence', () => {
  expect(migration).toContain('ADD COLUMN IF NOT EXISTS binding_generation BIGINT NOT NULL DEFAULT 1');
  expect(migration).toContain('advance_github_app_binding_generation');
  expect(migration).toContain('NEW.binding_generation := OLD.binding_generation + 1');
  expect(migration).toContain("NEW.permissions IS DISTINCT FROM OLD.permissions");
  expect(migration).toContain("NEW.provider_profile_verified_at IS DISTINCT FROM OLD.provider_profile_verified_at");
  expect(migration).toContain("NEW.superseded_at IS DISTINCT FROM OLD.superseded_at");
});

test('lease rows contain only repository authority metadata and the reviewed permission ceiling', () => {
  expect(migration).toContain('CREATE TABLE IF NOT EXISTS provider_authority_leases');
  expect(migration).toContain('authority_grant_id UUID NOT NULL UNIQUE');
  expect(migration).toContain('provider_binding_id TEXT NOT NULL');
  expect(migration).toContain('repository_external_id TEXT NOT NULL');
  for (const capability of [
    'scm.repository.read',
    'scm.branch.write',
    'scm.pull_request.write',
    'scm.checks.read',
    'scm.review.request',
  ]) expect(migration).toContain(capability);
  expect(migration).toContain("permissions - ARRAY['metadata','contents','pull_requests','checks'] = '{}'::jsonb");
  expect(migration).toContain(`WHEN capabilities @> '["scm.branch.write"]'::jsonb THEN permissions ->> 'contents' = 'write'`);
  expect(migration).toContain(`WHEN capabilities @> '["scm.repository.read"]'::jsonb THEN permissions ->> 'contents' = 'read'`);
  expect(migration).toContain(`OR capabilities @> '["scm.review.request"]'::jsonb`);
  expect(migration).toContain(`WHEN capabilities @> '["scm.checks.read"]'::jsonb THEN permissions ->> 'checks' = 'read'`);
  expect(migration).not.toMatch(/installation_token|app_jwt|private_key|\bpat\b|ssh_key/i);
  expect(migration).not.toMatch(/pgboss\./);
});

test('lease settlement is bounded, audit-retained, and terminal facts are immutable', () => {
  expect(migration).toContain("state IN ('active', 'settled', 'reconciliation_required')");
  expect(migration).toContain("settlement_kind IN ('revoked','verified_expiry','revocation_failed')");
  expect(migration).toContain("expires_at <= minted_at + INTERVAL '2 hours'");
  expect(migration).toContain("IF OLD.state <> 'active' THEN");
  expect(migration).toContain('BEFORE UPDATE OR DELETE ON provider_authority_leases');
  expect(migration).toContain('BEFORE TRUNCATE ON provider_authority_leases');
  expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE provider_authority_leases FROM PUBLIC');
});
