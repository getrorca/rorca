/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { closePool } from '../index';
import {
  activateAutonomousDeliveryPolicy,
  createAutonomousDeliveryPolicy,
  revokeAutonomousDeliveryPolicy,
} from '../../lib/autonomous-delivery-policy';
import {
  createCanonicalEvidence,
  persistCanonicalEvidence,
  type CanonicalLifecycleEvidence,
} from '../../lib/ssdlc-evidence';

let workspaceId: string;
const policyIdPattern = /^[0-9a-f-]{36}$/;
const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const mergedSha = 'c'.repeat(40);
const principal = { principalId: 'operator-1', displayLabel: 'operator@example.test' };

const migrationDatabaseUrl = process.env.RORCA_MIGRATION_DATABASE_URL ?? process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
const runtimeDatabaseUrl = process.env.DATABASE_URL;
const writerDatabaseUrl = process.env.RORCA_CANONICAL_WRITER_DATABASE_URL;
if (!migrationDatabaseUrl || !runtimeDatabaseUrl || !writerDatabaseUrl) {
  throw new Error('Split migration, runtime, and canonical-writer database URLs are required');
}
const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  options: '--search_path=rorca,public -c rorca.migration_mode=on',
});
const runtimePool = new Pool({ connectionString: runtimeDatabaseUrl, options: '--search_path=rorca,public' });
const writerPool = new Pool({
  connectionString: writerDatabaseUrl,
  options: '--search_path=rorca_canonical_api,rorca,public',
});

async function ownerExecute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
  const result = await ownerPool.query(sql, params);
  return { rowCount: result.rowCount ?? 0 };
}

async function ownerQueryOne<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<T | undefined> {
  return (await ownerPool.query<T>(sql, params)).rows[0];
}

afterAll(async () => {
  await closePool();
  await Promise.all([ownerPool.end(), runtimePool.end(), writerPool.end()]);
});

beforeEach(async () => {
  workspaceId = `ws-autonomous-reviewed-delivery-${crypto.randomUUID()}`;
  await ownerExecute(`INSERT INTO workspaces (id, label, path, domains)
   VALUES ($1, 'Reviewed delivery migration', '/tmp/reviewed-delivery', '[]')`,
  [workspaceId],);
  await ownerExecute(`INSERT INTO workspace_github_webhooks
     (workspace_id, repo_owner, repo_name, encrypted_webhook_secret,
      auto_pr_target_branch, auto_pr_enabled)
   VALUES ($1, 'getrorca', 'rorca', 'test-only', 'main', FALSE)`,
  [workspaceId],);
});

const rawLifecycleInsert = `
  INSERT INTO rorca_canonical_api.ssdlc_lifecycle_evidence (
    workspace_id, spec_slug, revision, run_id, story_id, phase_id, gate_id,
    evidence_type, subject_type, subject_value, source_system, source_idempotency_key,
    payload_hash, metadata, provenance, source_ref, observed_at,
    source_type, classification, evidence_status, trust_level, confidence, excerpt,
    release_identity, phase_subject_type, phase_subject_value, revision_mismatch,
    lineage_verified, actor, rationale, github_pr_delivery_evidence_id,
    compiled_plan_id, delivery_projection_kind
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,
    $18,$19,$20,$21,$22,$23,$24::jsonb,$25,$26,$27,$28,$29,$30,$31,$32::bigint,$33
  ) RETURNING id
`;

