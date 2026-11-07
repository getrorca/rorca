/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalTransaction } from '../db/index';
import { ConflictError, UnprocessableError } from './errors';

export const SUPABASE_AUTHORITY_QUALIFICATION_VERSION =
  'rorca.supabase-authority-qualification.v1' as const;
export const SUPABASE_AUTHORITY_QUALIFICATION_RECEIPT_VERSION =
  'rorca.supabase-authority-qualification-receipt.v1' as const;

const Sha256Schema = z.custom<`sha256:${string}`>(
  (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value),
);
const IdentifierSchema = z.string().min(1).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/);
const TimestampSchema = z.string().datetime({ offset: true });

export const SUPABASE_AUTHORITY_QUALIFICATION_PHASES = [
  'inspect-only',
  'backup-restore',
  'staging-mutation',
  'production-and-credentials',
] as const;
export type SupabaseAuthorityQualificationPhase =
  typeof SUPABASE_AUTHORITY_QUALIFICATION_PHASES[number];

export const SUPABASE_AUTHORITY_QUALIFIED_CAPABILITIES = [
  'database.schema.inspect',
  'database.backup.create',
  'database.backup.restore',
  'database.migration.apply.staging',
  'database.migration.apply.production',
  'credential.supabase.api-key.rotate',
  'credential.supabase.legacy-key.migrate',
  'credential.supabase.jwt-signing.rotate',
] as const;
export type SupabaseAuthorityQualifiedCapability =
  typeof SUPABASE_AUTHORITY_QUALIFIED_CAPABILITIES[number];

const QualifiedCapabilitySchema = z.enum(SUPABASE_AUTHORITY_QUALIFIED_CAPABILITIES);

export const SUPABASE_AUTHORITY_PHASE_CAPABILITIES = Object.freeze({
  'inspect-only': Object.freeze([
    'database.schema.inspect',
  ]),
  'backup-restore': Object.freeze([
    'database.schema.inspect',
    'database.backup.create',
    'database.backup.restore',
  ]),
  'staging-mutation': Object.freeze([
    'database.schema.inspect',
    'database.backup.create',
    'database.backup.restore',
    'database.migration.apply.staging',
  ]),
  'production-and-credentials': Object.freeze(SUPABASE_AUTHORITY_QUALIFIED_CAPABILITIES),
} satisfies Record<SupabaseAuthorityQualificationPhase, readonly SupabaseAuthorityQualifiedCapability[]>);

export const SUPABASE_AUTHORITY_DENIAL_CASES = [
  'altered-manifest',
  'replayed-request',
  'cross-workspace',
  'cross-environment',
  'deploy-grant-substitution',
  'credential-extraction',
] as const;
export type SupabaseAuthorityDenialCase = typeof SUPABASE_AUTHORITY_DENIAL_CASES[number];

export const SUPABASE_AUTHORITY_CRASH_BOUNDARIES = [
  'binding.generation.persist',
  'inspect.connection.open',
  'inspect.transaction.read-only',
  'backup.provider.create',
  'backup.artifact.persist',
  'restore.target.verify',
  'restore.provider.populate',
  'restore.integrity.verify',
  'staging.fencing-lock.acquire',
  'staging.attempt.persist',
  'staging.provider.apply',
  'staging.recovery.execute',
  'staging.receipt.settle',
  'production.external-gate.verify',
  'production.fencing-lock.acquire',
  'production.attempt.persist',
  'production.provider.apply',
  'production.recovery.execute',
  'production.receipt.settle',
  'credential.provider.create',
  'credential.secret-store.persist',
  'credential.runtime-binding.write',
  'credential.canary.verify',
  'credential.cutover.activate',
  'credential.old-material.revoke',
  'credential.receipt.settle',
] as const;
export type SupabaseAuthorityCrashBoundary = typeof SUPABASE_AUTHORITY_CRASH_BOUNDARIES[number];

const FixtureIdentitySchema = z.object({
  fixtureId: IdentifierSchema,
  owner: z.literal('rorca'),
  fixtureKind: z.enum(['disposable-project', 'provider-equivalent']),
  workspaceId: IdentifierSchema,
  projectRef: z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9-]+$/),
  databaseIdentityHash: Sha256Schema,
  bindingGeneration: z.number().int().positive(),
  environments: z.tuple([
    z.literal('scratch'),
    z.literal('staging'),
    z.literal('production-simulation'),
  ]),
  syntheticDataOnly: z.literal(true),
  customerDataPresent: z.literal(false),
  teardownRequired: z.literal(true),
  ownershipEvidenceHash: Sha256Schema,
  isolationEvidenceHash: Sha256Schema,
  teardownEvidenceHash: Sha256Schema,
}).strict();
export type SupabaseAuthorityFixtureIdentity = z.infer<typeof FixtureIdentitySchema>;
export const SUPABASE_SCHEMA_INVENTORY_KINDS = [
  'table',
  'column',
  'constraint',
  'index',
  'extension',
  'function',
  'rls-policy',
] as const;

