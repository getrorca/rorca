/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { canonicalTransaction } from '../db/index';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from './errors';

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const UuidSchema = z.string().uuid();
const IdentifierSchema = z.string().min(1).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/);
const SecretStoreReferenceSchema = z.string().min(1).max(1024)
  .regex(/^[a-z][a-z0-9+.-]{1,31}:\/\/[^\s]+$/)
  .refine((value) => !/^(?:https?|postgres(?:ql)?):\/\//i.test(value), {
    message: 'Expected an opaque SecretStore reference',
  });
const TimestampSchema = z.string().datetime({ offset: true });

export const SUPABASE_CREDENTIAL_CEREMONY_TYPES = [
  'api-key-rotation',
  'legacy-key-migration',
  'jwt-signing-rotation',
] as const;
export type SupabaseCredentialCeremonyType = typeof SUPABASE_CREDENTIAL_CEREMONY_TYPES[number];

export const SUPABASE_CREDENTIAL_CEREMONY_CAPABILITIES = [
  'credential.supabase.api-key.rotate',
  'credential.supabase.legacy-key.migrate',
  'credential.supabase.jwt-signing.rotate',
] as const;
export type SupabaseCredentialCeremonyCapability = typeof SUPABASE_CREDENTIAL_CEREMONY_CAPABILITIES[number];

export const CredentialMaterialClassSchema = z.enum([
  'application-publishable',
  'application-secret',
  'application-anon',
  'application-service-role',
  'jwt-signing',
]);
export type CredentialMaterialClass = z.infer<typeof CredentialMaterialClassSchema>;

const BindingInventoryEntrySchema = z.object({
  consumerId: IdentifierSchema,
  bindingId: UuidSchema,
  component: z.string().min(1).max(255),
  environment: z.enum(['staging', 'production']),
  materialClass: CredentialMaterialClassSchema,
  referenceId: SecretStoreReferenceSchema,
  fingerprint: Sha256Schema,
  generation: z.number().int().positive(),
}).strict();
export type CredentialBindingInventoryEntry = z.infer<typeof BindingInventoryEntrySchema>;

const ReplacementSlotSchema = z.object({
  slotId: IdentifierSchema,
  materialClass: z.enum(['application-publishable', 'application-secret', 'jwt-signing']),
  consumerIds: z.array(IdentifierSchema).min(1).max(1_000),
}).strict().superRefine((slot, context) => {
  if (new Set(slot.consumerIds).size !== slot.consumerIds.length) {
    context.addIssue({ code: 'custom', message: 'Replacement slot consumerIds must be unique' });
  }
});
export type CredentialReplacementSlot = z.infer<typeof ReplacementSlotSchema>;

const CeremonyScopeSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  projectRef: z.string().min(3).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  environment: z.enum(['staging', 'production']),
  credentialBindingId: UuidSchema,
  bindingGeneration: z.number().int().positive(),
}).strict();

const CanaryPolicySchema = z.object({
  canaryId: IdentifierSchema,
  kind: z.enum(['runtime-auth', 'consumer-replacement', 'jwt-zero-downtime']),
  expectedResultDigest: Sha256Schema,
  verifierId: IdentifierSchema,
}).strict();

const CutoverPolicySchema = z.object({
  cutoverId: IdentifierSchema,
  strategy: z.enum(['atomic', 'rolling']),
  targetBindingGeneration: z.number().int().positive(),
  maxPropagationSeconds: z.number().int().min(0).max(86_400),
}).strict();

const GraceRevocationPolicySchema = z.object({
  gracePeriodSeconds: z.number().int().min(0).max(2_592_000),
  revokeNotBefore: TimestampSchema,
  requireExactCanaryReplay: z.literal(true),
  requireRollbackReadiness: z.literal(true),
}).strict();

const RecoveryProcedureSchema = z.object({
  procedureId: IdentifierSchema,
  owner: z.string().min(1).max(255),
  rollbackBindingInventoryDigest: Sha256Schema,
  testedAt: TimestampSchema,
}).strict();

const CommonRequestShape = {
  ceremonyId: UuidSchema,
  authorityGrantId: UuidSchema,
  idempotencyKey: z.string().min(8).max(255),
  scope: CeremonyScopeSchema,
  bindingInventory: z.array(BindingInventoryEntrySchema).min(1).max(1_000),
  replacementSlots: z.array(ReplacementSlotSchema).min(1).max(16),
  bindingInventoryDigest: Sha256Schema,
  canary: CanaryPolicySchema,
  cutover: CutoverPolicySchema,
  revocation: GraceRevocationPolicySchema,
  recovery: RecoveryProcedureSchema,
};

export const ApiKeyRotationRequestSchema = z.object({
  ...CommonRequestShape,
  ceremonyType: z.literal('api-key-rotation'),
  capability: z.literal('credential.supabase.api-key.rotate'),
}).strict();

export const LegacyKeyMigrationRequestSchema = z.object({
  ...CommonRequestShape,
  ceremonyType: z.literal('legacy-key-migration'),
  capability: z.literal('credential.supabase.legacy-key.migrate'),
}).strict();

export const JwtSigningRotationRequestSchema = z.object({
  ...CommonRequestShape,
  ceremonyType: z.literal('jwt-signing-rotation'),
  capability: z.literal('credential.supabase.jwt-signing.rotate'),
}).strict();

export const SupabaseCredentialCeremonyRequestSchema = z.discriminatedUnion('ceremonyType', [
  ApiKeyRotationRequestSchema,
  LegacyKeyMigrationRequestSchema,
  JwtSigningRotationRequestSchema,
]);
export type SupabaseCredentialCeremonyRequest = z.infer<typeof SupabaseCredentialCeremonyRequestSchema>;

const ConsumerCanaryResultSchema = z.object({
  consumerId: IdentifierSchema,
  replacementFingerprint: Sha256Schema,
  passed: z.literal(true),
  evidenceDigest: Sha256Schema,
}).strict();

const CanaryEvidenceBaseShape = {
  canaryId: IdentifierSchema,
  observedResultDigest: Sha256Schema,
  verifierId: IdentifierSchema,
  verifiedAt: TimestampSchema,
  consumerResults: z.array(ConsumerCanaryResultSchema).min(1).max(1_000),
};

