/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260729131000_wave2_governed_mission_control_plane.sql'), 'utf8');
const alignment = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260729132000_wave2_evidence_subject_alignment.sql'), 'utf8');
const activationHeads = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260729133000_wave2_activation_revocation_heads.sql'), 'utf8');
const runtimeAlignment = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260729134000_wave2_runtime_event_contract_alignment.sql'), 'utf8');
const missionHashLineage = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260729135000_wave2_mission_hash_lineage.sql'), 'utf8');
const exactAttemptSubject = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260729136000_wave2_attempt_exact_subject.sql'), 'utf8');
const dispatchOutbox = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260729137000_wave2_continuation_dispatch_outbox.sql'), 'utf8');
const retrySubject = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260729138000_wave2_retry_subject_and_events.sql'), 'utf8');
const cancellationProposal = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260729139000_wave2_cancellation_proposal_state.sql'), 'utf8');
const retirementProjection = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260729140000_wave2_retirement_evidence_dispatch_projection.sql'), 'utf8');
const prerequisiteReceipt = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260729141000_wave2_prerequisite_receipt.sql'), 'utf8');
const managedExecutor = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260729142000_wave2_managed_executor_projection.sql'), 'utf8');
const semanticHardening = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260729143000_wave2_semantic_contract_hardening.sql'), 'utf8');
const forcedRls = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260729144000_wave2_force_rls_principal.sql'), 'utf8');
const canonicalAuthority = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260729145000_wave2_canonical_authority_obligations.sql'), 'utf8');
const dispatchSendAuthority = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260729146000_wave2_dispatch_send_authorization.sql'), 'utf8');
const forwardUpgrade = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260729147000_wave2_upgrade_retirement_and_sequence_scope.sql'), 'utf8');
const finalRemediation = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260729152000_wave2_final_review_remediation.sql'), 'utf8');
const rejectedShaRemediation = fs.readFileSync(path.resolve(__dirname, '../pg-migrations/20260731153000_wave2_9ff4_authority_remediation.sql'), 'utf8');
const xhighStabilization=fs.readFileSync(path.resolve(__dirname,'../pg-migrations/20260731154000_wave2_xhigh_authority_stabilization.sql'),'utf8');
const lifecycleEvidenceWriter=fs.readFileSync(path.resolve(__dirname,'../pg-migrations/20260731156000_lifecycle_evidence_writer_capability.sql'),'utf8');
const migrationRunner = fs.readFileSync(path.resolve(__dirname, '../pg-index.ts'), 'utf8');
const databaseRuntime = fs.readFileSync(path.resolve(__dirname, '../index.ts'), 'utf8');
const specRoutes = fs.readFileSync(path.resolve(__dirname, '../../routes/specs.ts'), 'utf8');
const specWorker = fs.readFileSync(path.resolve(__dirname, '../../lib/spec-job-worker.ts'), 'utf8');
const specJobs=fs.readFileSync(path.resolve(__dirname,'../spec-jobs.ts'),'utf8');
const pgBossInstaller=fs.readFileSync(path.resolve(__dirname,'../pg-boss-install.ts'),'utf8');
const productionCompose=fs.readFileSync(path.resolve(__dirname,'../../../../docker-compose.yml'),'utf8');
const composeSmoke=fs.readFileSync(path.resolve(__dirname,'../../../../scripts/wave2-compose-empty-volume-smoke.sh'),'utf8');
const roleBootstrap=fs.readFileSync(path.resolve(__dirname,'../../../../docker/postgres/bootstrap-roles.sh'),'utf8');
const splitOwnerUpgrade=fs.readFileSync(path.resolve(__dirname,'../../../../docker/postgres/upgrade-split-owner.sql'),'utf8');
const productionEnv=fs.readFileSync(path.resolve(__dirname,'../../../../deploy/env.production.example'),'utf8');

test('Wave 2 authority migration is forward-only, transaction-runner owned, and never manages pg-boss', () => {
  expect(migration).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  expect(migration).not.toMatch(/pgboss\s*\./i);
  expect(migration).toContain('20260729131000');
  expect(migration).toContain("state IN ('ready','disabled','superseded')");
});