const ReadOnlyInspectionEvidenceSchema = z.object({
  transactionMode: z.literal('read-only'),
  stableObjectIdentifiers: z.literal(true),
  inventoryKinds: z.array(z.enum(SUPABASE_SCHEMA_INVENTORY_KINDS))
    .length(SUPABASE_SCHEMA_INVENTORY_KINDS.length),
  inventoryHash: Sha256Schema,
  evidenceHash: Sha256Schema,
}).strict();

const ScratchRestoreQualificationEvidenceSchema = z.object({
  backupVerified: z.literal(true),
  sourceTargetDistinct: z.literal(true),
  targetEnvironment: z.literal('scratch'),
  expectedSchemaHash: Sha256Schema,
  restoredSchemaHash: Sha256Schema,
  dataChecksPassed: z.literal(true),
  evidenceHash: Sha256Schema,
}).strict();


const QualificationPhaseEvidenceSchema = z.object({
  sequence: z.number().int().min(1).max(SUPABASE_AUTHORITY_QUALIFICATION_PHASES.length),
  phase: z.enum(SUPABASE_AUTHORITY_QUALIFICATION_PHASES),
  status: z.literal('passed'),
  enabledCapabilities: z.array(QualifiedCapabilitySchema).nonempty(),
  receiptHashes: z.array(Sha256Schema).nonempty(),
  completedAt: TimestampSchema,
}).strict();
export type SupabaseAuthorityPhaseEvidence = z.infer<typeof QualificationPhaseEvidenceSchema>;

const RecoveryEvidenceBase = {
  fixtureId: IdentifierSchema,
  injectedFailure: z.literal(true),
  beforeSchemaHash: Sha256Schema,
  partialSchemaHash: Sha256Schema,
  declaredConsistentSchemaHash: Sha256Schema,
  resultingSchemaHash: Sha256Schema,
  statementOutcomeHashes: z.array(Sha256Schema).nonempty(),
  recoveryActionHashes: z.array(Sha256Schema).nonempty(),
  verificationEvidenceHashes: z.array(Sha256Schema).nonempty(),
  verificationPassed: z.literal(true),
  receiptHash: Sha256Schema,
} as const;

const ReversibleFailureEvidenceSchema = z.object({
  ...RecoveryEvidenceBase,
  classification: z.literal('reversible'),
  strategy: z.literal('rollback'),
}).strict();

const ForwardOnlyFailureEvidenceSchema = z.object({
  ...RecoveryEvidenceBase,
  classification: z.literal('forward-only'),
  strategy: z.enum(['forward-fix', 'scratch-restore']),
  backupArtifactRecordHash: Sha256Schema,
}).strict();

const FailureRecoveryEvidenceSchema = z.discriminatedUnion('classification', [
  ReversibleFailureEvidenceSchema,
  ForwardOnlyFailureEvidenceSchema,
]);
export type SupabaseAuthorityFailureRecoveryEvidence = z.infer<typeof FailureRecoveryEvidenceSchema>;

const DenialEvidenceSchema = z.object({
  case: z.enum(SUPABASE_AUTHORITY_DENIAL_CASES),
  status: z.literal('denied'),
  reasonCode: IdentifierSchema,
  deniedBeforeExternalMutation: z.literal(true),
  externalEffectCount: z.literal(0),
  evidenceHash: Sha256Schema,
}).strict();
export type SupabaseAuthorityDenialEvidence = z.infer<typeof DenialEvidenceSchema>;

const CrashEvidenceSchema = z.object({
  boundary: z.enum(SUPABASE_AUTHORITY_CRASH_BOUNDARIES),
  position: z.enum(['before', 'after']),
  reconciliationStatus: z.literal('consistent'),
  migrationApplyCount: z.number().int().min(0).max(1),
  createdCredentialCount: z.number().int().nonnegative(),
  persistedCredentialReferenceCount: z.number().int().nonnegative(),
  providerBindingGeneration: z.number().int().positive(),
  trackedBindingGeneration: z.number().int().positive(),
  durableReceiptCount: z.number().int().min(0).max(1),
  leaseState: z.enum(['not-issued', 'active', 'revoked']),
  evidenceHash: Sha256Schema,
}).strict();
export type SupabaseAuthorityCrashEvidence = z.infer<typeof CrashEvidenceSchema>;

const ProductionGateEvidenceSchema = z.object({
  simulationOnly: z.literal(true),
  independentGateRequired: z.literal(true),
  initialDecision: z.literal('waiting'),
  grantConsumedWhileWaiting: z.literal(false),
  finalDecision: z.literal('approved'),
  approverIndependent: z.literal(true),
  finalStatus: z.enum(['succeeded', 'aborted-consistent']),
  receiptHash: Sha256Schema,
}).strict();

const CeremonyStateSchema = z.enum([
  'planned',
  'replacement-bound',
  'standby',
  'canary-verified',
  'current',
  'revoked',
]);

