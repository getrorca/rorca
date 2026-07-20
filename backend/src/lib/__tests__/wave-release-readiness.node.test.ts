/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  assertWaveReleaseReadinessPacket,
  signWaveProductionActivation,
  verifyWaveProductionActivation,
  waveReleaseReadinessPacketHash,
  WAVE_RELEASE_READINESS_SCHEMA,
  WAVE_RELEASE_REQUIREMENTS,
  WAVE_RELEASE_VALIDATIONS,
  WAVE_REVIEW_ROLES,
  type WaveReleaseReadinessPacket,
} from '../wave-release-readiness';

const revision = 'a'.repeat(40);
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const now = '2026-07-19T12:00:00.000Z';

function packet(): WaveReleaseReadinessPacket {
  const reviewers = Object.fromEntries(WAVE_REVIEW_ROLES.map((role, index) => [role, `human-reviewer-${index + 1}`]));
  return {
    schemaVersion: WAVE_RELEASE_READINESS_SCHEMA,
    workspaceId: 'workspace-canary',
    qualification: {
      receiptId: 'receipt-41', reportHash: digest('1'), sourceRevision: revision,
      issuedAt: '2026-07-19T11:00:00.000Z', expiresAt: '2026-07-20T11:00:00.000Z',
    },
    pullRequest: {
      number: 412, headRevision: revision, deliveryMode: 'reviewed-pull-request', reviewed: true,
      autoMergeEnabled: false, deploymentEnabled: false,
    },
    implementerId: 'implementation-agent',
    reviews: WAVE_REVIEW_ROLES.map((role, index) => ({
      role,
      reviewerId: `human-reviewer-${index + 1}`,
      reviewedSourceRevision: revision,
      verdict: 'approved',
      unresolvedCriticalHighFindings: 0,
      evidenceDigest: digest(((index + 2) % 10).toString()),
    })),
    checklist: WAVE_RELEASE_REQUIREMENTS.map((requirementId, index) => ({
      requirementId,
      critical: true,
      verdict: 'passed',
      invariantIds: index === 0
        ? ['WPE-INV-001', 'WPE-INV-002', 'WPE-INV-003', 'WPE-INV-004', 'WPE-INV-005', 'WPE-INV-006', 'WPE-INV-007']
        : ['WPE-INV-007'],
      scenarioIds: [`WPE-Q-${String(index + 1).padStart(3, '0')}`],
      assertionIds: [`WPE-A-${String(index + 1).padStart(3, '0')}`],
      durableEvidenceDigests: [digest(((index + 3) % 10).toString())],
      independentCheckerId: `checker-${index + 1}`,
      humanReviewerId: reviewers[WAVE_REVIEW_ROLES[index % WAVE_REVIEW_ROLES.length]],
    })),
    platformMatrix: ([
      ['linux', 20], ['linux', 22], ['darwin', 20], ['darwin', 22],
    ] as const).map(([platform, nodeMajor], index) => ({
      platform, nodeMajor, postgresMajor: 16, isolatedDatabaseOwnedByTestRole: true,
      criticalChecksSkipped: false, verdict: 'passed', evidenceDigest: digest(((index + 4) % 10).toString()),
    })),
    canary: {
      environment: 'non-production', verdict: 'passed', durationSeconds: 900, automaticFlakyRetries: 1,
      leakedResourceCount: 0, unexplainedStateDivergenceCount: 0, unresolvedCriticalHighFindings: 0,
      evidenceDigest: digest('5'),
    },
    soak: {
      environment: 'non-production', verdict: 'passed', durationSeconds: 14_400, automaticFlakyRetries: 2,
      leakedResourceCount: 0, unexplainedStateDivergenceCount: 0, unresolvedCriticalHighFindings: 0,
      evidenceDigest: digest('6'),
    },
    rollback: {
      productionOptInDisabled: true, newParallelDispatchBlockedImmediately: true,
      inFlightEvidencePreserved: true, governedDrainVerified: true, governedCancelVerified: true,
      sequentialExecutionAvailable: true, evidenceDigest: digest('7'),
    },
    nonMutation: {
      namespacedTestDataOnly: true, protectedInventoryBeforeDigest: digest('8'),
      protectedInventoryAfterDigest: digest('8'), cleanupEvidenceDigest: digest('9'),
      mutations: {
        workspaces: 0, specs: 0, runs: 0, storyEvidence: 0, queues: 0, branches: 0,
        operatorRecords: 0, wal: 0, receipts: 0, rolloutControls: 0,
      },
    },
    validations: WAVE_RELEASE_VALIDATIONS.map(id => ({ id, verdict: 'passed', sourceRevision: revision, evidenceDigest: digest('b') })),
  };
}

