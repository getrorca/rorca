/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash } from 'node:crypto';
import {
  SUPABASE_AUTHORITY_CRASH_BOUNDARIES,
  SUPABASE_AUTHORITY_DENIAL_CASES,
  SUPABASE_AUTHORITY_PHASE_CAPABILITIES,
  SUPABASE_AUTHORITY_QUALIFICATION_VERSION,
  SUPABASE_SCHEMA_INVENTORY_KINDS,
  supabaseAuthorityQualificationReportDigest,
  type SupabaseAuthorityCrashBoundary,
  type SupabaseAuthorityCrashEvidence,
  type SupabaseAuthorityQualificationReport,
  type SupabaseAuthorityQualificationReportSubject,
} from '../../supabase-authority-qualification';

const INITIAL_SCHEMA_HASH = evidenceHash('schema:initial');
const PARTIAL_REVERSIBLE_SCHEMA_HASH = evidenceHash('schema:partial-reversible');
const PARTIAL_FORWARD_SCHEMA_HASH = evidenceHash('schema:partial-forward');
const FORWARD_FIXED_SCHEMA_HASH = evidenceHash('schema:forward-fixed');
const BINDING_GENERATION = 7;

function evidenceHash(label: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(label, 'utf8').digest('hex')}`;
}

const FIXTURE_ID = 'rorca-supabase-provider-fixture';

interface FixtureTraceEvent {
  sequence: number;
  event: string;
  stagingMutationEnabled: boolean;
  schemaHash: `sha256:${string}`;
}

/**
 * Stateful provider-equivalent fixture. It models provider effects separately
 * from durable Rorca evidence so every injected crash must reconcile the two.
 */
export class ProviderEquivalentSupabaseQualificationFixture {
  private schemaHash = INITIAL_SCHEMA_HASH;
  private inspected = false;
  private scratchRestoreVerified = false;
  private stagingMutationEnabled = false;
  private sequence = 0;
  readonly trace: FixtureTraceEvent[] = [];

  private record(event: string): void {
    this.sequence += 1;
    this.trace.push({
      sequence: this.sequence,
      event,
      stagingMutationEnabled: this.stagingMutationEnabled,
      schemaHash: this.schemaHash,
    });
  }

  private inspectReadOnly(): void {
    if (this.stagingMutationEnabled) throw new Error('Fixture inspection must precede staging mutation');
    this.inspected = true;
    this.record('schema-inspection-passed');
  }

  private backupAndScratchRestore(): void {
    if (!this.inspected || this.stagingMutationEnabled) {
      throw new Error('Scratch restore requires prior read-only qualification');
    }
    const backupSchemaHash = this.schemaHash;
    const scratchSchemaHash = backupSchemaHash;
    if (scratchSchemaHash !== backupSchemaHash) throw new Error('Scratch restore schema mismatch');
    this.scratchRestoreVerified = true;
    this.record('backup-and-scratch-restore-passed');
  }

  private enableStagingMutation(): void {
    if (!this.inspected || !this.scratchRestoreVerified) {
      throw new Error('Staging mutation cannot be enabled before read-only and scratch restore qualification');
    }
    this.stagingMutationEnabled = true;
    this.record('staging-mutation-enabled');
  }

  private exerciseFailureRecoveries(): SupabaseAuthorityQualificationReportSubject['failureRecoveries'] {
    if (!this.stagingMutationEnabled) throw new Error('Failure fixtures require qualified staging mutation');

    this.schemaHash = PARTIAL_REVERSIBLE_SCHEMA_HASH;
    this.record('reversible-failure-injected');
    this.schemaHash = INITIAL_SCHEMA_HASH;
    this.record('reversible-rollback-verified');
    const reversible = {
      fixtureId: FIXTURE_ID,
      injectedFailure: true as const,
      beforeSchemaHash: INITIAL_SCHEMA_HASH,
      partialSchemaHash: PARTIAL_REVERSIBLE_SCHEMA_HASH,
      declaredConsistentSchemaHash: INITIAL_SCHEMA_HASH,
      resultingSchemaHash: this.schemaHash,
      statementOutcomeHashes: [evidenceHash('reversible:statement:failed')],
      recoveryActionHashes: [evidenceHash('reversible:rollback:applied')],
      verificationEvidenceHashes: [evidenceHash('reversible:prior-schema:verified')],
      verificationPassed: true as const,
      receiptHash: evidenceHash('reversible:recovery:receipt'),
      classification: 'reversible' as const,
      strategy: 'rollback' as const,
    };

    this.schemaHash = PARTIAL_FORWARD_SCHEMA_HASH;
    this.record('forward-only-failure-injected');
    this.schemaHash = FORWARD_FIXED_SCHEMA_HASH;
    this.record('forward-only-fix-verified');
    const forwardOnly = {
      fixtureId: FIXTURE_ID,
      injectedFailure: true as const,
      beforeSchemaHash: INITIAL_SCHEMA_HASH,
      partialSchemaHash: PARTIAL_FORWARD_SCHEMA_HASH,
      declaredConsistentSchemaHash: FORWARD_FIXED_SCHEMA_HASH,
      resultingSchemaHash: this.schemaHash,
      statementOutcomeHashes: [evidenceHash('forward-only:statement:failed')],
      recoveryActionHashes: [evidenceHash('forward-only:fix:applied')],
      verificationEvidenceHashes: [evidenceHash('forward-only:result-schema:verified')],
      verificationPassed: true as const,
      receiptHash: evidenceHash('forward-only:recovery:receipt'),
      classification: 'forward-only' as const,
      strategy: 'forward-fix' as const,
      backupArtifactRecordHash: evidenceHash('forward-only:backup:artifact-record'),
    };
    return [reversible, forwardOnly];
  }

  private crashEvidence(
    boundary: SupabaseAuthorityCrashBoundary,
    position: 'before' | 'after',
  ): SupabaseAuthorityCrashEvidence {
    const migrationEffects = new Set<string>();
    const createdCredentialFingerprints: string[] = [];
    const persistedCredentialFingerprints: string[] = [];
    let providerBindingGeneration = BINDING_GENERATION;
    let trackedBindingGeneration = BINDING_GENERATION;
    let durableReceiptCount = 0;

    const crashAfterBoundary = position === 'after';
    if (crashAfterBoundary && boundary === 'binding.generation.persist') {
      providerBindingGeneration += 1;
    }
    if (crashAfterBoundary
      && (boundary === 'staging.provider.apply' || boundary === 'production.provider.apply')) {
      migrationEffects.add(`${boundary}:manifest`);
    }
    if (boundary.startsWith('credential.')
      && crashAfterBoundary
      && boundary !== 'credential.provider.create') {
      createdCredentialFingerprints.push(evidenceHash(`${boundary}:created-material`));
    }
    if (crashAfterBoundary && boundary === 'credential.provider.create') {
      createdCredentialFingerprints.push(evidenceHash('credential.provider.create:created-material'));
    }
    if (crashAfterBoundary && boundary.endsWith('receipt.settle')) durableReceiptCount = 1;

    // Reconciliation observes provider state before retry. Sets represent exact
    // provider effects, so replay can settle evidence but cannot apply twice.
    trackedBindingGeneration = providerBindingGeneration;
    for (const fingerprint of createdCredentialFingerprints) {
      if (!persistedCredentialFingerprints.includes(fingerprint)) {
        persistedCredentialFingerprints.push(fingerprint);
      }
    }
    if (migrationEffects.size > 0) durableReceiptCount = 1;

    return {
      boundary,
      position,
      reconciliationStatus: 'consistent',
      migrationApplyCount: migrationEffects.size,
      createdCredentialCount: createdCredentialFingerprints.length,
      persistedCredentialReferenceCount: persistedCredentialFingerprints.length,
      providerBindingGeneration,
      trackedBindingGeneration,
      durableReceiptCount,
      leaseState: boundary.includes('receipt') ? 'revoked' : 'active',
      evidenceHash: evidenceHash(`crash:${boundary}:${position}`),
    };
  }

  run(): SupabaseAuthorityQualificationReport {
    this.inspectReadOnly();
    this.backupAndScratchRestore();
    this.enableStagingMutation();
    const failureRecoveries = this.exerciseFailureRecoveries();
    this.record('production-independent-gate-waiting');
    this.record('production-independent-gate-approved');
    this.record('credential-ceremonies-complete');

    const subject: SupabaseAuthorityQualificationReportSubject = {
      version: SUPABASE_AUTHORITY_QUALIFICATION_VERSION,
      fixture: {
        fixtureId: FIXTURE_ID,
        owner: 'rorca',
        fixtureKind: 'provider-equivalent',
        workspaceId: 'rorca-supabase-qualification',
        projectRef: 'rorca-synthetic-supabase-fixture',
        databaseIdentityHash: evidenceHash('fixture:database-identity'),
        bindingGeneration: BINDING_GENERATION,
        environments: ['scratch', 'staging', 'production-simulation'],
        syntheticDataOnly: true,
        customerDataPresent: false,
        teardownRequired: true,
        ownershipEvidenceHash: evidenceHash('fixture:rorca-ownership'),
        isolationEvidenceHash: evidenceHash('fixture:provider-equivalent-isolation'),
        teardownEvidenceHash: evidenceHash('fixture:teardown-policy'),
      },
      readOnlyInspection: {
        transactionMode: 'read-only',
        stableObjectIdentifiers: true,
        inventoryKinds: [...SUPABASE_SCHEMA_INVENTORY_KINDS],
        inventoryHash: evidenceHash('fixture:schema-inventory'),
        evidenceHash: evidenceHash('fixture:read-only-inspection'),
      },
      scratchRestore: {
        backupVerified: true,
        sourceTargetDistinct: true,
        targetEnvironment: 'scratch',
        expectedSchemaHash: INITIAL_SCHEMA_HASH,
        restoredSchemaHash: INITIAL_SCHEMA_HASH,
        dataChecksPassed: true,
        evidenceHash: evidenceHash('fixture:scratch-restore'),
      },
      phases: [
        {
          sequence: 1,
          phase: 'inspect-only',
          status: 'passed',
          enabledCapabilities: [...SUPABASE_AUTHORITY_PHASE_CAPABILITIES['inspect-only']],
          receiptHashes: [evidenceHash('phase:inspect-only:receipt')],
          completedAt: '2026-08-24T12:01:00.000Z',
        },
        {
          sequence: 2,
          phase: 'backup-restore',
          status: 'passed',
          enabledCapabilities: [...SUPABASE_AUTHORITY_PHASE_CAPABILITIES['backup-restore']],
          receiptHashes: [
            evidenceHash('phase:backup:receipt'),
            evidenceHash('phase:scratch-restore:receipt'),
          ],
          completedAt: '2026-08-24T12:02:00.000Z',
        },
        {
          sequence: 3,
          phase: 'staging-mutation',
          status: 'passed',
          enabledCapabilities: [...SUPABASE_AUTHORITY_PHASE_CAPABILITIES['staging-mutation']],
          receiptHashes: [evidenceHash('phase:staging:receipt')],
          completedAt: '2026-08-24T12:03:00.000Z',
        },
        {
          sequence: 4,
          phase: 'production-and-credentials',
          status: 'passed',
          enabledCapabilities: [...SUPABASE_AUTHORITY_PHASE_CAPABILITIES['production-and-credentials']],
          receiptHashes: [evidenceHash('phase:production-and-credentials:receipt')],
          completedAt: '2026-08-24T12:04:00.000Z',
        },
      ],
      failureRecoveries,
      denials: SUPABASE_AUTHORITY_DENIAL_CASES.map((denialCase) => ({
        case: denialCase,
        status: 'denied',
        reasonCode: `${denialCase.replaceAll('-', '_').toUpperCase()}_DENIED`,
        deniedBeforeExternalMutation: true,
        externalEffectCount: 0,
        evidenceHash: evidenceHash(`denial:${denialCase}`),
      })),
      productionGate: {
        simulationOnly: true,
        independentGateRequired: true,
        initialDecision: 'waiting',
        grantConsumedWhileWaiting: false,
        finalDecision: 'approved',
        approverIndependent: true,
        finalStatus: 'succeeded',
        receiptHash: evidenceHash('production-simulation:receipt'),
      },
      ceremonies: [
        {
          ceremonyType: 'api-key-rotation',
          capability: 'credential.supabase.api-key.rotate',
          states: ['planned', 'replacement-bound', 'canary-verified', 'current', 'revoked'],
          canaryPassed: true,
          rollbackReadyBeforeRevocation: true,
          createdCredentialCount: 2,
          persistedCredentialReferenceCount: 2,
          targetBindingGeneration: 8,
          trackedBindingGeneration: 8,
          receiptHash: evidenceHash('ceremony:api-key:receipt'),
        },
        {
          ceremonyType: 'legacy-key-migration',
          capability: 'credential.supabase.legacy-key.migrate',
          states: ['planned', 'replacement-bound', 'canary-verified', 'current', 'revoked'],
          canaryPassed: true,
          rollbackReadyBeforeRevocation: true,
          createdCredentialCount: 2,
          persistedCredentialReferenceCount: 2,
          targetBindingGeneration: 9,
          trackedBindingGeneration: 9,
          receiptHash: evidenceHash('ceremony:legacy-key:receipt'),
        },
        {
          ceremonyType: 'jwt-signing-rotation',
          capability: 'credential.supabase.jwt-signing.rotate',
          states: ['planned', 'standby', 'canary-verified', 'current', 'revoked'],
          canaryPassed: true,
          rollbackReadyBeforeRevocation: true,
          createdCredentialCount: 1,
          persistedCredentialReferenceCount: 1,
          targetBindingGeneration: 10,
          trackedBindingGeneration: 10,
          receiptHash: evidenceHash('ceremony:jwt-signing:receipt'),
        },
      ],
      crashes: SUPABASE_AUTHORITY_CRASH_BOUNDARIES.flatMap((boundary) => [
        this.crashEvidence(boundary, 'before'),
        this.crashEvidence(boundary, 'after'),
      ]),
      completedAt: '2026-08-24T12:05:00.000Z',
    };
    return {
      ...subject,
      reportDigest: supabaseAuthorityQualificationReportDigest(subject),
    };
  }
}
