/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SUPABASE_AUTHORITY_CRASH_BOUNDARIES,
  SUPABASE_AUTHORITY_DENIAL_CASES,
  SUPABASE_AUTHORITY_PHASE_CAPABILITIES,
  SupabaseAuthorityQualificationAuthority,
  qualifySupabaseAuthorityReport,
  supabaseAuthorityQualificationReportDigest,
  type SupabaseAuthorityQualificationReceipt,
  type SupabaseAuthorityQualificationReport,
  type SupabaseAuthorityQualificationStore,
  type SupabaseAuthorityRolloutSnapshot,
} from '../supabase-authority-qualification';
import { AppError } from '../errors';
import { ProviderEquivalentSupabaseQualificationFixture } from './fixtures/supabase-authority-qualification.fixture';

class MemoryQualificationStore implements SupabaseAuthorityQualificationStore {
  private readonly receipts = new Map<string, {
    report: SupabaseAuthorityQualificationReport;
    receipt: SupabaseAuthorityQualificationReceipt;
  }>();
  private readonly rollouts = new Map<string, SupabaseAuthorityRolloutSnapshot>();

  async persistQualification(
    report: SupabaseAuthorityQualificationReport,
    receipt: SupabaseAuthorityQualificationReceipt,
  ): Promise<SupabaseAuthorityQualificationReceipt> {
    const existing = this.receipts.get(receipt.receiptHash);
    if (existing) {
      assert.deepEqual(existing.report, report);
      assert.deepEqual(existing.receipt, receipt);
      return structuredClone(existing.receipt);
    }
    this.receipts.set(receipt.receiptHash, {
      report: structuredClone(report),
      receipt: structuredClone(receipt),
    });
    return structuredClone(receipt);
  }

  async loadQualification(
    receiptHash: `sha256:${string}`,
  ): Promise<SupabaseAuthorityQualificationReceipt | null> {
    const stored = this.receipts.get(receiptHash);
    return stored ? structuredClone(stored.receipt) : null;
  }

  async createRollout(snapshot: SupabaseAuthorityRolloutSnapshot): Promise<SupabaseAuthorityRolloutSnapshot> {
    const existing = this.rollouts.get(snapshot.workspaceId);
    if (existing) return structuredClone(existing);
    this.rollouts.set(snapshot.workspaceId, structuredClone(snapshot));
    return structuredClone(snapshot);
  }

  async loadRollout(workspaceId: string): Promise<SupabaseAuthorityRolloutSnapshot | null> {
    const stored = this.rollouts.get(workspaceId);
    return stored ? structuredClone(stored) : null;
  }

  async saveRollout(
    snapshot: SupabaseAuthorityRolloutSnapshot,
    expectedRevision: number,
  ): Promise<SupabaseAuthorityRolloutSnapshot> {
    const existing = this.rollouts.get(snapshot.workspaceId);
    if (!existing || existing.revision !== expectedRevision) {
      throw new Error('Concurrent fixture rollout update');
    }
    this.rollouts.set(snapshot.workspaceId, structuredClone(snapshot));
    return structuredClone(snapshot);
  }
}

function rejectedFor(reason: string): (error: unknown) => boolean {
  return (error) => error instanceof AppError
    && error.code === 'SUPABASE_AUTHORITY_QUALIFICATION_REJECTED'
    && error.details?.reason === reason;
}

function reseal(report: SupabaseAuthorityQualificationReport): SupabaseAuthorityQualificationReport {
  const { reportDigest: _discarded, ...subject } = report;
  return {
    ...subject,
    reportDigest: supabaseAuthorityQualificationReportDigest(subject),
  };
}

function qualificationAuthority(store = new MemoryQualificationStore()) {
  let leaseOrdinal = 0;
  return {
    authority: new SupabaseAuthorityQualificationAuthority({
      store,
      now: () => new Date('2026-08-24T13:00:00.000Z'),
      leaseId: () => {
        leaseOrdinal += 1;
        return `aaaaaaaa-aaaa-4aaa-8aaa-${String(leaseOrdinal).padStart(12, '0')}`;
      },
    }),
    store,
  };
}

test('provider-equivalent qualification runs read-only and scratch restore before staging mutation', () => {
  const fixture = new ProviderEquivalentSupabaseQualificationFixture();
  const report = fixture.run();
  const receipt = qualifySupabaseAuthorityReport(report);

  assert.deepEqual(
    fixture.trace.slice(0, 3).map(({ event, stagingMutationEnabled }) => ({ event, stagingMutationEnabled })),
    [
      { event: 'schema-inspection-passed', stagingMutationEnabled: false },
      { event: 'backup-and-scratch-restore-passed', stagingMutationEnabled: false },
      { event: 'staging-mutation-enabled', stagingMutationEnabled: true },
    ],
  );
  assert.equal(report.readOnlyInspection.transactionMode, 'read-only');
  assert.equal(report.readOnlyInspection.stableObjectIdentifiers, true);
  assert.equal(report.readOnlyInspection.inventoryKinds.length, 7);
  assert.equal(report.scratchRestore.backupVerified, true);
  assert.equal(report.scratchRestore.sourceTargetDistinct, true);
  assert.equal(report.scratchRestore.restoredSchemaHash, report.scratchRestore.expectedSchemaHash);
  assert.deepEqual(receipt.qualifiedStages, [
    'inspect-only',
    'backup-restore',
    'staging-mutation',
    'production-and-credentials',
  ]);
  assert.equal(receipt.syntheticDataOnly, true);
  assert.equal(receipt.fixtureId, report.fixture.fixtureId);
  assert.ok(receipt.preservedOperationalReceiptHashes.length >= 10);
});

