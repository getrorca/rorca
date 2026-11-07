/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const filename = '20260726180000_pipeline_run_closeout_reconciliation.sql';
const remediationFilename = '20260726233000_closeout_reconciliation_authority_remediation.sql';
const migrationPath = path.resolve(__dirname, '..', 'pg-migrations', filename);
const remediationPath = path.resolve(__dirname, '..', 'pg-migrations', remediationFilename);
const sql = fs.readFileSync(migrationPath, 'utf8');
const remediationSql = fs.readFileSync(remediationPath, 'utf8');
const attemptSql = fs.readFileSync(path.resolve(__dirname, '..', 'pg-migrations', '20260727121000_host_story_attempt_envelopes.sql'), 'utf8');
const isolatedEventSql = fs.readFileSync(path.resolve(__dirname, '..', 'pg-migrations', '20260727122000_isolated_closeout_reconciliation_events.sql'), 'utf8');
const transportSql = fs.readFileSync(path.resolve(__dirname, '..', 'pg-migrations', '20260727123000_closeout_transport_generations.sql'), 'utf8');
const remediation3Sql = fs.readFileSync(path.resolve(__dirname, '..', 'pg-migrations', '20260727125000_wave1_authority_remediation3.sql'), 'utf8');
const remediation4Sql = fs.readFileSync(path.resolve(__dirname, '..', 'pg-migrations', '20260727126000_wave1_authority_remediation4.sql'), 'utf8');
const remediation5Sql = fs.readFileSync(path.resolve(__dirname, '..', 'pg-migrations', '20260727127000_wave1_authority_remediation5.sql'), 'utf8');