test.each([
  'governed_missions', 'governed_mission_versions', 'governed_work_package_revisions', 'execution_lease_slots',
  'execution_leases', 'context_policy_definitions', 'context_policy_activations', 'context_checkpoints',
  'context_retrieval_receipts', 'context_bundles', 'context_bundle_deltas', 'continuation_retry_budgets',
  'continuation_dispatches', 'continuation_dispatch_consumptions', 'runtime_events', 'governed_closeout_evaluations',
  'execution_cancellation_requests', 'execution_cancellation_acknowledgements', 'plan_change_proposals',
  'mission_control_idempotency', 'mission_control_audit', 'context_epoch_projection_reads',
  'context_epoch_write_rejections', 'context_epoch_retirement_evaluations',
])('creates canonical table %s', (table) => {
  expect(migration).toContain(`CREATE TABLE rorca.${table}`);
});

test('migration enforces composite workspace lineage, CAS heads, fences, one-use dispatch, immutable ledgers, RLS, and bounded payloads', () => {
  expect(migration).toContain('state_version BIGINT');
  expect(migration).toContain('fencing_token BIGINT');
  expect(migration).toContain('execution_leases_one_active_slot');
  expect(migration).toContain('UNIQUE(workspace_id,continuation_key)');
  expect(migration).toContain('w2_reject_immutable_mutation');
  expect(migration).toContain('BEFORE TRUNCATE');
  expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
  expect(migration).toContain('serialized_bytes BETWEEN 1 AND 4194304');
  expect(migration).toContain("payload_json ? 'requiredContext' AND payload_json ? 'advisoryMemory'");
});

test('ContextEpoch is telemetry/projection-only and secret/epoch writes are constrained', () => {
  expect(migration).not.toMatch(/CREATE TABLE rorca\.context_epochs?\b/i);
  expect(migration).toContain("payload_json::text !~* 'context.?epoch|legacy.?epoch'");
  expect(migration).toContain("reason_code TEXT NOT NULL DEFAULT 'deprecated_context_epoch_write'");
  expect(migration).toContain('eligible = (release_gate_passed AND age_gate_passed AND zero_use_gate_passed');
});

test('canonical evidence is extended rather than replaced and closeout proposal cannot become a second authority', () => {
  expect(migration).toContain('ALTER TABLE rorca.ssdlc_lifecycle_evidence');
  expect(migration).toContain("governed_contract_id='rorca.evidence-envelope.v1'");
  expect(migration).toContain('only existing StoryCloseoutDecision.accepted establishes story completion');
  expect(migration).not.toMatch(/CREATE TABLE rorca\.story_closeout_decisions/i);
  for (const column of ['governed_spec_id', 'governed_spec_version', 'governed_spec_hash', 'governed_story_id',
    'governed_story_version', 'governed_story_hash']) expect(alignment).toContain(column);
  expect(alignment).toContain('DROP CONSTRAINT ssdlc_wave2_complete_subject_ck');
});