const CeremonyEvidenceSchema = z.object({
  ceremonyType: z.enum(['api-key-rotation', 'legacy-key-migration', 'jwt-signing-rotation']),
  capability: z.enum([
    'credential.supabase.api-key.rotate',
    'credential.supabase.legacy-key.migrate',
    'credential.supabase.jwt-signing.rotate',
  ]),
  states: z.array(CeremonyStateSchema).nonempty(),
  canaryPassed: z.literal(true),
  rollbackReadyBeforeRevocation: z.literal(true),
  createdCredentialCount: z.number().int().positive(),
  persistedCredentialReferenceCount: z.number().int().positive(),
  targetBindingGeneration: z.number().int().positive(),
  trackedBindingGeneration: z.number().int().positive(),
  receiptHash: Sha256Schema,
}).strict();
export type SupabaseAuthorityCeremonyEvidence = z.infer<typeof CeremonyEvidenceSchema>;

export const SupabaseAuthorityQualificationReportSubjectSchema = z.object({
  version: z.literal(SUPABASE_AUTHORITY_QUALIFICATION_VERSION),
  fixture: FixtureIdentitySchema,
  readOnlyInspection: ReadOnlyInspectionEvidenceSchema,
  scratchRestore: ScratchRestoreQualificationEvidenceSchema,
  phases: z.array(QualificationPhaseEvidenceSchema).length(SUPABASE_AUTHORITY_QUALIFICATION_PHASES.length),
  failureRecoveries: z.array(FailureRecoveryEvidenceSchema).length(2),
  denials: z.array(DenialEvidenceSchema).length(SUPABASE_AUTHORITY_DENIAL_CASES.length),
  productionGate: ProductionGateEvidenceSchema,
  ceremonies: z.array(CeremonyEvidenceSchema).length(3),
  crashes: z.array(CrashEvidenceSchema).length(SUPABASE_AUTHORITY_CRASH_BOUNDARIES.length * 2),
  completedAt: TimestampSchema,
}).strict();
export type SupabaseAuthorityQualificationReportSubject =
  z.infer<typeof SupabaseAuthorityQualificationReportSubjectSchema>;

export const SupabaseAuthorityQualificationReportSchema =
  SupabaseAuthorityQualificationReportSubjectSchema.extend({
    reportDigest: Sha256Schema,
  }).strict();
export type SupabaseAuthorityQualificationReport =
  z.infer<typeof SupabaseAuthorityQualificationReportSchema>;

export const SupabaseAuthorityQualificationReceiptSchema = z.object({
  version: z.literal(SUPABASE_AUTHORITY_QUALIFICATION_RECEIPT_VERSION),
  receiptId: z.string().uuid(),
  fixtureId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  projectRef: z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9-]+$/),
  bindingGeneration: z.number().int().positive(),
  reportDigest: Sha256Schema,
  phaseEvidenceDigest: Sha256Schema,
  readinessEvidenceDigest: Sha256Schema,
  recoveryEvidenceDigest: Sha256Schema,
  denialEvidenceDigest: Sha256Schema,
  crashEvidenceDigest: Sha256Schema,
  ceremonyEvidenceDigest: Sha256Schema,
  qualifiedStages: z.array(z.enum(SUPABASE_AUTHORITY_QUALIFICATION_PHASES))
    .length(SUPABASE_AUTHORITY_QUALIFICATION_PHASES.length),
  qualifiedCapabilities: z.array(QualifiedCapabilitySchema)
    .length(SUPABASE_AUTHORITY_QUALIFIED_CAPABILITIES.length),
  preservedOperationalReceiptHashes: z.array(Sha256Schema).nonempty(),
  syntheticDataOnly: z.literal(true),
  qualifiedAt: TimestampSchema,
  receiptHash: Sha256Schema,
}).strict();
export type SupabaseAuthorityQualificationReceipt =
  z.infer<typeof SupabaseAuthorityQualificationReceiptSchema>;

function normalizeCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeCanonicalValue);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalizeCanonicalValue(nested)]);
    return Object.fromEntries(entries);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalValue(value));
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function reject(reason: string): never {
  throw new UnprocessableError(
    'Supabase authority qualification failed closed',
    'SUPABASE_AUTHORITY_QUALIFICATION_REJECTED',
    { reason },
  );
}

const SENSITIVE_FIELD_NAMES: Readonly<Record<string, true>> = Object.freeze({
  apikey: true,
  connectionstring: true,
  credentialbytes: true,
  encryptedvalue: true,
  password: true,
  privatekey: true,
  secretbytes: true,
  servicerolekey: true,
  signingkey: true,
  token: true,
});