const ApiKeyCanaryEvidenceSchema = z.object({
  ...CanaryEvidenceBaseShape,
  ceremonyType: z.literal('api-key-rotation'),
}).strict();
const LegacyCanaryEvidenceSchema = z.object({
  ...CanaryEvidenceBaseShape,
  ceremonyType: z.literal('legacy-key-migration'),
}).strict();
const JwtCanaryEvidenceSchema = z.object({
  ...CanaryEvidenceBaseShape,
  ceremonyType: z.literal('jwt-signing-rotation'),
  tokenBehavior: z.object({
    oldTokenAccepted: z.literal(true),
    newTokenAccepted: z.literal(true),
    overlapVerified: z.literal(true),
    evidenceDigest: Sha256Schema,
  }).strict(),
}).strict();

export const CredentialCanaryEvidenceSchema = z.discriminatedUnion('ceremonyType', [
  ApiKeyCanaryEvidenceSchema,
  LegacyCanaryEvidenceSchema,
  JwtCanaryEvidenceSchema,
]);
export type CredentialCanaryEvidence = z.infer<typeof CredentialCanaryEvidenceSchema>;

export const CredentialCutoverEvidenceSchema = z.object({
  cutoverId: IdentifierSchema,
  targetBindingGeneration: z.number().int().positive(),
  completedAt: TimestampSchema,
  evidenceDigest: Sha256Schema,
}).strict();
export type CredentialCutoverEvidence = z.infer<typeof CredentialCutoverEvidenceSchema>;

const RevocationEvidenceBaseShape = {
  canaryId: IdentifierSchema,
  observedResultDigest: Sha256Schema,
  recoveryProcedureId: IdentifierSchema,
  rollbackBindingInventoryDigest: Sha256Schema,
  rollbackReadinessPassed: z.literal(true),
  verifiedAt: TimestampSchema,
  evidenceDigest: Sha256Schema,
};
const ApiKeyRevocationEvidenceSchema = z.object({
  ...RevocationEvidenceBaseShape,
  ceremonyType: z.literal('api-key-rotation'),
}).strict();
const LegacyRevocationEvidenceSchema = z.object({
  ...RevocationEvidenceBaseShape,
  ceremonyType: z.literal('legacy-key-migration'),
}).strict();
const JwtRevocationEvidenceSchema = z.object({
  ...RevocationEvidenceBaseShape,
  ceremonyType: z.literal('jwt-signing-rotation'),
  postRevocationTokenBehavior: z.object({
    oldTokenRejected: z.literal(true),
    newTokenAccepted: z.literal(true),
    evidenceDigest: Sha256Schema,
  }).strict(),
}).strict();
export const CredentialRevocationEvidenceSchema = z.discriminatedUnion('ceremonyType', [
  ApiKeyRevocationEvidenceSchema,
  LegacyRevocationEvidenceSchema,
  JwtRevocationEvidenceSchema,
]);
export type CredentialRevocationEvidence = z.infer<typeof CredentialRevocationEvidenceSchema>;

export const CapturedCredentialReferenceSchema = z.object({
  slotId: IdentifierSchema,
  materialClass: z.enum(['application-publishable', 'application-secret', 'jwt-signing']),
  referenceId: SecretStoreReferenceSchema,
  fingerprint: Sha256Schema,
  capturedAt: TimestampSchema,
  keyState: z.enum(['standby', 'current', 'revoked']),
}).strict();
export type CapturedCredentialReference = z.infer<typeof CapturedCredentialReferenceSchema>;

export const CredentialCeremonyStateSchema = z.enum([
  'planned',
  'replacement-bound',
  'standby',
  'canary-verified',
  'current',
  'revoked',
]);
export type CredentialCeremonyState = z.infer<typeof CredentialCeremonyStateSchema>;

export const CredentialCeremonyReceiptSchema = z.object({
  version: z.enum([
    'rorca.supabase-api-key-rotation-receipt.v1',
    'rorca.supabase-legacy-key-migration-receipt.v1',
    'rorca.supabase-jwt-signing-rotation-receipt.v1',
  ]),
  receiptId: UuidSchema,
  ceremonyId: UuidSchema,
  ceremonyType: z.enum(SUPABASE_CREDENTIAL_CEREMONY_TYPES),
  capability: z.enum(SUPABASE_CREDENTIAL_CEREMONY_CAPABILITIES),
  authorityGrantId: UuidSchema,
  requestDigest: Sha256Schema,
  scope: CeremonyScopeSchema,
  bindingInventoryDigest: Sha256Schema,
  replacements: z.array(CapturedCredentialReferenceSchema).min(1),
  canaryEvidenceDigest: Sha256Schema,
  cutoverEvidenceDigest: Sha256Schema,
  revocationEvidenceDigest: Sha256Schema,
  recoveryProcedureId: IdentifierSchema,
  revokedReferenceIds: z.array(SecretStoreReferenceSchema).min(1),
  finalKeyStates: z.array(z.object({
    fingerprint: Sha256Schema,
    state: z.enum(['current', 'revoked']),
  }).strict()).min(2),
  settledAt: TimestampSchema,
}).strict().superRefine((receipt, context) => {
  const expectedCapability = capabilityForCeremony(receipt.ceremonyType);
  if (receipt.capability !== expectedCapability) {
    context.addIssue({ code: 'custom', message: 'Receipt capability does not match ceremony type' });
  }
  const expectedVersion = receiptVersionForCeremony(receipt.ceremonyType);
  if (receipt.version !== expectedVersion) {
    context.addIssue({ code: 'custom', message: 'Receipt version does not match ceremony type' });
  }
});
export type CredentialCeremonyReceipt = z.infer<typeof CredentialCeremonyReceiptSchema>;