function canonicalWriteFixture(sourceEventId = `writer-proof:${crypto.randomUUID()}`): {
  evidence: CanonicalLifecycleEvidence;
  request: Record<string, unknown>;
  params: unknown[];
} {
  const evidence = createCanonicalEvidence({
    sourceType: 'completion_signal',
    sourceSystem: 'canonical-writer-proof',
    sourceEventId,
    observedAt: '2026-07-17T00:02:00.000Z',
    scope: {
      workspaceId,
      specSlug: 'canonical-writer-proof',
      runId: null,
      storyId: 'LFC-WRITER',
      phaseId: 'testing',
      gateId: 'gate-writer',
    },
    subject: { type: 'spec_hash', value: `sha256:${'a'.repeat(64)}` },
    phaseSubject: { type: 'spec_hash', value: `sha256:${'a'.repeat(64)}` },
    releaseIdentity: {},
    classification: 'completion',
    status: 'passed',
    trustLevel: 'host_observed',
    confidence: 1,
    details: { proof: 'canonical-writer-capability' },
  });
  const metadata = {
    schemaVersion: evidence.schemaVersion,
    details: evidence.details,
    sourcePayloadHash: evidence.sourcePayloadHash,
  };
  const provenance = { chain: evidence.provenanceChain };
  const request: Record<string, unknown> = {
    workspaceId,
    specSlug: evidence.scope.specSlug,
    revision: evidence.releaseIdentity.commitSha,
    runId: evidence.scope.runId,
    storyId: evidence.scope.storyId,
    phaseId: evidence.scope.phaseId,
    gateId: evidence.scope.gateId,
    evidenceType: evidence.classification,
    subjectType: evidence.subject.type,
    subjectValue: evidence.subject.value,
    sourceSystem: evidence.source.system,
    sourceEventId: evidence.source.eventId,
    payloadHash: evidence.payloadHash,
    metadata,
    provenance,
    sourceRef: evidence.rawReference,
    observedAt: evidence.observedAt,
    sourceType: evidence.source.type,
    classification: evidence.classification,
    evidenceStatus: evidence.status,
    trustLevel: evidence.trustLevel,
    confidence: evidence.confidence,
    excerpt: evidence.excerpt,
    releaseIdentity: evidence.releaseIdentity,
    phaseSubjectType: evidence.phaseSubject?.type ?? null,
    phaseSubjectValue: evidence.phaseSubject?.value ?? null,
    revisionMismatch: evidence.revisionMismatch,
    lineageVerified: evidence.lineageVerified,
    actor: evidence.actor,
    rationale: evidence.rationale,
    githubPrDeliveryEvidenceId: null,
    compiledPlanId: null,
    deliveryProjectionKind: null,
  };
  return {
    evidence,
    request,
    params: [
      workspaceId,
      evidence.scope.specSlug,
      evidence.releaseIdentity.commitSha,
      evidence.scope.runId,
      evidence.scope.storyId,
      evidence.scope.phaseId,
      evidence.scope.gateId,
      evidence.classification,
      evidence.subject.type,
      evidence.subject.value,
      evidence.source.system,
      evidence.source.eventId,
      evidence.payloadHash,
      JSON.stringify(metadata),
      JSON.stringify(provenance),
      evidence.rawReference,
      evidence.observedAt,
      evidence.source.type,
      evidence.classification,
      evidence.status,
      evidence.trustLevel,
      evidence.confidence,
      evidence.excerpt,
      JSON.stringify(evidence.releaseIdentity),
      evidence.phaseSubject?.type ?? null,
      evidence.phaseSubject?.value ?? null,
      evidence.revisionMismatch,
      evidence.lineageVerified,
      evidence.actor,
      evidence.rationale,
      null,
      null,
      null,
    ],
  };
}