function assertCredentialFree(value: unknown, seen = new Set<object>()): void {
  if (value instanceof Uint8Array) reject('credential_bytes_present');
  if (typeof value === 'string') {
    if (/postgres(?:ql)?:\/\//i.test(value)
      || /:\/\/[^/@:\s]+:[^/@\s]+@/.test(value)
      || /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(value)
      || /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i.test(value)
      || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value)) {
      reject('credential_material_present');
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) reject('cyclic_evidence_not_supported');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const nested of value) assertCredentialFree(nested, seen);
  } else {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_FIELD_NAMES[key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()]) {
        reject('credential_field_present');
      }
      assertCredentialFree(nested, seen);
    }
  }
  seen.delete(value);
}

function assertExactOrderedValues<T extends string>(
  actual: readonly T[],
  expected: readonly T[],
  reason: string,
): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    reject(reason);
  }
}

function assertUniqueHashes(hashes: readonly string[], reason: string): void {
  if (new Set(hashes).size !== hashes.length) reject(reason);
}

export function supabaseAuthorityQualificationReportDigest(
  rawSubject: SupabaseAuthorityQualificationReportSubject,
): `sha256:${string}` {
  assertCredentialFree(rawSubject);
  const subject = SupabaseAuthorityQualificationReportSubjectSchema.parse(rawSubject);
  return digest(subject);
}
function validateReadinessEvidence(
  report: Pick<SupabaseAuthorityQualificationReport, 'readOnlyInspection' | 'scratchRestore'>,
): void {
  assertExactOrderedValues(
    report.readOnlyInspection.inventoryKinds,
    SUPABASE_SCHEMA_INVENTORY_KINDS,
    'read_only_inventory_incomplete',
  );
  if (report.scratchRestore.restoredSchemaHash !== report.scratchRestore.expectedSchemaHash) {
    reject('scratch_restore_schema_inconsistent');
  }
}


function validatePhases(phases: readonly SupabaseAuthorityPhaseEvidence[]): void {
  const scratchCompleted = new Date(phases[1]!.completedAt).getTime();
  const stagingCompleted = new Date(phases[2]!.completedAt).getTime();
  if (scratchCompleted > stagingCompleted) reject('staging_enabled_before_scratch_restore_qualification');
  phases.forEach((phase, index) => {
    const expectedPhase = SUPABASE_AUTHORITY_QUALIFICATION_PHASES[index]!;
    if (phase.sequence !== index + 1 || phase.phase !== expectedPhase) reject('qualification_phase_order_invalid');
    assertExactOrderedValues(
      phase.enabledCapabilities,
      SUPABASE_AUTHORITY_PHASE_CAPABILITIES[expectedPhase],
      'qualification_phase_capabilities_invalid',
    );
    assertUniqueHashes(phase.receiptHashes, 'qualification_phase_receipt_replay');
    if (index > 0
      && new Date(phases[index - 1]!.completedAt).getTime() > new Date(phase.completedAt).getTime()) {
      reject('qualification_phase_completion_order_invalid');
    }
  });
}

function validateFailureRecoveries(
  recoveries: readonly SupabaseAuthorityFailureRecoveryEvidence[],
  fixtureId: string,
): void {
  const classifications = recoveries.map(({ classification }) => classification).sort();
  assertExactOrderedValues(classifications, ['forward-only', 'reversible'], 'failure_fixture_classification_incomplete');
  for (const recovery of recoveries) {
    if (recovery.fixtureId !== fixtureId) reject('failure_fixture_scope_mismatch');
    if (recovery.resultingSchemaHash !== recovery.declaredConsistentSchemaHash) {
      reject('failure_fixture_final_schema_inconsistent');
    }
    if (recovery.classification === 'reversible'
      && recovery.resultingSchemaHash !== recovery.beforeSchemaHash) {
      reject('reversible_fixture_prior_schema_not_restored');
    }
    assertUniqueHashes(recovery.statementOutcomeHashes, 'failure_fixture_statement_evidence_replayed');
    assertUniqueHashes(recovery.recoveryActionHashes, 'failure_fixture_recovery_evidence_replayed');
    assertUniqueHashes(recovery.verificationEvidenceHashes, 'failure_fixture_verification_evidence_replayed');
  }
}

function validateDenials(denials: readonly SupabaseAuthorityDenialEvidence[]): void {
  const actual = denials.map((evidence) => evidence.case).sort();
  const expected = [...SUPABASE_AUTHORITY_DENIAL_CASES].sort();
  assertExactOrderedValues(actual, expected, 'adversarial_denial_evidence_incomplete');
  assertUniqueHashes(denials.map(({ evidenceHash }) => evidenceHash), 'adversarial_denial_evidence_replayed');
}

function validateCrashes(crashes: readonly SupabaseAuthorityCrashEvidence[]): void {
  const expected = SUPABASE_AUTHORITY_CRASH_BOUNDARIES.flatMap((boundary) => [
    `${boundary}:after`,
    `${boundary}:before`,
  ]).sort();
  const actual = crashes.map(({ boundary, position }) => `${boundary}:${position}`).sort();
  assertExactOrderedValues(actual, expected, 'crash_boundary_evidence_incomplete');
  assertUniqueHashes(crashes.map(({ evidenceHash }) => evidenceHash), 'crash_evidence_replayed');
  for (const crash of crashes) {
    if (crash.createdCredentialCount !== crash.persistedCredentialReferenceCount) {
      reject('crash_lost_created_credential');
    }
    if (crash.providerBindingGeneration !== crash.trackedBindingGeneration) {
      reject('crash_left_untracked_binding_generation');
    }
  }
}