test('alignment migration persists bounded replay responses and advances readiness to the exact generated digest', () => {
  expect(alignment).toContain('ADD COLUMN response_json JSONB');
  expect(alignment).toContain('mission_control_idempotency_response_bound_ck');
  expect(alignment).toContain('sha256:4fb7606213db1f78df5e61829bfb6561a800088169b225d9e1262f7ab2de7b6f');
  expect(alignment).toContain('migration_version=20260729132000');
  expect(alignment).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test('activation revocation uses a mutable CAS head over immutable activation revisions', () => {
  expect(activationHeads).toContain('CREATE TABLE rorca.context_policy_activation_heads');
  expect(activationHeads).toContain('state_version BIGINT');
  expect(activationHeads).toContain('DROP INDEX IF EXISTS rorca.context_policy_one_active_scope');
  expect(activationHeads).toContain('migration_version=20260729133000');
  expect(activationHeads).toContain('ENABLE ROW LEVEL SECURITY');
  expect(activationHeads).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test('runtime event contract alignment advances only from the exact prior readiness identity', () => {
  expect(runtimeAlignment).toContain('migration_version=20260729134000');
  expect(runtimeAlignment).toContain('sha256:b06bd5bdd4d999879d14a548b29c91ddd09cc702c280d6fa651cccc0baeeddb2');
  expect(runtimeAlignment).toContain('migration_version=20260729133000');
  expect(runtimeAlignment).toContain('sha256:4fb7606213db1f78df5e61829bfb6561a800088169b225d9e1262f7ab2de7b6f');
});

test('work packages have an exact composite FK to immutable mission revision and hash', () => {
  expect(missionHashLineage).toContain('governed_mission_versions_revision_hash_uq');
  expect(missionHashLineage).toContain('governed_work_package_mission_revision_hash_fk');
  expect(missionHashLineage).toContain('FOREIGN KEY(workspace_id,mission_id,mission_revision,mission_hash)');
  expect(missionHashLineage).toContain('migration_version=20260729135000');
  expect(missionHashLineage).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test('execution attempts persist exact spec, repository, Git and path-manifest subjects', () => {
  for (const column of ['spec_id', 'spec_hash', 'story_hash', 'criteria_manifest_hash', 'base_sha', 'current_sha',
    'expected_head_sha', 'allowed_path_manifest_hash', 'required_path_manifest_hash', 'changed_path_manifest_hash',
    'forbidden_path_manifest_hash']) expect(exactAttemptSubject).toContain(`ADD COLUMN ${column}`);
  expect(exactAttemptSubject).toContain('migration_version=20260729136000');
  expect(exactAttemptSubject).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test('continuation dispatch uses a fenced outbox and immutable transport outcomes', () => {
  expect(dispatchOutbox).toContain('CREATE TABLE rorca.continuation_dispatch_outbox');
  expect(dispatchOutbox).toContain('CREATE TABLE rorca.continuation_dispatch_outcomes');
  expect(dispatchOutbox).toContain("state IN('pending','claimed','sent','failed','unknown','quarantined')");
  expect(dispatchOutbox).toContain('continuation_dispatch_outcomes_immutable');
  expect(dispatchOutbox).toContain('migration_version=20260729137000');
  expect(dispatchOutbox).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test('retry budget binds exact canonical subject and immutable phase events', () => {
  expect(retrySubject).toContain('CREATE TABLE rorca.continuation_retry_events');
  for (const column of ['retry_budget_id', 'scope_key', 'attempt_id', 'lease_id', 'fencing_token', 'activation_hash',
    'checkpoint_hash', 'bundle_hash', 'payload_json']) expect(retrySubject).toContain(`ADD COLUMN ${column}`);
  expect(retrySubject).toContain('continuation_retry_events_immutable');
  expect(retrySubject).toContain('migration_version=20260729138000');
  expect(retrySubject).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test('cancellation has truthful derived state and proposals have lease-bound review CAS', () => {
  expect(cancellationProposal).toContain('CREATE VIEW rorca.execution_cancellation_effective_state');
  expect(cancellationProposal).toContain('request_row_immutable');
  expect(cancellationProposal).toContain('CREATE TABLE rorca.plan_change_proposal_reviews');
  expect(cancellationProposal).toContain('ADD COLUMN state_version');
  expect(cancellationProposal).toContain('migration_version=20260729139000');
  expect(cancellationProposal).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test('epoch retirement binds durable evidence and dispatches retain exact projection payloads', () => {
  expect(retirementProjection).toContain('CREATE TABLE rorca.context_epoch_retirement_evidence');
  expect(retirementProjection).toContain('CREATE TABLE rorca.context_epoch_retirement_review_decisions');
  expect(retirementProjection).toContain('ADD COLUMN dispatch_hash');
  expect(retirementProjection).toContain('ADD COLUMN payload_json');
  expect(retirementProjection).toContain('migration_version=20260729140000');
  expect(retirementProjection).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test('effective readiness fails closed until exact prerequisite receipt is durable', () => {
  expect(prerequisiteReceipt).toContain('CREATE TABLE rorca.wave2_prerequisite_receipts');
  expect(prerequisiteReceipt).toContain('CREATE VIEW rorca.wave2_effective_readiness');
  expect(prerequisiteReceipt).toContain("reason_code='prerequisite_receipt_missing'");
  expect(prerequisiteReceipt).toContain('migration_version=20260729141000');
  expect(prerequisiteReceipt).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test('managed executor emits immutable non-authoritative compatibility events', () => {
  expect(managedExecutor).toContain('CREATE TABLE rorca.managed_executor_compatibility_events');
  expect(managedExecutor).toContain("authoritative BOOLEAN NOT NULL CHECK(authoritative=FALSE)");
  expect(managedExecutor).toContain("execution_authority TEXT NOT NULL CHECK(execution_authority='none')");
  expect(managedExecutor).toContain('migration_version=20260729142000');
  expect(managedExecutor).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test('semantic token, expiry, deadline, and positive policy bounds are database-enforced', () => {
  expect(semanticHardening).toContain('context_policy_positive_limits_ck');
  expect(semanticHardening).toContain('context_receipt_token_sum_ck');
  expect(semanticHardening).toContain('context_bundle_token_sum_ck');
  expect(semanticHardening).toContain('cancellation_deadline_order_ck');
  expect(semanticHardening).toContain('sha256:ee4bb819784530868104f7f1a25e68d15105ca14ab8578d536055ade69992b2d');
  expect(semanticHardening).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test('workspace authority tables force RLS through an explicit workspace-bound database principal', () => {
  expect(forcedRls).toContain('CREATE TABLE rorca.wave2_database_principals');
  expect(forcedRls).toContain('FORCE ROW LEVEL SECURITY');
  expect(forcedRls).toContain("workspace_id=current_setting(''rorca.workspace_id'',TRUE)");
  expect(forcedRls).toContain('wave2_principal_migration_insert');
  expect(forcedRls).toContain('GRANT SELECT,INSERT,UPDATE,DELETE ON rorca.%I TO %I');
  expect(forcedRls).toContain('GRANT SELECT,INSERT,UPDATE ON rorca.ssdlc_lifecycle_evidence');
  expect(forcedRls).not.toContain('ON ALL SEQUENCES');
  expect(forcedRls).toContain("'mission_control_audit_id_seq'");
  expect(forcedRls).not.toContain("'context_epoch_retirement_evaluations'");
  expect(forwardUpgrade).toContain('context_epoch_retirement_evaluations_unscoped_legacy');
  expect(databaseRuntime).toContain('RORCA_MIGRATION_DATABASE_URL');
  expect(databaseRuntime).toContain('registered Wave 2 internal_runtime principal');
  expect(forcedRls).toContain('migration_version=20260729144000');
  expect(forcedRls).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test('forward upgrade quarantines unscoped retirement history and revokes blanket sequence authority', () => {
  expect(forwardUpgrade).toContain("column_name='workspace_id'");
  expect(forwardUpgrade).toContain('RENAME TO context_epoch_retirement_evaluations_unscoped_legacy');
  expect(forwardUpgrade).toContain('PRIMARY KEY(workspace_id,evaluation_id)');
  expect(forwardUpgrade).toContain('FORCE ROW LEVEL SECURITY');
  expect(forwardUpgrade).toContain('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA rorca');
  expect(forwardUpgrade).toContain('mission_control_audit_id_seq');
  expect(forwardUpgrade).toContain('migration_version=20260729147000');
  expect(forwardUpgrade).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test('final review remediation binds exact authority, receiver acceptance, repair fencing, and direct DML capability',()=>{
  for(const table of ['governed_exact_revision_authority_snapshots','governed_repository_authority_snapshots',
    'governed_path_manifest_snapshots','governed_evidence_obligation_sets','continuation_dispatch_acceptances',
    'wave2_runtime_mutation_capabilities'])expect(finalRemediation).toContain(`CREATE TABLE rorca.${table}`);
  expect(finalRemediation).toContain('authorize_wave2_runtime_mutation_v1');
  expect(finalRemediation).toContain('Direct runtime canonical DML denied');
  expect(finalRemediation).toContain('send_authorization_consumed_at');
  expect(finalRemediation).toContain("status IN('in_progress','completed','failed','quarantined')");
  expect(finalRemediation).toContain('migration_version=20260729152000');
  expect(finalRemediation).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test('9ff4 remediation splits the sole canonical writer and strips runtime mutation capability and relation DML',()=>{
  expect(rejectedShaRemediation).toContain('wave2_canonical_writer_identities');
  expect(rejectedShaRemediation).toContain("REVOKE EXECUTE ON FUNCTION rorca.authorize_wave2_runtime_mutation_v1");
  expect(rejectedShaRemediation).toContain('authorize_wave2_canonical_writer_mutation_v2');
  expect(rejectedShaRemediation).toContain("REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON rorca.%I FROM %I");
  expect(rejectedShaRemediation).toContain('insert_continuation_receiver_inbox_v1');
  expect(rejectedShaRemediation).toContain('continuation_dispatch_receiver_inbox');
  expect(rejectedShaRemediation).toContain('spec_job_transport_attempts');
  expect(rejectedShaRemediation).toContain('spec_repair_effect_receipts');
  expect(rejectedShaRemediation).toContain('migration_version=20260731153000');
  expect(rejectedShaRemediation).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  expect(databaseRuntime).toContain('canonicalTransaction');
  expect(databaseRuntime).toContain('RORCA_CANONICAL_WRITER_DATABASE_URL');
});

test('X-High stabilization removes base DML, HMAC-binds transitions, transports receiver bytes, and reconciles effects',()=>{
  expect(xhighStabilization).toContain('authorize_wave2_canonical_writer_mutation_v3');
  expect(xhighStabilization).toContain('wave2_canonical_capability_mac_v3');
  expect(xhighStabilization).toContain('REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON rorca.%I');
  expect(xhighStabilization).toContain('CREATE VIEW rorca_canonical_api.%I');
  expect(xhighStabilization).toContain('wave2_canonical_relation_operations_v3');
  expect(xhighStabilization).toContain('Exactly one operation+relation capability is required');
  expect(xhighStabilization).toContain('Canonical capability effect cardinality exceeded');
  expect(xhighStabilization).toContain("DROP TRIGGER IF EXISTS %I ON rorca.%I','aa_wave2_capability_");
  expect(xhighStabilization).toContain("'aa_wave2_exact_'||table_name");
  expect(xhighStabilization).not.toContain("'ab_wave2_hmac_'||table_name");
  expect(xhighStabilization).toContain('payload_bytes_hash');
  expect(xhighStabilization).toContain("state IN('authorized','completed','failed','ambiguous')");
  expect(xhighStabilization).toContain('migration_version=20260731154000');
  expect(xhighStabilization).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test('lifecycle evidence has a distinct exact writer capability without weakening leased evidence or runtime DML',()=>{
  expect(lifecycleEvidenceWriter).toContain("'lifecycle-evidence.persist'");
  expect(lifecycleEvidenceWriter).toContain("WHEN capability.operation='evidence.ingest'");
  expect(lifecycleEvidenceWriter).toContain("WHEN capability.operation='lifecycle-evidence.persist'");
  expect(lifecycleEvidenceWriter).toContain("row_json->>'governed_attempt_id' IS NULL");
  expect(lifecycleEvidenceWriter).toContain("row_json->>'source_idempotency_key'=artifact->>'sourceEventId'");
  expect(lifecycleEvidenceWriter).toContain("row_json->>'payload_hash'=artifact->>'payloadHash'");
  expect(lifecycleEvidenceWriter).toContain("row_json->>'subject_value'=artifact->>'subjectValue'");
  expect(lifecycleEvidenceWriter).toContain('Canonical capability effect cardinality exceeded');
  expect(lifecycleEvidenceWriter).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE)[^;]*runtime/i);
  expect(lifecycleEvidenceWriter).not.toMatch(/SECURITY DEFINER[^$]*INSERT INTO rorca\\.ssdlc_lifecycle_evidence/is);
  expect(lifecycleEvidenceWriter).toContain('migration_version=20260731156000');
  expect(lifecycleEvidenceWriter).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test('production Compose provisions and wires genuinely split database principals before API and worker',()=>{
  for(const setting of ['RORCA_MIGRATION_DATABASE_URL','RORCA_RUNTIME_DATABASE_USER','RORCA_CANONICAL_WRITER_DATABASE_URL',
    'RORCA_CANONICAL_WRITER_DATABASE_USER']){
    expect(productionCompose).toContain(setting);
    expect(productionEnv).toContain(setting);
  }
  expect(productionCompose).toContain('db-role-bootstrap:');
  expect(productionCompose).toContain('db-migrate:');
  expect(productionCompose.match(/condition: service_completed_successfully/g)).toHaveLength(3);
  expect(productionCompose.match(/^\s+RORCA_MIGRATION_DATABASE_URL:/gm)??[]).toHaveLength(0);
  expect(productionCompose.match(/^\s+DATABASE_URL: \$\{RORCA_MIGRATION_DATABASE_URL/gm)).toHaveLength(1);
  expect(productionCompose.match(/^\s+RORCA_CANONICAL_WRITER_DATABASE_URL:/gm)).toHaveLength(1);
  expect(productionCompose.match(/^\s+RORCA_MIGRATIONS_PREAPPLIED:/gm)).toHaveLength(2);
  expect(productionCompose.match(/^\s+RORCA_PGBOSS_PREAPPLIED:/gm)).toHaveLength(2);
  expect(productionCompose.match(/^\s+RORCA_DISPATCH_RECEIVER_TOKEN:/gm)).toHaveLength(1);
  expect(productionCompose).toContain('The dispatch sender/worker must not possess receiver acceptance authority');
  expect(productionCompose).toContain('pg-boss-install.js');
  expect(pgBossInstaller).toContain('prepareSplitPrincipalPgBoss');
  expect(pgBossInstaller).toContain('process.exit(0)');
  expect(pgBossInstaller).toContain('process.exit(1)');
  expect(pgBossInstaller).not.toContain('process.exitCode=1');
  expect(productionCompose).not.toContain('env_file:');
  expect(productionCompose).not.toContain('postgres://rorca:rorca@db');
  expect(roleBootstrap).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
  expect(roleBootstrap).toContain('split-principal cross-membership remains');
  expect(roleBootstrap).toContain("WHERE extension.extname='pgcrypto'");
  expect(roleBootstrap).toContain("GRANT USAGE ON SCHEMA %I TO %I");
  expect(roleBootstrap).toContain('ALTER DATABASE %I OWNER TO %I');
  expect(composeSmoke).toContain('I_ACKNOWLEDGE_EXACT_PROJECT_IMAGES_ALREADY_BUILT');
  expect(composeSmoke).toContain('docker image inspect "$project-$service"');
  expect(composeSmoke).toContain('must not inject migration-owner credentials');
  expect(composeSmoke).toContain('wave2_upgrade_owner_smoke');
  expect(composeSmoke).toContain('wave2_upgrade_owner_state');
  expect(composeSmoke).toContain('wave2_upgrade_owner_function');
  expect(composeSmoke).toContain("'RORCA_DISPATCH_RECEIVER_TOKEN'");
  expect(composeSmoke).toContain('upgrade-split-owner.sql');
  expect(splitOwnerUpgrade).toContain("object_type.typtype IN('c','d','e','m','r')");
  expect(splitOwnerUpgrade).toContain("composite.relkind='c'");
  expect(splitOwnerUpgrade).toContain("dependency.deptype='e'");
  expect(composeSmoke).toContain('--rmi local');
  expect(databaseRuntime).toContain('RORCA_MIGRATIONS_PREAPPLIED');
  expect(databaseRuntime).toContain('must not inject migration-owner credentials into runtime processes');
  expect(databaseRuntime).toContain('migration_version=20260731157000');
  expect(databaseRuntime).toContain('FROM rorca.completion_schema_readiness');
  expect(databaseRuntime).toContain('migration_version=20260804170000');
});

test('pre-run worker rejection and every repair effect are terminal/fence evidenced',()=>{
  expect(specWorker).toContain('terminalizeOwnedPreRunFailure');
  expect(specJobs).toContain("'terminal','rejected'");
  expect(specWorker).toContain("phase:'terminal',outcome:'failed'");
  expect(specRoutes).toContain('spec_repair_effect_receipts');
  expect(specRoutes).toContain("lease_expires_at>statement_timestamp()");
  for(const effect of ['queue.cancel.stale-job','application-job.recover','workflow.start','workflow.metadata',
    'generation-log.seed','generation-log.context-backfill','wal.insert.repair','wal.broadcast.repair']) {
    expect(specRoutes).toContain(effect);
  }
});

test('canonical authority, evidence obligations, send authorization, and the pre-DDL source gate fail closed', () => {
  for (const table of ['governed_spec_authority_snapshots', 'governed_decision_authority_snapshots',
    'context_policy_authority_receipts', 'governed_evidence_obligations']) expect(canonicalAuthority).toContain(table);
  expect(canonicalAuthority).toContain('migration_version=20260729145000');
  expect(dispatchSendAuthority).toContain('send_authorization_hash');
  expect(dispatchSendAuthority).toContain('migration_version=20260729146000');
  const gate = migrationRunner.indexOf("if (file.startsWith('20260729131000_wave2_'))");
  const read = migrationRunner.indexOf("const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')");
  expect(gate).toBeGreaterThan(0);
  expect(gate).toBeLessThan(read);
});