function rejects(mutator: (value: WaveReleaseReadinessPacket) => void, pattern: RegExp): void {
  const value = packet();
  mutator(value);
  assert.throws(() => assertWaveReleaseReadinessPacket(value, now), pattern);
}

test('complete independent review packet is deterministic and tied to the current PR head', () => {
  const value = packet();
  assert.equal(assertWaveReleaseReadinessPacket(value, now), value);
  assert.match(waveReleaseReadinessPacketHash(value), /^sha256:[0-9a-f]{64}$/);
  assert.equal(waveReleaseReadinessPacketHash(structuredClone(value)), waveReleaseReadinessPacketHash(value));
});

test('implementer self-approval, duplicate reviewers, unresolved findings, and stale reviews fail closed', () => {
  rejects(value => { value.reviews[0].reviewerId = value.implementerId; }, /implementer cannot approve/);
  rejects(value => { value.reviews[1].reviewerId = value.reviews[0].reviewerId; }, /distinct named reviewer/);
  rejects(value => { value.reviews[2].unresolvedCriticalHighFindings = 1; }, /stale or not approved/);
  rejects(value => { value.reviews[3].reviewedSourceRevision = 'c'.repeat(40); }, /stale or not approved/);
});

test('critical checklist omissions, skips, ambiguity, and missing durable mappings fail closed', () => {
  rejects(value => { value.checklist.pop(); }, /requirement inventory/);
  rejects(value => { value.checklist[0].verdict = 'skipped'; }, /skipped, failed, or ambiguous/);
  rejects(value => { value.checklist[0].verdict = 'ambiguous'; }, /skipped, failed, or ambiguous/);
  rejects(value => { value.checklist[0].durableEvidenceDigests = []; }, /empty or unbounded/);
  rejects(value => { value.checklist[0].invariantIds = ['WPE-INV-001']; }, /every invariant/);
});

test('stale receipts, non-PR delivery, auto-merge, deployment, and stale validation evidence fail closed', () => {
  rejects(value => { value.pullRequest.headRevision = 'd'.repeat(40); }, /not tied to the PR head/);
  rejects(value => { value.pullRequest.autoMergeEnabled = true as false; }, /PR-only/);
  rejects(value => { value.pullRequest.deploymentEnabled = true as false; }, /PR-only/);
  rejects(value => { value.validations[0].sourceRevision = 'e'.repeat(40); }, /validation is skipped, failed, or stale/);
  assert.throws(() => assertWaveReleaseReadinessPacket(packet(), '2026-07-21T12:00:00.000Z'), /expired/);
});

test('platform isolation, canary, soak, rollback, and protected inventory are mandatory', () => {
  rejects(value => { value.platformMatrix[0].criticalChecksSkipped = true as false; }, /not blocking and isolated/);
  rejects(value => { value.canary.leakedResourceCount = 1; }, /unresolved safety findings/);
  rejects(value => { value.soak.unexplainedStateDivergenceCount = 1; }, /unresolved safety findings/);
  rejects(value => { value.rollback.newParallelDispatchBlockedImmediately = false; }, /not proven/);
  rejects(value => { value.nonMutation.protectedInventoryAfterDigest = digest('f'); }, /inventory changed/);
  rejects(value => { value.nonMutation.mutations.queues = 1; }, /mutated protected production data/);
});

test('production activation authority is authenticated and bound to packet, revision, workspace and operator', () => {
  const value = packet();
  const authorizationInput = {
    workspaceId: value.workspaceId,
    packetHash: waveReleaseReadinessPacketHash(value),
    sourceRevision: value.pullRequest.headRevision,
    operatorId: 'independent-production-operator',
    confirmation: 'AUTHORIZE_WAVE_PARALLEL_PRODUCTION' as const,
  };
  const key = 'independent-production-activation-key-with-at-least-32-bytes';
  const authorization = signWaveProductionActivation(authorizationInput, key);
  assert.doesNotThrow(() => verifyWaveProductionActivation({ ...authorizationInput, authorization, trustedKey: key }));
  assert.throws(() => verifyWaveProductionActivation({ ...authorizationInput, operatorId: 'forged-operator', authorization, trustedKey: key }), /authorization is invalid/);
  assert.throws(() => verifyWaveProductionActivation({ ...authorizationInput, packetHash: digest('f'), authorization, trustedKey: key }), /authorization is invalid/);
  assert.throws(() => signWaveProductionActivation(authorizationInput, 'short'), /at least 32 bytes/);
});