const CEREMONY_CONTRACTS = Object.freeze({
  'api-key-rotation': {
    capability: 'credential.supabase.api-key.rotate',
    states: ['planned', 'replacement-bound', 'canary-verified', 'current', 'revoked'],
  },
  'legacy-key-migration': {
    capability: 'credential.supabase.legacy-key.migrate',
    states: ['planned', 'replacement-bound', 'canary-verified', 'current', 'revoked'],
  },
  'jwt-signing-rotation': {
    capability: 'credential.supabase.jwt-signing.rotate',
    states: ['planned', 'standby', 'canary-verified', 'current', 'revoked'],
  },
} as const);

function validateCeremonies(ceremonies: readonly SupabaseAuthorityCeremonyEvidence[]): void {
  const expectedTypes = Object.keys(CEREMONY_CONTRACTS).sort();
  const actualTypes = ceremonies.map(({ ceremonyType }) => ceremonyType).sort();
  assertExactOrderedValues(actualTypes, expectedTypes, 'credential_ceremony_evidence_incomplete');
  for (const ceremony of ceremonies) {
    const contract = CEREMONY_CONTRACTS[ceremony.ceremonyType];
    if (ceremony.capability !== contract.capability) reject('credential_ceremony_capability_substitution');
    assertExactOrderedValues(ceremony.states, contract.states, 'credential_ceremony_state_order_invalid');
    if (ceremony.createdCredentialCount !== ceremony.persistedCredentialReferenceCount) {
      reject('credential_ceremony_created_material_untracked');
    }
    if (ceremony.targetBindingGeneration !== ceremony.trackedBindingGeneration) {
      reject('credential_ceremony_binding_generation_untracked');
    }
  }
}