test('reversible and forward-only failures settle their declared consistent schemas with complete evidence', () => {
  const report = new ProviderEquivalentSupabaseQualificationFixture().run();
  const receipt = qualifySupabaseAuthorityReport(report);
  const reversible = report.failureRecoveries.find(({ classification }) => classification === 'reversible');
  const forwardOnly = report.failureRecoveries.find(({ classification }) => classification === 'forward-only');

  assert.ok(reversible);
  assert.equal(reversible.strategy, 'rollback');
  assert.equal(reversible.resultingSchemaHash, reversible.beforeSchemaHash);
  assert.ok(reversible.statementOutcomeHashes.length > 0);
  assert.ok(reversible.recoveryActionHashes.length > 0);
  assert.ok(reversible.verificationEvidenceHashes.length > 0);
  assert.ok(forwardOnly);
  assert.equal(forwardOnly.resultingSchemaHash, forwardOnly.declaredConsistentSchemaHash);
  assert.ok(forwardOnly.backupArtifactRecordHash);
  assert.equal(receipt.recoveryEvidenceDigest.startsWith('sha256:'), true);
});

test('altered evidence, phase skips, denial omissions, and credential-bearing evidence fail closed', () => {
  const valid = new ProviderEquivalentSupabaseQualificationFixture().run();

  const alteredDigest = structuredClone(valid);
  alteredDigest.failureRecoveries[0]!.resultingSchemaHash = alteredDigest.failureRecoveries[0]!.partialSchemaHash;
  assert.throws(
    () => qualifySupabaseAuthorityReport(alteredDigest),
    rejectedFor('qualification_report_digest_mismatch'),
  );

  const earlyStaging = structuredClone(valid);
  earlyStaging.phases[2]!.completedAt = '2026-08-24T12:01:30.000Z';
  assert.throws(
    () => qualifySupabaseAuthorityReport(reseal(earlyStaging)),
    rejectedFor('staging_enabled_before_scratch_restore_qualification'),
  );

  const missingDenial = structuredClone(valid) as unknown as Record<string, unknown>;
  missingDenial.denials = valid.denials.slice(1);
  assert.throws(
    () => qualifySupabaseAuthorityReport(missingDenial),
    rejectedFor('qualification_report_schema_invalid'),
  );
  const inconsistentRestore = structuredClone(valid);
  inconsistentRestore.scratchRestore.restoredSchemaHash = inconsistentRestore.failureRecoveries[1]!.resultingSchemaHash;
  assert.throws(
    () => qualifySupabaseAuthorityReport(reseal(inconsistentRestore)),
    rejectedFor('scratch_restore_schema_inconsistent'),
  );

  const replayedDenialEvidence = structuredClone(valid);
  replayedDenialEvidence.denials[1]!.evidenceHash = replayedDenialEvidence.denials[0]!.evidenceHash;
  assert.throws(
    () => qualifySupabaseAuthorityReport(reseal(replayedDenialEvidence)),
    rejectedFor('adversarial_denial_evidence_replayed'),
  );


  const credentialBearing = {
    ...valid,
    operatorCapture: `Bearer ${['synthetic', 'credential', 'bytes'].join('-')}`,
  };
  assert.throws(
    () => qualifySupabaseAuthorityReport(credentialBearing),
    rejectedFor('credential_material_present'),
  );
});

test('all cross-scope, replay, grant-substitution, and extraction probes are denied before effects', () => {
  const report = new ProviderEquivalentSupabaseQualificationFixture().run();
  qualifySupabaseAuthorityReport(report);
  assert.deepEqual(
    report.denials.map(({ case: denialCase }) => denialCase).sort(),
    [...SUPABASE_AUTHORITY_DENIAL_CASES].sort(),
  );
  for (const denial of report.denials) {
    assert.equal(denial.status, 'denied');
    assert.equal(denial.deniedBeforeExternalMutation, true);
    assert.equal(denial.externalEffectCount, 0);
  }
});