test('blocking CI qualifies Linux and macOS on Node 20/22 with owned PostgreSQL 16 isolation and bounded retry', () => {
  const repositoryRoot = fs.existsSync(path.resolve(process.cwd(), 'backend/src')) ? process.cwd() : path.resolve(process.cwd(), '..');
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/wave-qualification.yml'), 'utf8');
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /runs-on: macos-14/);
  assert.equal((workflow.match(/node: \[20, 22\]/g) ?? []).length, 2);
  assert.match(workflow, /image: postgres:16/);
  assert.match(workflow, /brew (?:list|install) postgresql@16/);
  assert.match(workflow, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  assert.match(workflow, /RORCA_QUALIFICATION_DATABASE_URL/);
  assert.match(workflow, /runPgMigrations/);
  assert.equal((workflow.match(/npx vitest run/g) ?? []).length, 2);
  assert.equal((workflow.match(/npm test -- --runInBand/g) ?? []).length, 2);
  assert.match(workflow, /DATABASE_URL_TEST="\$RORCA_QUALIFICATION_DATABASE_URL"/);
  assert.match(workflow, /npm run test:wave-qualification/);
  assert.match(workflow, /First authoritative attempt failed; running one automatic diagnostic retry without converting the gate to success/);
  assert.equal((workflow.match(/DROP DATABASE :"database" WITH \(FORCE\)/g) ?? []).length, 2);
  assert.equal((workflow.match(/DATABASE_URL_TEST="\$RORCA_QUALIFICATION_DATABASE_URL"/g) ?? []).length, 2);
  assert.doesNotMatch(workflow, /RORCA_WAVE_PARALLEL_PRODUCTION_ENABLED|deployment:/);
});

test('receipt and activation trust secrets are stripped from worker, runner, engine and agent child environments', () => {
  const repositoryRoot = fs.existsSync(path.resolve(process.cwd(), 'backend/src')) ? process.cwd() : path.resolve(process.cwd(), '..');
  const worker = fs.readFileSync(path.join(repositoryRoot, 'backend/src/worker.ts'), 'utf8');
  const runner = fs.readFileSync(path.join(repositoryRoot, 'backend/src/runner/local-runner.ts'), 'utf8');
  const engine = fs.readFileSync(path.join(repositoryRoot, 'backend/src/lib/execution-engine.ts'), 'utf8');
  for (const secret of ['RORCA_QUALIFICATION_TRUSTED_ISSUERS_JSON', 'RORCA_WAVE_PRODUCTION_ACTIVATION_KEY']) {
    assert.match(worker, new RegExp(`delete env\\.${secret}|${secret}: _`));
    assert.match(runner, new RegExp(`${secret}: _`));
    assert.match(engine, new RegExp(`k !== '${secret}'`));
  }
});

test('release-readiness migration is append-only, unique, additive, and never hand-manages pg-boss', () => {
  const repositoryRoot = fs.existsSync(path.resolve(process.cwd(), 'backend/src')) ? process.cwd() : path.resolve(process.cwd(), '..');
  const migration = fs.readFileSync(path.join(repositoryRoot, 'backend/src/db/pg-migrations/20260719105000_wave_release_readiness.sql'), 'utf8');
  assert.match(migration, /UNIQUE \(workspace_id, qualification_receipt_id, source_revision\)/);
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(migration, /release readiness packets are append-only/);
  assert.match(migration, /production activation approvals are append-only/);
  assert.match(migration, /NOT VALID/);
  assert.doesNotMatch(migration, /(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)[^;]*\bpgboss\b/i);
  assert.doesNotMatch(migration, /(?:DELETE FROM|TRUNCATE|UPDATE)\s+(?:workspaces|specs|pipeline_runs|story_results|wal_events)/i);
});