async function issueLifecycleCapability(
  client: PoolClient,
  request: Record<string, unknown>,
  authorizedWorkspace = workspaceId,
): Promise<void> {
  const requestBytes = JSON.stringify(request);
  const requestHash = `sha256:${crypto.createHash('sha256').update(requestBytes).digest('hex')}`;
  const subjectHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify({
    workspaceId: request.workspaceId,
    subjectType: request.subjectType,
    subjectValue: request.subjectValue,
  })).digest('hex')}`;
  await client.query(
    `SELECT authorize_wave2_canonical_writer_mutation_v3($1,'lifecycle-evidence.persist',$2,$3,$4::jsonb)`,
    [authorizedWorkspace, requestHash, subjectHash, requestBytes],
  );
}

test('ordinary runtime remains denied direct lifecycle evidence INSERT', async () => {
  const fixture = canonicalWriteFixture();
  const client = await runtimePool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
    await expect(client.query(rawLifecycleInsert.replace('rorca_canonical_api.', 'rorca.'), fixture.params))
      .rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

test('canonical writer without a capability cannot persist lifecycle evidence', async () => {
  const fixture = canonicalWriteFixture();
  const client = await writerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
    await expect(client.query(rawLifecycleInsert, fixture.params)).rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

test('canonical writer capability cannot cross its exact workspace', async () => {
  const fixture = canonicalWriteFixture();
  const wrongWorkspace = `${workspaceId}:other`;
  const client = await writerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
    await expect(issueLifecycleCapability(
      client,
      { ...fixture.request, workspaceId: wrongWorkspace },
      wrongWorkspace,
    )).rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

test.each([
  ['payload', (params: unknown[]) => { params[12] = 'b'.repeat(64); }],
  ['subject', (params: unknown[]) => { params[9] = `sha256:${'c'.repeat(64)}`; }],
])('canonical writer capability rejects a changed %s', async (_label, mutate) => {
  const fixture = canonicalWriteFixture();
  const changedParams = [...fixture.params];
  mutate(changedParams);
  const client = await writerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
    await issueLifecycleCapability(client, fixture.request);
    await expect(client.query(rawLifecycleInsert, changedParams)).rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

test('one lifecycle evidence capability cannot be reused for a second INSERT effect', async () => {
  const fixture = canonicalWriteFixture();
  const client = await writerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
    await issueLifecycleCapability(client, fixture.request);
    await client.query(rawLifecycleInsert, fixture.params);
    await expect(client.query(rawLifecycleInsert, fixture.params)).rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

test('default lifecycle evidence persistence uses canonical authority and replays idempotently', async () => {
  const fixture = canonicalWriteFixture();
  const first = await persistCanonicalEvidence(fixture.evidence);
  const replay = await persistCanonicalEvidence(fixture.evidence);
  expect(first.replayed).toBe(false);
  expect(replay).toMatchObject({ replayed: true, evidence: { id: first.evidence.id } });
  const rows = await ownerQueryOne<{ total: number; non_governed: number }>(`
    SELECT COUNT(*)::int total,
      COUNT(*) FILTER (WHERE governed_attempt_id IS NULL)::int non_governed
    FROM ssdlc_lifecycle_evidence
    WHERE workspace_id=$1 AND source_system=$2 AND source_idempotency_key=$3
  `, [workspaceId, fixture.evidence.source.system, fixture.evidence.source.eventId]);
  expect(rows).toEqual({ total: 1, non_governed: 1 });
});

async function seedAuthority() {
  const created = await createAutonomousDeliveryPolicy({
    workspaceId,
    principal,
    sourceRequestId: 'reviewed-policy-create-001',
    now: new Date('2026-07-17T00:00:00.000Z'),
    draft: {
      baseBranch: 'main',
      allowedRiskLevels: ['low'],
      requiredChecks: ['Backend Tests'],
      reviewRules: {
        minimumApprovals: 1,
        requireCodeOwnerReview: false,
        dismissStaleApprovals: true,
        requiredReviewers: ['release-owner'],
      },
      mergeMethod: 'squash',
      retryBudget: { maxAttempts: 2, maxElapsedMinutes: 90 },
      expiresAt: '2026-08-01T00:00:00.000Z',
    },
  });
  expect(created.policy.id).toMatch(policyIdPattern);
  await activateAutonomousDeliveryPolicy({
    workspaceId,
    policyId: created.policy.id,
    expectedPolicyDigest: created.policy.policyDigest,
    confirmation: 'ENABLE_AUTONOMOUS_PR_DELIVERY',
    principal,
    sourceRequestId: 'reviewed-policy-activate-001',
    now: new Date('2026-07-17T00:01:00.000Z'),
  });
  const run = await ownerQueryOne<{ id: number }>(`
    INSERT INTO pipeline_runs (
      spec_path, workspace_id, status, branch_name, worktree_path,
      pr_number, merge_strategy, auto_merge, agent_type, agent_model
    ) VALUES (
      'forge/specs/approved/reviewed-delivery.json', $1, 'done',
      'run/reviewed-delivery', '/tmp/reviewed-delivery-worktree', 42,
      'pr', FALSE, 'pi', 'openai-codex/gpt-5.6-sol'
    ) RETURNING id
  `, [workspaceId]);
  if (!run) throw new Error('run insert failed');
  const runId = Number(run.id);
  const planId = 'ssdlc.reviewed-delivery.plan.v1';
  const compiledPlan = await ownerQueryOne<{ id: number }>(`
    INSERT INTO ssdlc_compiled_plans (
      workspace_id, spec_slug, spec_version, compiler_version, normalized_input_hash,
      schema_version, plan_json, provenance_json, validation_status, validated_at, is_current
    ) VALUES (
      $1, 'reviewed-delivery', 'reviewed-delivery-v1', 'reviewed-delivery-fixture',
      $2, 'plan.v1', $3::jsonb, '{}'::jsonb, 'validated', NOW(), TRUE
    ) RETURNING id
  `, [
    workspaceId,
    `sha256:${crypto.createHash('sha256').update(`${workspaceId}:${planId}`).digest('hex')}`,
    JSON.stringify({ planId }),
  ]);
  if (!compiledPlan) throw new Error('compiled plan insert failed');

  const githubEvidenceId = crypto.randomUUID();
  await ownerExecute(`
    INSERT INTO github_pr_delivery_evidence (
      id, workspace_id, run_id, policy_id, policy_digest, repo_owner, repo_name,
      repository_authority_source, pr_number, pr_url, pr_state, draft, merged, head_ref, base_ref, head_sha,
      base_sha, mergeable, mergeable_state, comparison_status, ahead_by, behind_by,
      branch_fresh, checks, reviews, check_summary, review_summary,
      provider_observed_at, observed_by_principal_id, observed_by_display_label,
      payload_hash
    ) VALUES (
      $1, $2, $3, $4, $5, 'getrorca', 'rorca', 'pat-oauth-fallback', 42,
      'https://github.com/getrorca/rorca/pull/42', 'open', FALSE, FALSE,
      'run/reviewed-delivery', 'main', $6, $7, TRUE, 'clean', 'ahead', 2, 0,
      TRUE, '[]', '[]', '{"allRequiredPassed":true}', '{"reviewSatisfied":true}',
      NOW(), 'steward', 'Autonomous Delivery Steward', $8
    )
  `, [githubEvidenceId, workspaceId, runId, created.policy.id, created.policy.policyDigest,
    headSha, baseSha, `sha256:${'d'.repeat(64)}`]);

  const lifecycle = await persistCanonicalEvidence(createCanonicalEvidence({
    sourceType: 'github_check',
    sourceSystem: 'github-pr-delivery',
    sourceEventId: `reviewed-delivery:${githubEvidenceId}:merge`,
    observedAt: '2026-07-17T00:02:00.000Z',
    scope: { workspaceId, specSlug: 'reviewed-delivery', runId, storyId: null, phaseId: 'deployment', gateId: 'gate-deployment' },
    subject: { type: 'commit_sha', value: headSha },
    phaseSubject: { type: 'commit_sha', value: headSha },
    releaseIdentity: { commitSha: headSha, artifactDigest: `sha256:${'e'.repeat(64)}` },
    classification: 'approval',
    status: 'passed',
    trustLevel: 'provider_verified',
    confidence: 1,
    details: { policyVersion: 'policy-v1', compilerVersion: 'ssdlc-plan-compiler-2', evidenceRequirementIds: ['evidence-requirement-merge'] },
  }));

  const decision = await ownerQueryOne<{ id: number }>(`
    INSERT INTO ssdlc_decisions (
      workspace_id, spec_slug, run_id, phase_id, gate_id, decision_type,
      rationale, subject_type, subject_value, policy_version, policy_reference,
      policy_authorized, principal_type, principal_id, principal_display_label,
      actor, source_request_id, source_channel, scope_key, request_hash, expires_at, created_at,
      compiled_plan_id, plan_id
    ) VALUES (
      $1, 'reviewed-delivery', $2, 'deployment', 'gate-deployment', 'policy_approval',
      'Standing operator policy authorized this exact reviewed revision.',
      'commit_sha', $3, 'policy-v1', $4, TRUE, 'internal_service',
      'autonomous-delivery-steward', 'Autonomous Delivery Steward',
      'Autonomous Delivery Steward', 'policy-approval-review-001', 'internal',
      'reviewed-delivery|deployment|gate-deployment|*|run', $5, '2026-08-01T00:00:00.000Z',
      '2026-07-17T00:02:00.000Z', $6, $7
    ) RETURNING id
  `, [workspaceId, runId, headSha,
    `autonomous-delivery:${created.policy.id}:${created.policy.policyDigest}`,
    `sha256:${'f'.repeat(64)}`, compiledPlan.id, planId]);
  if (!decision) throw new Error('decision insert failed');
  return { policy: created.policy, runId, githubEvidenceId, lifecycleEvidenceId: lifecycle.evidence.id, decisionId: Number(decision.id) };
}

test('creates bounded reviewed-delivery state without pgboss objects and enforces terminal evidence', async () => {
  const authority = await seedAuthority();
  const deliveryId = crypto.randomUUID();
  await ownerExecute(`
    INSERT INTO autonomous_pr_deliveries (
      id, workspace_id, run_id, spec_slug, policy_id, policy_digest, risk_level,
      repo_owner, repo_name, pr_number, base_branch, branch_name,
      initial_head_sha, current_head_sha, merge_method, retry_budget, status,
      last_evidence_id, merge_decision_id, source_request_id, deadline_at, created_at
    ) VALUES (
      $1, $2, $3, 'reviewed-delivery', $4, $5, 'low', 'getrorca', 'rorca', 42,
      'main', 'run/reviewed-delivery', $6, $6, 'squash',
      '{"maxAttempts":2,"maxElapsedMinutes":90}', 'merging', $7, $8,
      'delivery-start-review-001', '2026-07-17T02:00:00.000Z', '2026-07-17T00:02:00.000Z'
    )
  `, [deliveryId, workspaceId, authority.runId, authority.policy.id,
    authority.policy.policyDigest, headSha, authority.githubEvidenceId, authority.decisionId]);

  await ownerExecute(`
    INSERT INTO autonomous_pr_delivery_merge_evidence (
      id, delivery_id, workspace_id, run_id, policy_id, policy_digest,
      github_evidence_id, lifecycle_merge_evidence_id, merge_decision_id,
      lifecycle_snapshot_id, evidence_high_water_mark, decision_high_water_mark,
      repo_owner, repo_name, pr_number, expected_head_sha, merged_sha,
      merge_method, provider_response_hash, merged_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      'snapshot-reviewed-001', 'evidence:10', 'decision:5:1000',
      'getrorca', 'rorca', 42, $10, $11, 'squash', $12, NOW()
    )
  `, [crypto.randomUUID(), deliveryId, workspaceId, authority.runId,
    authority.policy.id, authority.policy.policyDigest, authority.githubEvidenceId,
    authority.lifecycleEvidenceId, authority.decisionId, headSha, mergedSha,
    `sha256:${'1'.repeat(64)}`]);
  await ownerExecute(`
    UPDATE autonomous_pr_deliveries
    SET status = 'merged', merged_sha = $2, completed_at = NOW(), updated_at = NOW()
    WHERE id = $1
  `, [deliveryId, mergedSha]);

  await expect(ownerExecute('DELETE FROM autonomous_pr_delivery_merge_evidence WHERE delivery_id = $1', [deliveryId]))
    .rejects.toThrow(/append-only/i);
  await expect(ownerExecute("UPDATE autonomous_pr_deliveries SET status = 'queued' WHERE id = $1", [deliveryId]))
    .rejects.toThrow(/terminal/i);
  await expect(ownerExecute('DELETE FROM autonomous_pr_deliveries WHERE id = $1', [deliveryId]))
    .rejects.toThrow(/audit-retained/i);

  const lifecycleRunIds = await ownerQueryOne<{ bigint_columns: number }>(`
    SELECT COUNT(*)::int AS bigint_columns
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name IN ('ssdlc_lifecycle_evidence', 'ssdlc_decisions')
      AND column_name = 'run_id' AND data_type = 'bigint'
  `);
  expect(lifecycleRunIds?.bigint_columns).toBe(2);

  const pgbossTouches = await ownerQueryOne<{ total: number }>(`
    SELECT COUNT(*)::int AS total
    FROM information_schema.tables
    WHERE table_schema = 'pgboss' AND table_name LIKE '%autonomous%'
  `);
  expect(pgbossTouches?.total).toBe(0);
});

test('operator revocation invalidates derived policy authority and stops queued delivery', async () => {
  const authority = await seedAuthority();
  const deliveryId = crypto.randomUUID();
  await ownerExecute(`
    INSERT INTO autonomous_pr_deliveries (
      id, workspace_id, run_id, spec_slug, policy_id, policy_digest, risk_level,
      repo_owner, repo_name, pr_number, base_branch, branch_name,
      initial_head_sha, current_head_sha, merge_method, retry_budget, status,
      source_request_id, deadline_at, created_at
    ) VALUES ($1, $2, $3, 'reviewed-delivery', $4, $5, 'low', 'getrorca', 'rorca',
              42, 'main', 'run/reviewed-delivery', $6, $6, 'squash',
              '{"maxAttempts":2,"maxElapsedMinutes":90}', 'queued',
              'delivery-revocation-review-001', '2026-08-01T00:00:00.000Z',
              '2026-07-17T00:02:00.000Z')
  `, [deliveryId, workspaceId, authority.runId, authority.policy.id, authority.policy.policyDigest, headSha]);

  await revokeAutonomousDeliveryPolicy({
    workspaceId,
    policyId: authority.policy.id,
    reason: 'Operator revoked standing authority during reviewed delivery validation.',
    principal,
    sourceRequestId: 'reviewed-policy-revoke-001',
    now: new Date('2026-07-17T00:03:00.000Z'),
  });
  const decision = await ownerQueryOne<{ revoked_at: Date | null }>('SELECT revoked_at FROM ssdlc_decisions WHERE id = $1', [authority.decisionId]);
  const delivery = await ownerQueryOne<{ status: string; terminal_reason: string }>(
    'SELECT status, terminal_reason FROM autonomous_pr_deliveries WHERE id = $1', [deliveryId],
  );
  const blockedEvent = await ownerQueryOne<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM autonomous_pr_delivery_events
     WHERE delivery_id = $1 AND event_type = 'blocked'`, [deliveryId],
  );
  expect(decision?.revoked_at).not.toBeNull();
  expect(delivery).toEqual({ status: 'blocked', terminal_reason: 'standing_policy_revoked' });
  expect(blockedEvent?.total).toBe(1);
});

