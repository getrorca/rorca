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
  '20260727128000_provider_neutral_local_review_bundles.sql',
), 'utf8');
const remediation = fs.readFileSync(path.resolve(
  __dirname,
  '..',
  'pg-migrations',
  '20260727129000_local_review_bundle_final_remediation.sql',
), 'utf8');
const maintenance = fs.readFileSync(path.resolve(
  __dirname,
  '..',
  'pg-migrations',
  '20260729130000_local_review_projection_non_destructive_maintenance.sql',
), 'utf8');

test('migration makes bundle and changed-replay evidence append-only under exact host authority', () => {
  expect(migration).toContain('CREATE TABLE IF NOT EXISTS local_review_bundles');
  expect(migration).toContain('CREATE TABLE IF NOT EXISTS local_review_bundle_conflicts');
  expect(migration).toContain('REFERENCES host_story_attempt_envelopes(envelope_id) ON DELETE RESTRICT');
  expect(migration).toContain('BEFORE INSERT ON local_review_bundles');
  expect(migration).toContain('BEFORE UPDATE OR DELETE ON local_review_bundles');
  expect(migration).toContain('BEFORE UPDATE OR DELETE ON local_review_bundle_conflicts');
  expect(migration).toContain("reason_code = 'changed_replay'");
  expect(migration).toContain('host_story_attempt_conflicts');
  expect(migration).toContain('pipeline_run_cancellation_requests');
  expect(migration).toContain('run.dispatch_fence = envelope.cancellation_fence');
  expect(migration).toContain('result.result_provenance = \'host\'');
  expect(migration).toContain('result.result_source = \'execution-engine\'');
});

test('database contract encodes content addressing, bounded metadata, and explicit no-merge/no-deploy', () => {
  expect(migration).toContain("content_hash TEXT NOT NULL UNIQUE");
  expect(migration).toContain("projection_key ~ '^sha256/");
  expect(migration).toContain("projection_key = ('sha256/'");
  expect(migration).toContain("manifest_json ?& ARRAY['schemaVersion'");
  expect(migration).toContain(') IS TRUE),');
  expect(migration).toContain('octet_length(manifest_json::text) <= 262144');
  expect(migration).toContain("merge_status TEXT NOT NULL CHECK (merge_status = 'not_authorized')");
  expect(migration).toContain("deployment_status TEXT NOT NULL CHECK (deployment_status = 'not_authorized')");
  expect(migration).toContain("manifest_json#>>'{validation,processExitAcceptedAsPass}' = 'false'");
  expect(migration).toContain("manifest_json#>>'{delivery,mergeAuthority}' = 'none'");
  expect(migration).toContain("manifest_json#>>'{delivery,deploymentAuthority}' = 'none'");
  expect(migration).not.toMatch(/pgboss\./);
});

test('final remediation makes SQL validation, races, hashes, audits, and truncate fail closed', () => {
  expect(remediation).toContain('local_review_manifest_is_complete');
  expect(remediation).toContain('jsonb_typeof(candidate');
  expect(remediation).toContain('local_review_safe_relative_path');
  expect(remediation).toContain("digest(NEW.request_bytes, 'sha256')");
  expect(remediation).toContain("digest(NEW.content_basis_bytes, 'sha256')");
  expect(remediation).toContain("digest(NEW.manifest_bytes, 'sha256')");
  expect(remediation).toContain('local_review_bundle_exact_pass_authority');
  expect(remediation).toContain('result.spec_id IS NOT DISTINCT FROM envelope.spec_id');
  expect(remediation).toContain('result.manifest_hash IS NOT DISTINCT FROM envelope.manifest_hash');
  expect(remediation).toContain("result.commit_observed_source = 'worktree_branch'");
  expect(remediation).toContain('local_review_bundle_disqualifications');
  expect(remediation).toContain('pipeline-run-authority:');
  expect(remediation).toContain('BEFORE TRUNCATE');
  expect(remediation).toContain('local_review_projection_gc_audits');
  expect(remediation).toContain('local_review_projection_gc_actions');
  expect(remediation).toContain('local_review_jsonb_has_exact_keys');
  expect(remediation).toContain('local_review_request_matches');
  expect(remediation).toContain('run.run_spec_bytes_hash IS NOT DISTINCT FROM envelope.run_spec_bytes_hash');
  expect(remediation).not.toMatch(/^(?:BEGIN|COMMIT);$/m);
  expect(remediation).not.toMatch(/pgboss\./);
});

test('restart maintenance ledger is explicit, non-destructive, and staging-safe', () => {
  expect(maintenance).toContain("projection_key ~ '^staging/sha256/[0-9a-f]{64}$'");
  expect(maintenance).toContain("'retained','operator_maintenance_required'");
  expect(maintenance).toContain("'automatic_deletion_unsupported'");
  expect(maintenance).toContain("'staging_restart_recovery'");
  expect(maintenance).toContain("'prior_action_outcome_indeterminate'");
  expect(maintenance).toContain('never an absolute or attacker-controlled filesystem path');
  expect(maintenance).not.toMatch(/^(?:BEGIN|COMMIT);$/m);
  expect(maintenance).not.toMatch(/pgboss\./);
});