test('crash evidence covers both sides of every external boundary without duplicate effects or lost authority state', () => {
  const valid = new ProviderEquivalentSupabaseQualificationFixture().run();
  const receipt = qualifySupabaseAuthorityReport(valid);
  assert.equal(valid.crashes.length, SUPABASE_AUTHORITY_CRASH_BOUNDARIES.length * 2);
  for (const boundary of SUPABASE_AUTHORITY_CRASH_BOUNDARIES) {
    assert.ok(valid.crashes.some((crash) => crash.boundary === boundary && crash.position === 'before'));
    assert.ok(valid.crashes.some((crash) => crash.boundary === boundary && crash.position === 'after'));
  }
  for (const crash of valid.crashes) {
    assert.ok(crash.migrationApplyCount <= 1);
    assert.equal(crash.createdCredentialCount, crash.persistedCredentialReferenceCount);
    assert.equal(crash.providerBindingGeneration, crash.trackedBindingGeneration);
  }
  assert.equal(receipt.crashEvidenceDigest.startsWith('sha256:'), true);

  const lostCredential = structuredClone(valid);
  lostCredential.crashes[0]!.createdCredentialCount = 1;
  lostCredential.crashes[0]!.persistedCredentialReferenceCount = 0;
  assert.throws(
    () => qualifySupabaseAuthorityReport(reseal(lostCredential)),
    rejectedFor('crash_lost_created_credential'),
  );

  const untrackedGeneration = structuredClone(valid);
  untrackedGeneration.crashes[0]!.providerBindingGeneration += 1;
  assert.throws(
    () => qualifySupabaseAuthorityReport(reseal(untrackedGeneration)),
    rejectedFor('crash_left_untracked_binding_generation'),
  );
});

test('all three ceremony state machines retain created references and tracked generations', () => {
  const valid = new ProviderEquivalentSupabaseQualificationFixture().run();
  qualifySupabaseAuthorityReport(valid);
  assert.deepEqual(
    valid.ceremonies.map(({ ceremonyType }) => ceremonyType).sort(),
    ['api-key-rotation', 'jwt-signing-rotation', 'legacy-key-migration'],
  );
  for (const ceremony of valid.ceremonies) {
    assert.equal(ceremony.states.at(-1), 'revoked');
    assert.equal(ceremony.createdCredentialCount, ceremony.persistedCredentialReferenceCount);
    assert.equal(ceremony.targetBindingGeneration, ceremony.trackedBindingGeneration);
    assert.equal(ceremony.rollbackReadyBeforeRevocation, true);
  }
});

test('rollout cannot skip phases; rollback revokes every mutation lease and preserves receipts', async () => {
  const fixture = new ProviderEquivalentSupabaseQualificationFixture();
  const report = fixture.run();
  const { authority } = qualificationAuthority();
  const receipt = await authority.publish(report);
  assert.deepEqual(await authority.publish(report), receipt, 'qualification publication is idempotent');

  const inspectOnly = await authority.startRollout(receipt.receiptHash);
  assert.equal(inspectOnly.stage, 'inspect-only');
  assert.deepEqual(inspectOnly.enabledCapabilities, SUPABASE_AUTHORITY_PHASE_CAPABILITIES['inspect-only']);
  assert.equal(inspectOnly.activeLeases.length, 0);
  await assert.rejects(
    authority.advanceRollout(inspectOnly.workspaceId, 'staging-mutation'),
    rejectedFor('rollout_phase_skip_or_replay'),
  );

  const backupRestore = await authority.advanceRollout(inspectOnly.workspaceId, 'backup-restore');
  assert.equal(backupRestore.stage, 'backup-restore');
  assert.equal(backupRestore.activeLeases.length, 2);
  assert.equal(backupRestore.enabledCapabilities.includes('database.migration.apply.staging'), false);

  const staging = await authority.advanceRollout(inspectOnly.workspaceId, 'staging-mutation');
  assert.equal(staging.stage, 'staging-mutation');
  assert.equal(staging.activeLeases.length, 3);

  const full = await authority.advanceRollout(inspectOnly.workspaceId, 'production-and-credentials');
  assert.equal(full.activeLeases.length, 7);
  const preservedBeforeRollback = [...full.preservedReceiptHashes];
  const rolledBack = await authority.rollback(inspectOnly.workspaceId, 'synthetic qualification rollback drill');
  assert.equal(rolledBack.stage, 'rolled-back');
  assert.deepEqual(rolledBack.enabledCapabilities, ['database.schema.inspect']);
  assert.equal(rolledBack.activeLeases.length, 0);
  assert.equal(rolledBack.revokedLeases.length, 7);
  assert.ok(rolledBack.revokedLeases.every(({ state, revokedAt }) => state === 'revoked' && revokedAt !== null));
  assert.deepEqual(rolledBack.preservedReceiptHashes, preservedBeforeRollback);
  assert.deepEqual(await authority.rollback(inspectOnly.workspaceId, 'replayed rollback'), rolledBack);
  await assert.rejects(
    authority.advanceRollout(inspectOnly.workspaceId, 'backup-restore'),
    rejectedFor('rolled_back_rollout_cannot_advance'),
  );
});