test('permits one bounded recovery terminal transition and blocks rewriting its identity', async () => {
  const authority = await seedAuthority();
  const deliveryId = crypto.randomUUID();
  await ownerExecute(`
    INSERT INTO autonomous_pr_deliveries (
      id, workspace_id, run_id, spec_slug, policy_id, policy_digest, risk_level,
      repo_owner, repo_name, pr_number, base_branch, branch_name,
      initial_head_sha, current_head_sha, merge_method, retry_budget, status,
      source_request_id, deadline_at, created_at
    ) VALUES ($1, $2, $3, 'reviewed-delivery', $4, $5, 'low', 'getrorca', 'rorca',
              42, 'main', 'run/reviewed-delivery', $6, $6, 'squash',
              '{"maxAttempts":2,"maxElapsedMinutes":90}', 'recovering_conflict',
              'delivery-recovery-review-001', '2026-07-17T02:00:00.000Z',
              '2026-07-17T00:02:00.000Z')
  `, [deliveryId, workspaceId, authority.runId, authority.policy.id, authority.policy.policyDigest, headSha]);
  const attemptId = crypto.randomUUID();
  await ownerExecute(`
    INSERT INTO autonomous_pr_delivery_recovery_attempts (
      id, delivery_id, attempt_number, recovery_kind, status, head_sha_before, classification
    ) VALUES ($1, $2, 1, 'conflict', 'started', $3, 'base_branch_conflict')
  `, [attemptId, deliveryId, headSha]);
  const nextHead = '9'.repeat(40);
  await ownerExecute(`
    UPDATE autonomous_pr_delivery_recovery_attempts
    SET status = 'completed', head_sha_after = $2, finished_at = NOW()
    WHERE id = $1
  `, [attemptId, nextHead]);
  await expect(ownerExecute(`
    UPDATE autonomous_pr_delivery_recovery_attempts SET failure_reason = 'rewrite' WHERE id = $1
  `, [attemptId])).rejects.toThrow(/one terminal transition/i);
  await expect(ownerExecute('DELETE FROM autonomous_pr_delivery_recovery_attempts WHERE id = $1', [attemptId]))
    .rejects.toThrow(/audit-retained/i);
});