export interface CredentialCeremonySnapshot {
  request: SupabaseCredentialCeremonyRequest;
  requestDigest: `sha256:${string}`;
  state: CredentialCeremonyState;
  captures: CapturedCredentialReference[];
  canaryEvidence: CredentialCanaryEvidence | null;
  cutoverEvidence: CredentialCutoverEvidence | null;
  revocationEvidence: CredentialRevocationEvidence | null;
  receipt: CredentialCeremonyReceipt | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialCeremonyStore {
  start(
    request: SupabaseCredentialCeremonyRequest,
    requestDigest: `sha256:${string}`,
    now: Date,
  ): Promise<{ snapshot: CredentialCeremonySnapshot; created: boolean }>;
  load(ceremonyId: string): Promise<CredentialCeremonySnapshot | null>;
  save(snapshot: CredentialCeremonySnapshot, expectedRevision: number): Promise<CredentialCeremonySnapshot>;
  settle(
    snapshot: CredentialCeremonySnapshot,
    receipt: CredentialCeremonyReceipt,
    expectedRevision: number,
  ): Promise<CredentialCeremonySnapshot>;
}

export interface CredentialSecretStore {
  storeCapturedMaterial(input: {
    workspaceId: string;
    ceremonyId: string;
    slotId: string;
    materialClass: 'application-publishable' | 'application-secret' | 'jwt-signing';
    material: Buffer;
    capturedAt: Date;
  }): Promise<Omit<CapturedCredentialReference, 'slotId' | 'keyState'>>;
  revokeMany(referenceIds: readonly string[], revokedAt: Date): Promise<readonly string[]>;
}

export interface RuntimeSecretBindingAdapter {
  bindReplacement(input: {
    ceremonyId: string;
    slot: CredentialReplacementSlot;
    replacement: CapturedCredentialReference;
    targetBindingGeneration: number;
  }): Promise<void>;
  activateReplacement(input: {
    ceremonyId: string;
    targetBindingGeneration: number;
    replacements: readonly CapturedCredentialReference[];
  }): Promise<void>;
  revokePrevious(input: {
    ceremonyId: string;
    previousBindings: readonly CredentialBindingInventoryEntry[];
    replacements: readonly CapturedCredentialReference[];
  }): Promise<readonly string[]>;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  throw new ValidationError('Credential ceremony digest input is not canonicalizable');
}

function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function credentialBindingInventoryDigest(
  inventory: readonly CredentialBindingInventoryEntry[],
): `sha256:${string}` {
  return sha256([...inventory].sort((left, right) => left.consumerId.localeCompare(right.consumerId)));
}

export function credentialCeremonyRequestDigest(
  request: SupabaseCredentialCeremonyRequest,
): `sha256:${string}` {
  const { authorityGrantId: _authorityGrantId, ...grantSubject } = request;
  return sha256(grantSubject);
}

function capabilityForCeremony(type: SupabaseCredentialCeremonyType): SupabaseCredentialCeremonyCapability {
  switch (type) {
    case 'api-key-rotation': return 'credential.supabase.api-key.rotate';
    case 'legacy-key-migration': return 'credential.supabase.legacy-key.migrate';
    case 'jwt-signing-rotation': return 'credential.supabase.jwt-signing.rotate';
  }
}

function receiptVersionForCeremony(type: SupabaseCredentialCeremonyType): CredentialCeremonyReceipt['version'] {
  switch (type) {
    case 'api-key-rotation': return 'rorca.supabase-api-key-rotation-receipt.v1';
    case 'legacy-key-migration': return 'rorca.supabase-legacy-key-migration-receipt.v1';
    case 'jwt-signing-rotation': return 'rorca.supabase-jwt-signing-rotation-receipt.v1';
  }
}

function unique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

function validateRequestInvariants(request: SupabaseCredentialCeremonyRequest, now: Date): void {
  if (request.capability !== capabilityForCeremony(request.ceremonyType)) {
    throw new ForbiddenError('Credential ceremony capability does not match ceremony type', {
      reason: 'ceremony_capability_mismatch',
    });
  }
  if (request.bindingInventoryDigest !== credentialBindingInventoryDigest(request.bindingInventory)) {
    throw new UnprocessableError('Credential binding inventory digest changed', 'CREDENTIAL_INVENTORY_DIGEST_MISMATCH');
  }
  if (request.recovery.rollbackBindingInventoryDigest !== request.bindingInventoryDigest) {
    throw new UnprocessableError('Recovery procedure is not bound to the exact credential inventory', 'RECOVERY_INVENTORY_MISMATCH');
  }
  if (request.cutover.targetBindingGeneration <= request.scope.bindingGeneration) {
    throw new UnprocessableError('Cutover binding generation must advance the current generation', 'BINDING_GENERATION_NOT_ADVANCED');
  }
  if (request.bindingInventory.some((entry) => entry.environment !== request.scope.environment
    || entry.generation !== request.scope.bindingGeneration)) {
    throw new UnprocessableError(
      'Every consumer binding must match the exact ceremony environment and generation',
      'CONSUMER_BINDING_SCOPE_MISMATCH',
    );
  }
  if (Date.parse(request.recovery.testedAt) > now.getTime()) {
    throw new UnprocessableError('Recovery readiness cannot be dated in the future', 'RECOVERY_READINESS_INVALID');
  }
  const consumers = request.bindingInventory.map((entry) => entry.consumerId);
  const slots = request.replacementSlots.map((slot) => slot.slotId);
  const assignedConsumers = request.replacementSlots.flatMap((slot) => slot.consumerIds);
  if (!unique(consumers) || !unique(slots) || !unique(assignedConsumers)
    || consumers.length !== assignedConsumers.length
    || consumers.some((consumerId) => !assignedConsumers.includes(consumerId))) {
    throw new UnprocessableError('Replacement slots must cover every inventoried consumer exactly once', 'CONSUMER_INVENTORY_INCOMPLETE');
  }
  const inventoryByConsumer = new Map(request.bindingInventory.map((entry) => [entry.consumerId, entry]));
  for (const slot of request.replacementSlots) {
    for (const consumerId of slot.consumerIds) {
      const oldClass = inventoryByConsumer.get(consumerId)?.materialClass;
      if (request.ceremonyType === 'jwt-signing-rotation') {
        if (oldClass !== 'jwt-signing' || slot.materialClass !== 'jwt-signing') {
          throw new UnprocessableError('JWT signing rotation can bind only JWT signing consumers', 'JWT_BINDING_CLASS_MISMATCH');
        }
      } else if (request.ceremonyType === 'legacy-key-migration') {
        const valid = (oldClass === 'application-anon' && slot.materialClass === 'application-publishable')
          || (oldClass === 'application-service-role' && slot.materialClass === 'application-secret');
        if (!valid) {
          throw new UnprocessableError('Legacy key classes require their exact publishable/secret replacements', 'LEGACY_REPLACEMENT_CLASS_MISMATCH');
        }
      } else if (oldClass !== slot.materialClass) {
        throw new UnprocessableError('API key rotation cannot change the key classification', 'API_KEY_CLASS_MISMATCH');
      }
    }
  }
  if (request.ceremonyType === 'legacy-key-migration') {
    const classes = new Set(request.bindingInventory.map((entry) => entry.materialClass));
    if (!classes.has('application-anon') || !classes.has('application-service-role')) {
      throw new UnprocessableError('Legacy migration must inventory anon and service_role consumers', 'LEGACY_INVENTORY_INCOMPLETE');
    }
  }
  if (request.ceremonyType === 'jwt-signing-rotation' && request.replacementSlots.length !== 1) {
    throw new UnprocessableError('JWT signing rotation requires one standby signing-key slot', 'JWT_STANDBY_SLOT_INVALID');
  }
}

function replacementForConsumer(
  snapshot: CredentialCeremonySnapshot,
  consumerId: string,
): CapturedCredentialReference | undefined {
  const slot = snapshot.request.replacementSlots.find((candidate) => candidate.consumerIds.includes(consumerId));
  return snapshot.captures.find((candidate) => candidate.slotId === slot?.slotId);
}

function validateCanaryEvidence(
  snapshot: CredentialCeremonySnapshot,
  raw: unknown,
  now: Date,
): CredentialCanaryEvidence {
  const evidence = CredentialCanaryEvidenceSchema.parse(raw);
  const request = snapshot.request;
  if (evidence.ceremonyType !== request.ceremonyType) {
    throw new ForbiddenError('Canary evidence ceremony type cannot be substituted', { reason: 'ceremony_type_mismatch' });
  }
  if (evidence.canaryId !== request.canary.canaryId
    || evidence.observedResultDigest !== request.canary.expectedResultDigest
    || evidence.verifierId !== request.canary.verifierId) {
    throw new UnprocessableError('Canary evidence does not match the exact authorized canary', 'CANARY_EVIDENCE_MISMATCH');
  }
  const verifiedAt = Date.parse(evidence.verifiedAt);
  const latestCaptureAt = Math.max(...snapshot.captures.map((capture) => Date.parse(capture.capturedAt)));
  if (verifiedAt < latestCaptureAt || verifiedAt > now.getTime()) {
    throw new UnprocessableError('Canary evidence chronology is invalid', 'CANARY_EVIDENCE_TIME_INVALID');
  }
  const results = new Map(evidence.consumerResults.map((result) => [result.consumerId, result]));
  if (results.size !== request.bindingInventory.length) {
    throw new UnprocessableError('Canary must prove every bound consumer replacement', 'CONSUMER_REPLACEMENT_UNPROVEN');
  }
  for (const consumer of request.bindingInventory) {
    const expectedReplacement = replacementForConsumer(snapshot, consumer.consumerId);
    const result = results.get(consumer.consumerId);
    if (!expectedReplacement || !result || result.replacementFingerprint !== expectedReplacement.fingerprint) {
      throw new UnprocessableError('Canary consumer proof does not match the captured replacement', 'CONSUMER_REPLACEMENT_UNPROVEN');
    }
  }
  return evidence;
}

function nextCaptureState(snapshot: CredentialCeremonySnapshot, captures: CapturedCredentialReference[]): CredentialCeremonyState {
  if (captures.length < snapshot.request.replacementSlots.length) return 'planned';
  return snapshot.request.ceremonyType === 'jwt-signing-rotation' ? 'standby' : 'replacement-bound';
}

export class SupabaseCredentialCeremonyAuthority {
  constructor(private readonly dependencies: {
    store: CredentialCeremonyStore;
    secretStore: CredentialSecretStore;
    runtimeBindings: RuntimeSecretBindingAdapter;
    now?: () => Date;
  }) {}