test('adds exact owner-authorized application authority without touching pg-boss tables', () => {
  expect(sql).toContain("'run_closeout_reconciliation'");
  expect(sql).toContain('workspace_owner_verified');
  expect(sql).toContain('CREATE TABLE IF NOT EXISTS pipeline_run_closeout_reconciliations');
  expect(sql).toContain('run_id BIGINT NOT NULL UNIQUE');
  expect(sql).toContain('run_id = 20260316000550 AND run_id <> 20260316000549');
  expect(sql.indexOf('IF NEW.run_id = 20260316000549')).toBeLessThan(sql.indexOf('SELECT * INTO receipt'));
  expect(sql).toContain('preview is expired at database time');
  expect(sql).toContain('UNIQUE (workspace_id, idempotency_key)');
  expect(sql).toContain('owner_receipt_id UUID NOT NULL UNIQUE');
  expect(sql).toContain("state IN ('prepared','queued','processing','completed','blocked')");
  expect(sql).toContain('before_projection JSONB NOT NULL');
  expect(sql).toContain('result_receipt_hash TEXT UNIQUE');
  expect(sql).toContain("receipt.purpose <> 'run_closeout_reconciliation'");
  expect(sql).toContain('receipt.actor_id = NEW.requester_actor_id');
  expect(sql).toContain('NOT (receipt.requester_actor_id IS NOT DISTINCT FROM NEW.requester_actor_id)');
  expect(sql).toContain('build_receipt_hash TEXT NOT NULL');
  expect(sql).toContain('NEW.build_receipt_hash');
  expect(sql).toContain('closeout reconciliation authority is append-only');
  expect(sql).not.toMatch(/\b(?:CREATE|ALTER|DROP|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+pgboss\./i);
});

test('migration remains ordered after all authority prerequisites', () => {
  const names = fs.readdirSync(path.dirname(migrationPath)).filter((name) => name.endsWith('.sql')).sort();
  expect(names.indexOf(filename)).toBeGreaterThan(names.indexOf('20260722201500_task_manifest_provider_human_authority.sql'));
  expect(names.indexOf(filename)).toBeGreaterThan(names.indexOf('20260724070000_spec_versions_workspace_authority.sql'));
  expect(names.indexOf(remediationFilename)).toBeGreaterThan(names.indexOf(filename));
});

test('host attempt and isolated reconciliation migrations preserve immutable authority without ordinary release events', () => {
  expect(attemptSql).toContain('CREATE TABLE IF NOT EXISTS host_story_attempt_envelopes');
  expect(attemptSql).toContain('launch_generation UUID NOT NULL');
  expect(attemptSql).toContain('cancellation_fence TEXT NOT NULL');
  expect(attemptSql).toContain('canonical_spec_path TEXT NOT NULL');
  expect(attemptSql).toContain('repository_identity TEXT NOT NULL');
  expect(attemptSql).toContain('worktree_identity TEXT NOT NULL');
  expect(attemptSql).toContain('host_story_attempt_conflicts');
  expect(attemptSql).toContain('UNIQUE (workspace_id, run_id, story_id, attempt)');
  expect(attemptSql).toContain('trg_story_closeout_requires_host_attempt');
  expect(attemptSql).toContain("pg_advisory_xact_lock(hashtextextended('pipeline-run-authority:' || NEW.run_id::text, 0))");
  expect(attemptSql).toContain("envelope.outcome = 'success'");
  expect(isolatedEventSql).toContain("event_type TEXT NOT NULL CHECK (event_type = 'run_closeout_reconciled')");
  expect(isolatedEventSql).toContain("source TEXT NOT NULL CHECK (source = 'closeout_reconciliation')");
  expect(isolatedEventSql).not.toContain("event_type = 'run_finished'");
  expect(transportSql).toContain('transport_generation INTEGER NOT NULL DEFAULT 1');
  expect(remediation3Sql).toContain('canonical_spec_bytes_hash');
  expect(remediation3Sql).toContain('run_spec_bytes_hash');
  expect(remediation3Sql).toContain('first_provider_launch_verified_at');
  expect(remediation3Sql).toContain('pipeline_run_release_intents');
  expect(remediation3Sql).toContain('dispatch_fence');
  expect(remediation4Sql).toContain('canonical_spec_revision');
  expect(remediation4Sql).toContain('expected_git_sha');
  expect(remediation4Sql).toContain('expected_git_branch');
  expect(remediation5Sql).toContain('host_story_attempt_envelopes_complete_success_authority_check');
  expect(remediation5Sql).toContain('canonical_spec_bytes_hash IS NOT NULL');
  expect(remediation5Sql).toContain('NEW.canonical_spec_revision');
  expect(remediation5Sql).toContain('NEW.expected_git_branch');
  expect(remediation5Sql).toContain('host attempt conflict evidence is append-only');
  expect(remediation5Sql).toContain('envelope.observed_git_sha = envelope.expected_git_sha');
  for (const migration of [attemptSql, isolatedEventSql, transportSql, remediation3Sql, remediation4Sql, remediation5Sql]) {
    expect(migration).not.toMatch(/\b(?:CREATE|ALTER|DROP|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+pgboss\./i);
  }
});

test('follow-up remediation upgrades provisioned candidate databases without weakening null-safe requester binding', () => {
  expect(remediationSql).toContain('ADD COLUMN IF NOT EXISTS build_receipt_hash');
  expect(remediationSql).toContain('NOT (receipt.requester_actor_id IS NOT DISTINCT FROM NEW.requester_actor_id)');
  expect(remediationSql).toContain('NEW.build_receipt_hash IS NULL');
  expect(remediationSql).toContain('NEW.build_receipt_hash !~');
  expect(remediationSql).toContain('NEW.build_receipt_hash,');
  expect(remediationSql).toContain('run_id = 20260316000550 AND run_id <> 20260316000549');
  expect(remediationSql.indexOf('IF NEW.run_id = 20260316000549'))
    .toBeLessThan(remediationSql.indexOf('SELECT * INTO receipt'));
  expect(remediationSql).not.toMatch(/\b(?:CREATE|ALTER|DROP|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+pgboss\./i);
});