function deterministicReceiptId(reportDigest: `sha256:${string}`): string {
  const hex = reportDigest.slice('sha256:'.length);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function operationalReceiptHashes(report: SupabaseAuthorityQualificationReport): `sha256:${string}`[] {
  const hashes = [
    ...report.phases.flatMap(({ receiptHashes }) => receiptHashes),
    ...report.failureRecoveries.map(({ receiptHash }) => receiptHash),
    report.productionGate.receiptHash,
    ...report.ceremonies.map(({ receiptHash }) => receiptHash),
  ];
  assertUniqueHashes(hashes, 'operational_receipt_replay_detected');
  return hashes;
}

export function qualifySupabaseAuthorityReport(rawReport: unknown): Readonly<SupabaseAuthorityQualificationReceipt> {
  assertCredentialFree(rawReport);
  let report: SupabaseAuthorityQualificationReport;
  try {
    report = SupabaseAuthorityQualificationReportSchema.parse(rawReport);
  } catch {
    return reject('qualification_report_schema_invalid');
  }
  const { reportDigest, ...subject } = report;
  if (reportDigest !== supabaseAuthorityQualificationReportDigest(subject)) {
    reject('qualification_report_digest_mismatch');
  }
  validateReadinessEvidence(report);
  validatePhases(report.phases);
  validateFailureRecoveries(report.failureRecoveries, report.fixture.fixtureId);
  validateDenials(report.denials);
  validateCrashes(report.crashes);
  validateCeremonies(report.ceremonies);
  if (report.productionGate.finalDecision !== 'approved'
    || !report.productionGate.approverIndependent
    || report.productionGate.grantConsumedWhileWaiting) {
    reject('production_simulation_gate_invalid');
  }
  if (new Date(report.completedAt).getTime()
    < new Date(report.phases.at(-1)!.completedAt).getTime()) {
    reject('qualification_completed_before_final_phase');
  }

  const receiptCore = {
    version: SUPABASE_AUTHORITY_QUALIFICATION_RECEIPT_VERSION,
    receiptId: deterministicReceiptId(report.reportDigest),
    fixtureId: report.fixture.fixtureId,
    workspaceId: report.fixture.workspaceId,
    projectRef: report.fixture.projectRef,
    bindingGeneration: report.fixture.bindingGeneration,
    reportDigest: report.reportDigest,
    readinessEvidenceDigest: digest({
      readOnlyInspection: report.readOnlyInspection,
      scratchRestore: report.scratchRestore,
    }),
    phaseEvidenceDigest: digest(report.phases),
    recoveryEvidenceDigest: digest(report.failureRecoveries),
    denialEvidenceDigest: digest(report.denials),
    crashEvidenceDigest: digest(report.crashes),
    ceremonyEvidenceDigest: digest(report.ceremonies),
    qualifiedStages: [...SUPABASE_AUTHORITY_QUALIFICATION_PHASES],
    qualifiedCapabilities: [...SUPABASE_AUTHORITY_QUALIFIED_CAPABILITIES],
    preservedOperationalReceiptHashes: operationalReceiptHashes(report),
    syntheticDataOnly: true as const,
    qualifiedAt: report.completedAt,
  };
  return Object.freeze(SupabaseAuthorityQualificationReceiptSchema.parse({
    ...receiptCore,
    receiptHash: digest(receiptCore),
  }));
}

export const SupabaseAuthorityRolloutStageSchema = z.enum([
  ...SUPABASE_AUTHORITY_QUALIFICATION_PHASES,
  'rolled-back',
]);
export type SupabaseAuthorityRolloutStage = z.infer<typeof SupabaseAuthorityRolloutStageSchema>;

const CapabilityLeaseSchema = z.object({
  leaseId: z.string().uuid(),
  capability: QualifiedCapabilitySchema.exclude(['database.schema.inspect']),
  bindingGeneration: z.number().int().positive(),
  state: z.enum(['active', 'revoked']),
  grantedAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
}).strict();
export type SupabaseAuthorityCapabilityLease = z.infer<typeof CapabilityLeaseSchema>;

export const SupabaseAuthorityRolloutSnapshotSchema = z.object({
  workspaceId: IdentifierSchema,
  fixtureId: IdentifierSchema,
  qualificationReceiptId: z.string().uuid(),
  qualificationReceiptHash: Sha256Schema,
  stage: SupabaseAuthorityRolloutStageSchema,
  enabledCapabilities: z.array(QualifiedCapabilitySchema).nonempty(),
  activeLeases: z.array(CapabilityLeaseSchema),
  revokedLeases: z.array(CapabilityLeaseSchema),
  preservedReceiptHashes: z.array(Sha256Schema).nonempty(),
  rollbackReason: z.string().min(1).max(1024).nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();
export type SupabaseAuthorityRolloutSnapshot = z.infer<typeof SupabaseAuthorityRolloutSnapshotSchema>;

export interface SupabaseAuthorityQualificationStore {
  persistQualification(
    report: SupabaseAuthorityQualificationReport,
    receipt: SupabaseAuthorityQualificationReceipt,
  ): Promise<SupabaseAuthorityQualificationReceipt>;
  loadQualification(receiptHash: `sha256:${string}`): Promise<SupabaseAuthorityQualificationReceipt | null>;
  createRollout(snapshot: SupabaseAuthorityRolloutSnapshot): Promise<SupabaseAuthorityRolloutSnapshot>;
  loadRollout(workspaceId: string): Promise<SupabaseAuthorityRolloutSnapshot | null>;
  saveRollout(
    snapshot: SupabaseAuthorityRolloutSnapshot,
    expectedRevision: number,
  ): Promise<SupabaseAuthorityRolloutSnapshot>;
}

interface QualificationReceiptRow { receipt_record: unknown }
interface RolloutRow { snapshot_record: unknown }

function parseReceiptRow(row: QualificationReceiptRow): SupabaseAuthorityQualificationReceipt {
  return SupabaseAuthorityQualificationReceiptSchema.parse(row.receipt_record);
}

function parseRolloutRow(row: RolloutRow): SupabaseAuthorityRolloutSnapshot {
  return SupabaseAuthorityRolloutSnapshotSchema.parse(row.snapshot_record);
}

export class PostgresSupabaseAuthorityQualificationStore implements SupabaseAuthorityQualificationStore {
  async persistQualification(
    report: SupabaseAuthorityQualificationReport,
    receipt: SupabaseAuthorityQualificationReceipt,
  ): Promise<SupabaseAuthorityQualificationReceipt> {
    return canonicalTransaction(async (client) => {
      await client.query(`INSERT INTO rorca.database_authority_qualification_receipts (
          id, workspace_id, fixture_id, fixture_kind, project_ref, binding_generation,
          report_digest, report_record, receipt_hash, receipt_record, qualified_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (report_digest) DO NOTHING`, [
        receipt.receiptId, receipt.workspaceId, receipt.fixtureId, report.fixture.fixtureKind,
        receipt.projectRef, receipt.bindingGeneration, receipt.reportDigest, JSON.stringify(report),
        receipt.receiptHash, JSON.stringify(receipt), receipt.qualifiedAt,
      ]);
      const result = await client.query<QualificationReceiptRow>(
        `SELECT receipt_record FROM rorca.database_authority_qualification_receipts
          WHERE report_digest = $1`,
        [receipt.reportDigest],
      );
      const persisted = result.rows[0] ? parseReceiptRow(result.rows[0]) : null;
      if (!persisted || canonicalJson(persisted) !== canonicalJson(receipt)) {
        throw new ConflictError('Qualification report digest replay changed its receipt');
      }
      return persisted;
    });
  }

  async loadQualification(
    receiptHash: `sha256:${string}`,
  ): Promise<SupabaseAuthorityQualificationReceipt | null> {
    return canonicalTransaction(async (client) => {
      const result = await client.query<QualificationReceiptRow>(
        `SELECT receipt_record FROM rorca.database_authority_qualification_receipts
          WHERE receipt_hash = $1`,
        [receiptHash],
      );
      return result.rows[0] ? parseReceiptRow(result.rows[0]) : null;
    });
  }

  async createRollout(
    snapshot: SupabaseAuthorityRolloutSnapshot,
  ): Promise<SupabaseAuthorityRolloutSnapshot> {
    return canonicalTransaction(async (client) => {
      await client.query(`INSERT INTO rorca.database_authority_rollout_controls (
          workspace_id, qualification_receipt_id, fixture_id, stage, enabled_capabilities,
          preserved_receipt_hashes, snapshot_record, revision, rollback_reason, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,NULL,$8,$8)
        ON CONFLICT (workspace_id) DO NOTHING`, [
        snapshot.workspaceId, snapshot.qualificationReceiptId, snapshot.fixtureId, snapshot.stage,
        snapshot.enabledCapabilities, snapshot.preservedReceiptHashes, JSON.stringify(snapshot),
        snapshot.createdAt,
      ]);
      const result = await client.query<RolloutRow>(
        'SELECT snapshot_record FROM rorca.database_authority_rollout_controls WHERE workspace_id = $1',
        [snapshot.workspaceId],
      );
      const persisted = result.rows[0] ? parseRolloutRow(result.rows[0]) : null;
      if (!persisted
        || persisted.qualificationReceiptHash !== snapshot.qualificationReceiptHash
        || persisted.fixtureId !== snapshot.fixtureId) {
        throw new ConflictError('Workspace already has a different database authority rollout');
      }
      return persisted;
    });
  }

  async loadRollout(workspaceId: string): Promise<SupabaseAuthorityRolloutSnapshot | null> {
    return canonicalTransaction(async (client) => {
      const result = await client.query<RolloutRow>(
        'SELECT snapshot_record FROM rorca.database_authority_rollout_controls WHERE workspace_id = $1',
        [workspaceId],
      );
      return result.rows[0] ? parseRolloutRow(result.rows[0]) : null;
    });
  }

  async saveRollout(
    snapshot: SupabaseAuthorityRolloutSnapshot,
    expectedRevision: number,
  ): Promise<SupabaseAuthorityRolloutSnapshot> {
    return canonicalTransaction(async (client) => {
      const currentResult = await client.query<RolloutRow & { revision: number }>(
        `SELECT snapshot_record, revision FROM rorca.database_authority_rollout_controls
          WHERE workspace_id = $1 FOR UPDATE`,
        [snapshot.workspaceId],
      );
      const currentRow = currentResult.rows[0];
      if (!currentRow || Number(currentRow.revision) !== expectedRevision) {
        throw new ConflictError('Database authority rollout changed concurrently');
      }
      const current = parseRolloutRow(currentRow);
      const priorActiveIds = new Set(current.activeLeases.map(({ leaseId }) => leaseId));
      const newActive = snapshot.activeLeases.filter(({ leaseId }) => !priorActiveIds.has(leaseId));
      const priorRevokedIds = new Set(current.revokedLeases.map(({ leaseId }) => leaseId));
      const newRevoked = snapshot.revokedLeases.filter(({ leaseId }) => !priorRevokedIds.has(leaseId));

      if (snapshot.stage === 'rolled-back') {
        for (const lease of newRevoked) {
          const revoked = await client.query(
            `UPDATE rorca.database_authority_capability_leases
                SET state = 'revoked', revoked_at = $2
              WHERE id = $1 AND workspace_id = $3 AND state = 'active'`,
            [lease.leaseId, lease.revokedAt, snapshot.workspaceId],
          );
          if (revoked.rowCount !== 1) throw new ConflictError('Capability lease changed during rollback');
        }
      }

      const updated = await client.query<RolloutRow>(`UPDATE rorca.database_authority_rollout_controls SET
          stage = $2, enabled_capabilities = $3, preserved_receipt_hashes = $4,
          snapshot_record = $5, revision = revision + 1, rollback_reason = $6, updated_at = $7
        WHERE workspace_id = $1 AND revision = $8
        RETURNING snapshot_record`, [
        snapshot.workspaceId, snapshot.stage, snapshot.enabledCapabilities,
        snapshot.preservedReceiptHashes, JSON.stringify(snapshot), snapshot.rollbackReason,
        snapshot.updatedAt, expectedRevision,
      ]);
      if (!updated.rows[0]) throw new ConflictError('Database authority rollout changed concurrently');

      for (const lease of newActive) {
        await client.query(`INSERT INTO rorca.database_authority_capability_leases (
            id, workspace_id, qualification_receipt_id, capability, binding_generation,
            state, granted_at
          ) VALUES ($1,$2,$3,$4,$5,'active',$6)`, [
          lease.leaseId, snapshot.workspaceId, snapshot.qualificationReceiptId,
          lease.capability, lease.bindingGeneration, lease.grantedAt,
        ]);
      }
      return parseRolloutRow(updated.rows[0]);
    });
  }
}

export interface SupabaseAuthorityQualificationDependencies {
  store: SupabaseAuthorityQualificationStore;
  now?: () => Date;
  leaseId?: () => string;
}

export class SupabaseAuthorityQualificationAuthority {
  private readonly now: () => Date;
  private readonly leaseId: () => string;

  constructor(private readonly dependencies: SupabaseAuthorityQualificationDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.leaseId = dependencies.leaseId ?? randomUUID;
  }

  async publish(rawReport: unknown): Promise<SupabaseAuthorityQualificationReceipt> {
    const receipt = qualifySupabaseAuthorityReport(rawReport);
    const report = SupabaseAuthorityQualificationReportSchema.parse(rawReport);
    return this.dependencies.store.persistQualification(report, receipt);
  }

  async startRollout(
    receiptHash: `sha256:${string}`,
  ): Promise<SupabaseAuthorityRolloutSnapshot> {
    const receipt = await this.dependencies.store.loadQualification(receiptHash);
    if (!receipt) reject('qualification_receipt_not_found');
    const now = this.now().toISOString();
    return this.dependencies.store.createRollout(SupabaseAuthorityRolloutSnapshotSchema.parse({
      workspaceId: receipt.workspaceId,
      fixtureId: receipt.fixtureId,
      qualificationReceiptId: receipt.receiptId,
      qualificationReceiptHash: receipt.receiptHash,
      stage: 'inspect-only',
      enabledCapabilities: [...SUPABASE_AUTHORITY_PHASE_CAPABILITIES['inspect-only']],
      activeLeases: [],
      revokedLeases: [],
      preservedReceiptHashes: receipt.preservedOperationalReceiptHashes,
      rollbackReason: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    }));
  }

  async advanceRollout(
    workspaceId: string,
    nextStage: SupabaseAuthorityQualificationPhase,
  ): Promise<SupabaseAuthorityRolloutSnapshot> {
    const current = await this.dependencies.store.loadRollout(workspaceId);
    if (!current) reject('rollout_not_found');
    if (current.stage === 'rolled-back') reject('rolled_back_rollout_cannot_advance');
    const currentIndex = SUPABASE_AUTHORITY_QUALIFICATION_PHASES.indexOf(current.stage);
    if (SUPABASE_AUTHORITY_QUALIFICATION_PHASES[currentIndex + 1] !== nextStage) {
      reject('rollout_phase_skip_or_replay');
    }
    const receipt = await this.dependencies.store.loadQualification(current.qualificationReceiptHash);
    if (!receipt
      || receipt.workspaceId !== workspaceId
      || receipt.fixtureId !== current.fixtureId
      || !receipt.qualifiedStages.includes(nextStage)) {
      reject('rollout_qualification_scope_invalid');
    }
    const now = this.now().toISOString();
    const activeCapabilities = new Set(current.activeLeases.map(({ capability }) => capability));
    const newLeases = SUPABASE_AUTHORITY_PHASE_CAPABILITIES[nextStage]
      .filter((capability) => capability !== 'database.schema.inspect' && !activeCapabilities.has(capability))
      .map((capability) => CapabilityLeaseSchema.parse({
        leaseId: this.leaseId(),
        capability,
        bindingGeneration: receipt.bindingGeneration,
        state: 'active',
        grantedAt: now,
        revokedAt: null,
      }));
    const next = SupabaseAuthorityRolloutSnapshotSchema.parse({
      ...current,
      stage: nextStage,
      enabledCapabilities: [...SUPABASE_AUTHORITY_PHASE_CAPABILITIES[nextStage]],
      activeLeases: [...current.activeLeases, ...newLeases],
      revision: current.revision + 1,
      updatedAt: now,
    });
    return this.dependencies.store.saveRollout(next, current.revision);
  }

  async rollback(
    workspaceId: string,
    reason: string,
  ): Promise<SupabaseAuthorityRolloutSnapshot> {
    const current = await this.dependencies.store.loadRollout(workspaceId);
    if (!current) reject('rollout_not_found');
    if (current.stage === 'rolled-back') return current;
    const now = this.now().toISOString();
    const newlyRevoked = current.activeLeases.map((lease) => CapabilityLeaseSchema.parse({
      ...lease,
      state: 'revoked',
      revokedAt: now,
    }));
    const rolledBack = SupabaseAuthorityRolloutSnapshotSchema.parse({
      ...current,
      stage: 'rolled-back',
      enabledCapabilities: [...SUPABASE_AUTHORITY_PHASE_CAPABILITIES['inspect-only']],
      activeLeases: [],
      revokedLeases: [...current.revokedLeases, ...newlyRevoked],
      rollbackReason: reason,
      revision: current.revision + 1,
      updatedAt: now,
    });
    return this.dependencies.store.saveRollout(rolledBack, current.revision);
  }
}