  get catalog() {
    return SUPABASE_CREDENTIAL_CEREMONY_CATALOG;
  }

  async start(rawRequest: unknown): Promise<CredentialCeremonySnapshot> {
    const request = SupabaseCredentialCeremonyRequestSchema.parse(rawRequest);
    const now = this.now();
    validateRequestInvariants(request, now);
    const requestDigest = credentialCeremonyRequestDigest(request);
    return (await this.dependencies.store.start(request, requestDigest, now)).snapshot;
  }

  async get(ceremonyId: string): Promise<CredentialCeremonySnapshot> {
    const id = UuidSchema.parse(ceremonyId);
    const snapshot = await this.dependencies.store.load(id);
    if (!snapshot) throw new NotFoundError('Credential ceremony', id);
    return snapshot;
  }

  async capture(ceremonyId: string, slotId: string, material: Buffer): Promise<CredentialCeremonySnapshot> {
    if (!Buffer.isBuffer(material) || material.length === 0 || material.length > 65_536) {
      throw new ValidationError('Secure credential capture must contain 1 to 65536 raw bytes');
    }
    const snapshot = await this.get(ceremonyId);
    if (!['planned', 'replacement-bound', 'standby'].includes(snapshot.state) || snapshot.canaryEvidence) {
      throw new ConflictError('Credential capture is closed after canary verification');
    }
    const slot = snapshot.request.replacementSlots.find((candidate) => candidate.slotId === slotId);
    if (!slot) throw new NotFoundError('Credential capture slot', slotId);
    if (snapshot.captures.some((capture) => capture.slotId === slotId)) {
      throw new ConflictError('Credential capture slot is already bound');
    }
    const capturedAt = this.now();
    const stored = await this.dependencies.secretStore.storeCapturedMaterial({
      workspaceId: snapshot.request.scope.workspaceId,
      ceremonyId: snapshot.request.ceremonyId,
      slotId,
      materialClass: slot.materialClass,
      material,
      capturedAt,
    });
    try {
      const replacement = CapturedCredentialReferenceSchema.parse({
        ...stored,
        slotId,
        keyState: 'standby',
      });
      const replacedFingerprints = snapshot.request.bindingInventory
        .filter((binding) => slot.consumerIds.includes(binding.consumerId))
        .map((binding) => binding.fingerprint);
      if (replacement.materialClass !== slot.materialClass
        || replacedFingerprints.includes(replacement.fingerprint)
        || snapshot.captures.some((capture) => capture.fingerprint === replacement.fingerprint)) {
        throw new UnprocessableError(
          'Captured replacement must have the exact slot classification and new fingerprint',
          'CREDENTIAL_REPLACEMENT_INVALID',
        );
      }
      await this.dependencies.runtimeBindings.bindReplacement({
        ceremonyId: snapshot.request.ceremonyId,
        slot,
        replacement,
        targetBindingGeneration: snapshot.request.cutover.targetBindingGeneration,
      });
      const captures = [...snapshot.captures, replacement]
        .sort((left, right) => left.slotId.localeCompare(right.slotId));
      return await this.dependencies.store.save({
        ...snapshot,
        captures,
        state: nextCaptureState(snapshot, captures),
        updatedAt: capturedAt.toISOString(),
      }, snapshot.revision);
    } catch (error) {
      await this.dependencies.secretStore.revokeMany([stored.referenceId], this.now()).catch(() => undefined);
      throw error;
    }
  }

  async verifyCanary(ceremonyId: string, rawEvidence: unknown): Promise<CredentialCeremonySnapshot> {
    const snapshot = await this.get(ceremonyId);
    const requiredState = snapshot.request.ceremonyType === 'jwt-signing-rotation' ? 'standby' : 'replacement-bound';
    if (snapshot.state !== requiredState || snapshot.captures.length !== snapshot.request.replacementSlots.length) {
      throw new ConflictError('Every replacement must be bound before canary verification');
    }
    const now = this.now();
    const evidence = validateCanaryEvidence(snapshot, rawEvidence, now);
    return this.dependencies.store.save({
      ...snapshot,
      canaryEvidence: evidence,
      state: 'canary-verified',
      updatedAt: now.toISOString(),
    }, snapshot.revision);
  }

  async cutover(ceremonyId: string, rawEvidence: unknown): Promise<CredentialCeremonySnapshot> {
    const snapshot = await this.get(ceremonyId);
    if (snapshot.state !== 'canary-verified' || !snapshot.canaryEvidence) {
      throw new ConflictError('Exact replacement canary must pass before cutover');
    }
    const evidence = CredentialCutoverEvidenceSchema.parse(rawEvidence);
    if (evidence.cutoverId !== snapshot.request.cutover.cutoverId
      || evidence.targetBindingGeneration !== snapshot.request.cutover.targetBindingGeneration) {
      throw new UnprocessableError('Cutover evidence does not match the authorized cutover', 'CUTOVER_EVIDENCE_MISMATCH');
    }
    const completedAt = Date.parse(evidence.completedAt);
    const now = this.now();
    if (completedAt < Date.parse(snapshot.canaryEvidence.verifiedAt) || completedAt > now.getTime()) {
      throw new UnprocessableError('Cutover evidence chronology is invalid', 'CUTOVER_EVIDENCE_TIME_INVALID');
    }
    await this.dependencies.runtimeBindings.activateReplacement({
      ceremonyId: snapshot.request.ceremonyId,
      targetBindingGeneration: snapshot.request.cutover.targetBindingGeneration,
      replacements: snapshot.captures,
    });
    const captures = snapshot.captures.map((capture) => ({ ...capture, keyState: 'current' as const }));
    return this.dependencies.store.save({
      ...snapshot,
      captures,
      cutoverEvidence: evidence,
      state: 'current',
      updatedAt: now.toISOString(),
    }, snapshot.revision);
  }

  async revokePrevious(ceremonyId: string, rawEvidence: unknown): Promise<CredentialCeremonySnapshot> {
    const snapshot = await this.get(ceremonyId);
    if (snapshot.state !== 'current' || !snapshot.canaryEvidence || !snapshot.cutoverEvidence) {
      throw new ConflictError('Cutover and exact replacement canary must pass before revocation');
    }
    const evidence = CredentialRevocationEvidenceSchema.parse(rawEvidence);
    if (evidence.ceremonyType !== snapshot.request.ceremonyType) {
      throw new ForbiddenError('Revocation evidence ceremony type cannot be substituted', { reason: 'ceremony_type_mismatch' });
    }
    if (evidence.canaryId !== snapshot.request.canary.canaryId
      || evidence.observedResultDigest !== snapshot.request.canary.expectedResultDigest
      || evidence.recoveryProcedureId !== snapshot.request.recovery.procedureId
      || evidence.rollbackBindingInventoryDigest !== snapshot.request.recovery.rollbackBindingInventoryDigest) {
      throw new UnprocessableError('Revocation is not bound to the exact canary and rollback procedure', 'REVOCATION_READINESS_MISMATCH');
    }
    const now = this.now();
    const verifiedAt = Date.parse(evidence.verifiedAt);
    if (verifiedAt < Date.parse(snapshot.cutoverEvidence.completedAt) || verifiedAt > now.getTime()) {
      throw new UnprocessableError('Revocation evidence chronology is invalid', 'REVOCATION_EVIDENCE_TIME_INVALID');
    }
    const cutoverAt = Date.parse(snapshot.cutoverEvidence.completedAt);
    const graceEndsAt = cutoverAt + snapshot.request.revocation.gracePeriodSeconds * 1_000;
    const revokeNotBefore = Date.parse(snapshot.request.revocation.revokeNotBefore);
    if (now.getTime() < Math.max(graceEndsAt, revokeNotBefore)) {
      throw new ConflictError('Credential revocation grace period has not elapsed');
    }
    const revokedByRuntime = await this.dependencies.runtimeBindings.revokePrevious({
      ceremonyId: snapshot.request.ceremonyId,
      previousBindings: snapshot.request.bindingInventory,
      replacements: snapshot.captures,
    });
    const expectedReferences = [...new Set(snapshot.request.bindingInventory.map((binding) => binding.referenceId))].sort();
    const runtimeReferences = [...new Set(revokedByRuntime)].sort();
    if (canonicalJson(runtimeReferences) !== canonicalJson(expectedReferences)) {
      throw new UnprocessableError('Runtime binding adapter did not revoke the exact previous inventory', 'REVOCATION_INVENTORY_MISMATCH');
    }
    const revokedReferences = [...await this.dependencies.secretStore.revokeMany(expectedReferences, now)].sort();
    if (canonicalJson(revokedReferences) !== canonicalJson(expectedReferences)) {
      throw new UnprocessableError('SecretStore did not revoke the exact previous inventory', 'SECRET_REVOCATION_INCOMPLETE');
    }
    const receipt = CredentialCeremonyReceiptSchema.parse({
      version: receiptVersionForCeremony(snapshot.request.ceremonyType),
      receiptId: crypto.randomUUID(),
      ceremonyId: snapshot.request.ceremonyId,
      ceremonyType: snapshot.request.ceremonyType,
      capability: snapshot.request.capability,
      authorityGrantId: snapshot.request.authorityGrantId,
      requestDigest: snapshot.requestDigest,
      scope: snapshot.request.scope,
      bindingInventoryDigest: snapshot.request.bindingInventoryDigest,
      replacements: snapshot.captures,
      canaryEvidenceDigest: sha256(snapshot.canaryEvidence),
      cutoverEvidenceDigest: snapshot.cutoverEvidence.evidenceDigest,
      revocationEvidenceDigest: evidence.evidenceDigest,
      recoveryProcedureId: snapshot.request.recovery.procedureId,
      revokedReferenceIds: revokedReferences,
      finalKeyStates: [
        ...snapshot.request.bindingInventory.map((binding) => ({ fingerprint: binding.fingerprint, state: 'revoked' as const })),
        ...snapshot.captures.map((capture) => ({ fingerprint: capture.fingerprint, state: 'current' as const })),
      ],
      settledAt: now.toISOString(),
    });
    return this.dependencies.store.settle({
      ...snapshot,
      revocationEvidence: evidence,
      state: 'revoked',
      updatedAt: now.toISOString(),
    }, receipt, snapshot.revision);
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }
}

export const SUPABASE_CREDENTIAL_CEREMONY_CATALOG = Object.freeze([
  Object.freeze({
    ceremonyType: 'api-key-rotation' as const,
    capability: 'credential.supabase.api-key.rotate' as const,
    receiptVersion: 'rorca.supabase-api-key-rotation-receipt.v1' as const,
    materialClasses: Object.freeze(['application-publishable', 'application-secret'] as const),
    publicMaterialClasses: Object.freeze(['application-publishable'] as const),
    secureCaptureRequiredFor: Object.freeze(['application-secret'] as const),
  }),
  Object.freeze({
    ceremonyType: 'legacy-key-migration' as const,
    capability: 'credential.supabase.legacy-key.migrate' as const,
    receiptVersion: 'rorca.supabase-legacy-key-migration-receipt.v1' as const,
    materialClasses: Object.freeze(['application-anon', 'application-service-role'] as const),
    replacementClasses: Object.freeze(['application-publishable', 'application-secret'] as const),
    secureCaptureRequiredFor: Object.freeze(['application-secret'] as const),
  }),
  Object.freeze({
    ceremonyType: 'jwt-signing-rotation' as const,
    capability: 'credential.supabase.jwt-signing.rotate' as const,
    receiptVersion: 'rorca.supabase-jwt-signing-rotation-receipt.v1' as const,
    materialClasses: Object.freeze(['jwt-signing'] as const),
    keyStates: Object.freeze(['standby', 'current', 'revoked'] as const),
    secureCaptureRequiredFor: Object.freeze(['jwt-signing'] as const),
  }),
]);

interface CeremonyRow {
  request_record: unknown;
  request_digest: `sha256:${string}`;
  state: CredentialCeremonyState;
  captures: unknown;
  canary_evidence: unknown | null;
  cutover_evidence: unknown | null;
  revocation_evidence: unknown | null;
  receipt_record: unknown | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

function parseSnapshot(row: CeremonyRow): CredentialCeremonySnapshot {
  const request = SupabaseCredentialCeremonyRequestSchema.parse(row.request_record);
  return {
    request,
    requestDigest: Sha256Schema.parse(row.request_digest) as `sha256:${string}`,
    state: CredentialCeremonyStateSchema.parse(row.state),
    captures: z.array(CapturedCredentialReferenceSchema).parse(row.captures),
    canaryEvidence: row.canary_evidence === null ? null : CredentialCanaryEvidenceSchema.parse(row.canary_evidence),
    cutoverEvidence: row.cutover_evidence === null ? null : CredentialCutoverEvidenceSchema.parse(row.cutover_evidence),
    revocationEvidence: row.revocation_evidence === null ? null : CredentialRevocationEvidenceSchema.parse(row.revocation_evidence),
    receipt: row.receipt_record === null ? null : CredentialCeremonyReceiptSchema.parse(row.receipt_record),
    revision: row.revision,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const CEREMONY_SELECT = `SELECT request_record, request_digest, state, captures,
  canary_evidence, cutover_evidence, revocation_evidence, receipt_record,
  revision, created_at, updated_at
 FROM rorca.credential_ceremonies WHERE id = $1`;

export class PostgresCredentialCeremonyStore implements CredentialCeremonyStore {
  async start(
    request: SupabaseCredentialCeremonyRequest,
    requestDigest: `sha256:${string}`,
    now: Date,
  ): Promise<{ snapshot: CredentialCeremonySnapshot; created: boolean }> {
    return canonicalTransaction(async (client) => {
      const replay = await client.query<CeremonyRow>(CEREMONY_SELECT, [request.ceremonyId]);
      if (replay.rows[0]) {
        const snapshot = parseSnapshot(replay.rows[0]);
        if (snapshot.requestDigest !== requestDigest || snapshot.request.authorityGrantId !== request.authorityGrantId) {
          throw new ConflictError('Credential ceremony id replay changed the authorized request');
        }
        return { snapshot, created: false };
      }
      const grant = await client.query<{
        ceremony_type: string;
        capability: string;
        subject_hash: string;
        workspace_id: string;
        credential_binding_id: string;
        binding_generation: string | number;
        expires_at: string;
        consumed_by_ceremony_id: string | null;
        revoked_at: string | null;
      }>(`SELECT ceremony_type, capability, subject_hash, workspace_id, credential_binding_id,
            binding_generation, expires_at, consumed_by_ceremony_id, revoked_at
           FROM rorca.credential_ceremony_grants WHERE id = $1 FOR UPDATE`, [request.authorityGrantId]);
      const authority = grant.rows[0];
      if (!authority
        || authority.ceremony_type !== request.ceremonyType
        || authority.capability !== request.capability
        || authority.subject_hash !== requestDigest
        || authority.workspace_id !== request.scope.workspaceId
        || authority.credential_binding_id !== request.scope.credentialBindingId
        || Number(authority.binding_generation) !== request.scope.bindingGeneration
        || authority.revoked_at !== null
        || authority.consumed_by_ceremony_id !== null
        || new Date(authority.expires_at).getTime() <= now.getTime()) {
        throw new ForbiddenError('Exact unexpired typed credential ceremony grant is required', {
          reason: 'credential_ceremony_grant_unauthorized',
        });
      }
      const inserted = await client.query<CeremonyRow>(`INSERT INTO rorca.credential_ceremonies (
          id, workspace_id, credential_binding_id, binding_generation, authority_grant_id,
          idempotency_key, ceremony_type, capability, request_digest, binding_inventory_digest,
          request_record, state, captures, revision, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'planned','[]'::jsonb,0,$12,$12)
        RETURNING request_record, request_digest, state, captures, canary_evidence,
          cutover_evidence, revocation_evidence, receipt_record, revision, created_at, updated_at`, [
        request.ceremonyId,
        request.scope.workspaceId,
        request.scope.credentialBindingId,
        request.scope.bindingGeneration,
        request.authorityGrantId,
        request.idempotencyKey,
        request.ceremonyType,
        request.capability,
        requestDigest,
        request.bindingInventoryDigest,
        JSON.stringify(request),
        now.toISOString(),
      ]);
      for (const binding of request.bindingInventory) {
        const slot = request.replacementSlots.find((candidate) => candidate.consumerIds.includes(binding.consumerId));
        if (!slot) throw new UnprocessableError('Consumer replacement slot disappeared', 'CONSUMER_INVENTORY_INCOMPLETE');
        await client.query(`INSERT INTO rorca.credential_consumer_bindings (
            ceremony_id, consumer_id, binding_id, component, environment, old_material_class,
            old_reference_id, old_fingerprint, old_generation, replacement_slot_id,
            replacement_material_class, target_generation, state
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'current')`, [
          request.ceremonyId, binding.consumerId, binding.bindingId, binding.component,
          binding.environment, binding.materialClass, binding.referenceId, binding.fingerprint,
          binding.generation, slot.slotId, slot.materialClass, request.cutover.targetBindingGeneration,
        ]);
      }
      const consumed = await client.query(`UPDATE rorca.credential_ceremony_grants
         SET consumed_by_ceremony_id = $1, consumed_at = $2
         WHERE id = $3 AND consumed_by_ceremony_id IS NULL AND revoked_at IS NULL`, [
        request.ceremonyId, now.toISOString(), request.authorityGrantId,
      ]);
      if (consumed.rowCount !== 1) {
        throw new ForbiddenError('Credential ceremony grant could not be consumed exactly once', {
          reason: 'credential_ceremony_grant_consumption_failed',
        });
      }
      return { snapshot: parseSnapshot(inserted.rows[0]!), created: true };
    });
  }

  async load(ceremonyId: string): Promise<CredentialCeremonySnapshot | null> {
    return canonicalTransaction(async (client) => {
      const result = await client.query<CeremonyRow>(CEREMONY_SELECT, [ceremonyId]);
      return result.rows[0] ? parseSnapshot(result.rows[0]) : null;
    });
  }

  async save(snapshot: CredentialCeremonySnapshot, expectedRevision: number): Promise<CredentialCeremonySnapshot> {
    return canonicalTransaction(async (client) => {
      const result = await client.query<CeremonyRow>(`UPDATE rorca.credential_ceremonies SET
          state = $2, captures = $3, canary_evidence = $4, cutover_evidence = $5,
          revocation_evidence = $6, revision = revision + 1, updated_at = $7
        WHERE id = $1 AND revision = $8 AND receipt_record IS NULL
        RETURNING request_record, request_digest, state, captures, canary_evidence,
          cutover_evidence, revocation_evidence, receipt_record, revision, created_at, updated_at`, [
        snapshot.request.ceremonyId,
        snapshot.state,
        JSON.stringify(snapshot.captures),
        snapshot.canaryEvidence ? JSON.stringify(snapshot.canaryEvidence) : null,
        snapshot.cutoverEvidence ? JSON.stringify(snapshot.cutoverEvidence) : null,
        snapshot.revocationEvidence ? JSON.stringify(snapshot.revocationEvidence) : null,
        snapshot.updatedAt,
        expectedRevision,
      ]);
      if (!result.rows[0]) throw new ConflictError('Credential ceremony changed concurrently');
      return parseSnapshot(result.rows[0]);
    });
  }

  async settle(
    snapshot: CredentialCeremonySnapshot,
    receipt: CredentialCeremonyReceipt,
    expectedRevision: number,
  ): Promise<CredentialCeremonySnapshot> {
    return canonicalTransaction(async (client) => {
      await client.query(`INSERT INTO rorca.credential_ceremony_receipts (
          id, ceremony_id, workspace_id, ceremony_type, capability, request_digest,
          binding_inventory_digest, receipt_record, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
        receipt.receiptId, receipt.ceremonyId, receipt.scope.workspaceId, receipt.ceremonyType,
        receipt.capability, receipt.requestDigest, receipt.bindingInventoryDigest,
        JSON.stringify(receipt), receipt.settledAt,
      ]);
      const result = await client.query<CeremonyRow>(`UPDATE rorca.credential_ceremonies SET
          state = 'revoked', revocation_evidence = $2, receipt_id = $3, receipt_record = $4,
          revision = revision + 1, updated_at = $5
        WHERE id = $1 AND revision = $6 AND state = 'current' AND receipt_record IS NULL
        RETURNING request_record, request_digest, state, captures, canary_evidence,
          cutover_evidence, revocation_evidence, receipt_record, revision, created_at, updated_at`, [
        snapshot.request.ceremonyId,
        JSON.stringify(snapshot.revocationEvidence),
        receipt.receiptId,
        JSON.stringify(receipt),
        snapshot.updatedAt,
        expectedRevision,
      ]);
      if (!result.rows[0]) throw new ConflictError('Credential ceremony changed concurrently during settlement');
      return parseSnapshot(result.rows[0]);
    });
  }
}

function encryptionKey(): Buffer {
  const configured = process.env.VAULT_KEY;
  if (configured) {
    if (!/^[0-9a-fA-F]{64}$/.test(configured)) {
      throw new ValidationError('VAULT_KEY must be a 64-character hex string');
    }
    return Buffer.from(configured, 'hex');
  }
  const fallback = process.env.JWT_SECRET;
  if (!fallback) throw new ValidationError('VAULT_KEY is required for secure credential capture');
  return crypto.createHash('sha256').update(fallback).digest();
}

function encryptMaterial(material: Buffer): Buffer {
  const key = encryptionKey();
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(material), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  } finally {
    key.fill(0);
  }
}

const MANAGED_REFERENCE_PREFIX = 'secret-store://rorca/credential-authority/';

export class PostgresCredentialSecretStore implements CredentialSecretStore {
  async storeCapturedMaterial(input: {
    workspaceId: string;
    ceremonyId: string;
    slotId: string;
    materialClass: 'application-publishable' | 'application-secret' | 'jwt-signing';
    material: Buffer;
    capturedAt: Date;
  }): Promise<Omit<CapturedCredentialReference, 'slotId' | 'keyState'>> {
    const id = crypto.randomUUID();
    const fingerprint = `sha256:${crypto.createHash('sha256').update(input.material).digest('hex')}` as const;
    const encrypted = encryptMaterial(input.material);
    try {
      return await canonicalTransaction(async (client) => {
        await client.query(`INSERT INTO rorca.authority_secret_store_entries (
            id, workspace_id, ceremony_id, slot_id, material_class,
            encrypted_value, fingerprint, captured_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
          id, input.workspaceId, input.ceremonyId, input.slotId, input.materialClass,
          encrypted, fingerprint, input.capturedAt.toISOString(),
        ]);
        return {
          materialClass: input.materialClass,
          referenceId: `${MANAGED_REFERENCE_PREFIX}${id}`,
          fingerprint,
          capturedAt: input.capturedAt.toISOString(),
        };
      });
    } finally {
      encrypted.fill(0);
    }
  }

  async revokeMany(referenceIds: readonly string[], revokedAt: Date): Promise<readonly string[]> {
    const uniqueReferences = [...new Set(referenceIds)].sort();
    const ids = uniqueReferences.map((referenceId) => {
      if (!referenceId.startsWith(MANAGED_REFERENCE_PREFIX)) {
        throw new UnprocessableError('Previous credential is not managed by the credential SecretStore', 'SECRET_REFERENCE_UNMANAGED');
      }
      return UuidSchema.parse(referenceId.slice(MANAGED_REFERENCE_PREFIX.length));
    });
    return canonicalTransaction(async (client) => {
      const result = await client.query<{ id: string }>(`UPDATE rorca.authority_secret_store_entries
         SET revoked_at = $2
         WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL
         RETURNING id`, [ids, revokedAt.toISOString()]);
      const revokedIds = result.rows.map((row) => row.id).sort();
      if (revokedIds.length !== ids.length) {
        throw new ConflictError('SecretStore could not revoke every exact previous credential');
      }
      return revokedIds.map((id) => `${MANAGED_REFERENCE_PREFIX}${id}`).sort();
    });
  }
}

export class PostgresRuntimeSecretBindingAdapter implements RuntimeSecretBindingAdapter {
  async bindReplacement(input: {
    ceremonyId: string;
    slot: CredentialReplacementSlot;
    replacement: CapturedCredentialReference;
    targetBindingGeneration: number;
  }): Promise<void> {
    await canonicalTransaction(async (client) => {
      const result = await client.query(`UPDATE rorca.credential_consumer_bindings SET
          replacement_reference_id = $3, replacement_fingerprint = $4,
          replacement_captured_at = $5, state = 'standby'
        WHERE ceremony_id = $1 AND replacement_slot_id = $2 AND target_generation = $6
          AND replacement_reference_id IS NULL AND state = 'current'`, [
        input.ceremonyId, input.slot.slotId, input.replacement.referenceId,
        input.replacement.fingerprint, input.replacement.capturedAt, input.targetBindingGeneration,
      ]);
      if (result.rowCount !== input.slot.consumerIds.length) {
        throw new ConflictError('Runtime replacement binding did not cover the exact consumer slot');
      }
    });
  }

  async activateReplacement(input: {
    ceremonyId: string;
    targetBindingGeneration: number;
    replacements: readonly CapturedCredentialReference[];
  }): Promise<void> {
    await canonicalTransaction(async (client) => {
      const expected = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text count FROM rorca.credential_consumer_bindings WHERE ceremony_id = $1',
        [input.ceremonyId],
      );
      const result = await client.query(`UPDATE rorca.credential_consumer_bindings SET state = 'current-replacement', activated_at = NOW()
        WHERE ceremony_id = $1 AND target_generation = $2 AND state = 'standby'
          AND replacement_reference_id IS NOT NULL`, [input.ceremonyId, input.targetBindingGeneration]);
      if (result.rowCount !== Number(expected.rows[0]?.count ?? -1)) {
        throw new ConflictError('Runtime cutover did not activate every replacement consumer');
      }
    });
  }

  async revokePrevious(input: {
    ceremonyId: string;
    previousBindings: readonly CredentialBindingInventoryEntry[];
    replacements: readonly CapturedCredentialReference[];
  }): Promise<readonly string[]> {
    return canonicalTransaction(async (client) => {
      const result = await client.query<{ old_reference_id: string }>(`UPDATE rorca.credential_consumer_bindings
         SET state = 'revoked-old', old_revoked_at = NOW()
         WHERE ceremony_id = $1 AND state = 'current-replacement'
         RETURNING old_reference_id`, [input.ceremonyId]);
      if (result.rowCount !== input.previousBindings.length) {
        throw new ConflictError('Runtime revocation did not cover every previous consumer binding');
      }
      return [...new Set(result.rows.map((row) => row.old_reference_id))].sort();
    });
  }
}
