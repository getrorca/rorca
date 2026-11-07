/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  createCipheriv,
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as verifySignature,
} from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { canonicalTransaction } from '../db/index';
import { ConflictError, ForbiddenError, UnprocessableError, ValidationError } from './errors';
import {
  StripeModeSchema,
  StripePermissionManifestSchema,
} from './stripe-authority-provider-adapter';
import {
  StripeRotationIntentSchema,
  type StripeRotationIntent,
} from './stripe-credential-rotation';
import { stableWalJson } from './trusted-wal';

export const STRIPE_DASHBOARD_EVIDENCE_VERSION = 'rorca.stripe-dashboard-evidence.v1' as const;
export const STRIPE_CAPTURE_PROVENANCE_VERSION = 'rorca.stripe-capture-provenance.v1' as const;

const FingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const SafeReferenceSchema = z.string().trim().min(1).max(2048).refine(
  (value) => !/(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/.test(value),
  { message: 'Credential-shaped values are forbidden in secure-capture metadata' },
);

export const StripeDashboardEvidenceUnsignedSchema = z.object({
  schemaVersion: z.literal(STRIPE_DASHBOARD_EVIDENCE_VERSION),
  evidenceId: z.string().uuid(),
  intentDigest: FingerprintSchema,
  workspaceId: z.string().trim().min(1).max(255),
  accountId: z.string().trim().min(1).max(255),
  mode: StripeModeSchema,
  targetBindingReference: SafeReferenceSchema,
  permissionManifest: StripePermissionManifestSchema.min(1),
  keyKind: z.literal('restricted'),
  replacementFingerprint: FingerprintSchema,
  dashboardSessionReference: SafeReferenceSchema,
  dashboardReauthenticatedAt: z.string().datetime({ offset: true }),
  restrictedKeyCreatedAt: z.string().datetime({ offset: true }),
  operatorId: z.string().trim().min(1).max(255),
  attestationKeyId: z.string().trim().min(1).max(255),
}).strict();
export type StripeDashboardEvidenceUnsigned = z.infer<typeof StripeDashboardEvidenceUnsignedSchema>;

export const StripeDashboardEvidenceSchema = StripeDashboardEvidenceUnsignedSchema.safeExtend({
  signature: z.string().trim().min(40).max(1024),
}).strict();
export type StripeDashboardEvidence = z.infer<typeof StripeDashboardEvidenceSchema>;

export const StripeCaptureProvenanceSchema = z.object({
  schemaVersion: z.literal(STRIPE_CAPTURE_PROVENANCE_VERSION),
  captureReceiptReference: z.string().regex(/^credential-capture:\/\/rorca\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  provider: z.literal('stripe'),
  channel: z.literal('trusted_local_operator'),
  providerEvidenceId: z.string().uuid(),
  operatorId: z.string().trim().min(1).max(255),
  capturedAt: z.string().datetime({ offset: true }),
  targetBindingReference: SafeReferenceSchema,
}).strict();
export type StripeCaptureProvenance = z.infer<typeof StripeCaptureProvenanceSchema>;

/** The only projection returned by secure operator capture. */
export const StripeSecureCaptureResultSchema = z.object({
  reference: z.string().regex(/^secret-store:\/\/rorca\/provider-credentials\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  fingerprint: FingerprintSchema,
  provenance: StripeCaptureProvenanceSchema,
}).strict();
export type StripeSecureCaptureResult = z.infer<typeof StripeSecureCaptureResultSchema>;

export const StoredStripeCaptureSchema = z.object({
  intentId: z.string().uuid(),
  intentDigest: FingerprintSchema,
  workspaceId: z.string().trim().min(1).max(255),
  accountId: z.string().trim().min(1).max(255),
  mode: StripeModeSchema,
  permissionManifest: StripePermissionManifestSchema.min(1),
  targetBindingReference: SafeReferenceSchema,
  providerEvidenceDigest: FingerprintSchema,
  result: StripeSecureCaptureResultSchema,
}).strict();
export type StoredStripeCapture = z.infer<typeof StoredStripeCaptureSchema>;

export interface StripeDashboardEvidenceKeyBinding {
  keyId: string;
  publicKeyPem: string;
  workspaceId: string;
  accountId: string;
  operatorIds: readonly string[];
  modes: readonly ('test' | 'live')[];
}

export function readConfiguredStripeDashboardEvidenceKeys(): readonly StripeDashboardEvidenceKeyBinding[] {
  const raw = String(process.env.RORCA_STRIPE_DASHBOARD_EVIDENCE_KEYS_JSON ?? '').trim();
  if (!raw) return [];
  const parsed = z.array(z.object({
    keyId: z.string().trim().min(1).max(255),
    publicKeyPem: z.string().min(1).max(16_384),
    workspaceId: z.string().trim().min(1).max(255),
    accountId: z.string().trim().min(1).max(255),
    operatorIds: z.array(z.string().trim().min(1).max(255)).min(1).max(100),
    modes: z.array(StripeModeSchema).min(1).max(2),
  }).strict()).max(100).parse(JSON.parse(raw) as unknown);
  return parsed;
}

function withoutSignature(evidence: StripeDashboardEvidence): StripeDashboardEvidenceUnsigned {
  const { signature: _signature, ...unsigned } = evidence;
  return StripeDashboardEvidenceUnsignedSchema.parse(unsigned);
}

function sameManifest(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((permission, index) => permission === normalizedRight[index]);
}

/**
 * Verifies evidence emitted by the isolated operator ceremony. Possession of an
 * intent digest or API session is insufficient: the evidence must be signed by
 * an off-process key bound to the exact workspace, Stripe account, operator,
 * and mode.
 */
export class StripeDashboardEvidenceVerifier {
  constructor(
    private readonly readKeyBindings: () => readonly StripeDashboardEvidenceKeyBinding[] = readConfiguredStripeDashboardEvidenceKeys,
  ) {}

  verify(
    evidenceInput: StripeDashboardEvidence,
    intentInput: StripeRotationIntent,
    now = new Date(),
  ): StripeDashboardEvidence {
    const evidence = StripeDashboardEvidenceSchema.parse(evidenceInput);
    const intent = StripeRotationIntentSchema.parse(intentInput);
    const keyBinding = this.readKeyBindings().find((candidate) =>
      candidate.keyId === evidence.attestationKeyId
      && candidate.workspaceId === evidence.workspaceId
      && candidate.accountId === evidence.accountId
      && candidate.operatorIds.includes(evidence.operatorId)
      && candidate.modes.includes(evidence.mode));
    if (!keyBinding) {
      throw new ForbiddenError('Stripe Dashboard evidence key is not authorized for this operator target');
    }

    let publicKey;
    try {
      publicKey = createPublicKey(keyBinding.publicKeyPem);
    } catch {
      throw new ForbiddenError('Stripe Dashboard evidence key is invalid');
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      throw new ForbiddenError('Stripe Dashboard evidence must use an Ed25519 attestation key');
    }
    let signature: Buffer;
    try {
      signature = Buffer.from(evidence.signature, 'base64url');
    } catch {
      throw new ForbiddenError('Stripe Dashboard evidence signature is malformed');
    }
    const signedBytes = Buffer.from(stableWalJson(withoutSignature(evidence)), 'utf8');
    if (!verifySignature(null, signedBytes, publicKey, signature)) {
      throw new ForbiddenError('Stripe Dashboard evidence signature verification failed');
    }

    if (evidence.intentDigest !== intent.intentDigest
        || evidence.workspaceId !== intent.workspaceId
        || evidence.accountId !== intent.accountId
        || evidence.mode !== intent.mode
        || evidence.targetBindingReference !== intent.targetBindingReference) {
      throw new ForbiddenError('Stripe Dashboard evidence does not match the exact rotation intent');
    }
    if (!sameManifest(evidence.permissionManifest, intent.permissionManifest)) {
      throw new ForbiddenError('Stripe Dashboard evidence permission manifest exceeds or differs from approval');
    }

    const reauthenticatedAt = Date.parse(evidence.dashboardReauthenticatedAt);
    const keyCreatedAt = Date.parse(evidence.restrictedKeyCreatedAt);
    const intentCreatedAt = Date.parse(intent.createdAt);
    if (keyCreatedAt < reauthenticatedAt
        || reauthenticatedAt < intentCreatedAt
        || keyCreatedAt < intentCreatedAt
        || reauthenticatedAt < now.getTime() - 30 * 60_000
        || keyCreatedAt > now.getTime() + 60_000) {
      throw new ForbiddenError('Stripe Dashboard reauthentication and restricted-key creation evidence is not temporally valid');
    }
    return evidence;
  }
}

export interface StripeCredentialSecretStore {
  captureReplacement(input: {
    intent: StripeRotationIntent;
    evidence: StripeDashboardEvidence;
    evidenceDigest: `sha256:${string}`;
    replacement: Uint8Array;
    fingerprint: `sha256:${string}`;
    capturedAt: Date;
  }): Promise<StoredStripeCapture>;
  getCapture(captureReceiptReference: string): Promise<StoredStripeCapture | null>;
}

export function readStripeCredentialStoreEncryptionKey(): Buffer {
  const raw = String(process.env.RORCA_CREDENTIAL_STORE_KEY ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new ValidationError('RORCA_CREDENTIAL_STORE_KEY must be a 64-character hex encryption key');
  }
  return Buffer.from(raw, 'hex');
}

interface StoredStripeCaptureRow {
  id: string;
  rotation_intent_id: string;
  intent_digest: string;
  workspace_id: string;
  provider_account_id: string;
  mode: 'test' | 'live';
  permission_manifest: unknown;
  target_binding_reference: string;
  fingerprint: string;
  provider_evidence_digest: string;
  provenance: unknown;
}

function projectStoredCapture(row: StoredStripeCaptureRow): StoredStripeCapture {
  const provenance = StripeCaptureProvenanceSchema.parse(row.provenance);
  return StoredStripeCaptureSchema.parse({
    intentId: row.rotation_intent_id,
    intentDigest: row.intent_digest,
    workspaceId: row.workspace_id,
    accountId: row.provider_account_id,
    mode: row.mode,
    permissionManifest: row.permission_manifest,
    targetBindingReference: row.target_binding_reference,
    providerEvidenceDigest: row.provider_evidence_digest,
    result: {
      reference: `secret-store://rorca/provider-credentials/${row.id}`,
      fingerprint: row.fingerprint,
      provenance,
    },
  });
}

async function selectCapture(client: PoolClient, captureReceiptReference: string): Promise<StoredStripeCapture | null> {
  const match = /^credential-capture:\/\/rorca\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(captureReceiptReference);
  if (!match) return null;
  const receiptId = match[1];
  const result = await client.query<StoredStripeCaptureRow>(
    `SELECT id, rotation_intent_id, intent_digest, workspace_id,
            provider_account_id, mode, permission_manifest,
            target_binding_reference, fingerprint, provider_evidence_digest,
            provenance
       FROM provider_credential_secret_objects
      WHERE id = $1 AND provider = 'stripe' AND status = 'captured'`,
    [receiptId],
  );
  return result.rows[0] ? projectStoredCapture(result.rows[0]) : null;
}

/** Provider-neutral encrypted SecretStore implementation for the local operator ceremony. */
export class PostgresStripeCredentialSecretStore implements StripeCredentialSecretStore {
  async captureReplacement(input: {
    intent: StripeRotationIntent;
    evidence: StripeDashboardEvidence;
    evidenceDigest: `sha256:${string}`;
    replacement: Uint8Array;
    fingerprint: `sha256:${string}`;
    capturedAt: Date;
  }): Promise<StoredStripeCapture> {
    const id = randomUUID();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', readStripeCredentialStoreEncryptionKey(), iv);
    const replacement = Buffer.from(input.replacement.buffer, input.replacement.byteOffset, input.replacement.byteLength);
    const encryptedValue = Buffer.concat([cipher.update(replacement), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const provenance = StripeCaptureProvenanceSchema.parse({
      schemaVersion: STRIPE_CAPTURE_PROVENANCE_VERSION,
      captureReceiptReference: `credential-capture://rorca/${id}`,
      provider: 'stripe',
      channel: 'trusted_local_operator',
      providerEvidenceId: input.evidence.evidenceId,
      operatorId: input.evidence.operatorId,
      capturedAt: input.capturedAt.toISOString(),
      targetBindingReference: input.intent.targetBindingReference,
    });
    const canonicalEvidenceBytes = Buffer.from(stableWalJson(input.evidence), 'utf8');

    return canonicalTransaction(async (client) => {
      const inserted = await client.query<StoredStripeCaptureRow>(
        `INSERT INTO provider_credential_secret_objects (
           id, rotation_intent_id, intent_digest, workspace_id, provider,
           provider_account_id, mode, credential_class, permission_manifest,
           target_binding_reference, encrypted_value, encryption_iv,
           encryption_auth_tag, fingerprint, provider_evidence,
           provider_evidence_canonical_bytes, provider_evidence_digest,
           provenance, status
         ) VALUES ($1,$2,$3,$4,'stripe',$5,$6,'restricted_api_key',$7::jsonb,
                   $8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16::jsonb,'captured')
         ON CONFLICT (rotation_intent_id) DO NOTHING
         RETURNING id, rotation_intent_id, intent_digest, workspace_id,
                   provider_account_id, mode, permission_manifest,
                   target_binding_reference, fingerprint, provider_evidence_digest,
                   provenance`,
        [id, input.intent.intentId, input.intent.intentDigest, input.intent.workspaceId,
          input.intent.accountId, input.intent.mode, JSON.stringify(input.intent.permissionManifest),
          input.intent.targetBindingReference, encryptedValue, iv, authTag, input.fingerprint,
          JSON.stringify(input.evidence), canonicalEvidenceBytes, input.evidenceDigest,
          JSON.stringify(provenance)],
      );
      if (inserted.rows[0]) return projectStoredCapture(inserted.rows[0]);
      const replay = await client.query<StoredStripeCaptureRow>(
        `SELECT id, rotation_intent_id, intent_digest, workspace_id,
                provider_account_id, mode, permission_manifest,
                target_binding_reference, fingerprint, provider_evidence_digest,
                provenance
           FROM provider_credential_secret_objects
          WHERE rotation_intent_id = $1`,
        [input.intent.intentId],
      );
      if (!replay.rows[0]) throw new ConflictError('Stripe secure capture replay could not be reconciled');
      const projected = projectStoredCapture(replay.rows[0]);
      if (projected.intentDigest !== input.intent.intentDigest
          || projected.providerEvidenceDigest !== input.evidenceDigest
          || projected.result.fingerprint !== input.fingerprint) {
        throw new ConflictError('Stripe secure capture intent already has different replacement evidence');
      }
      return projected;
    });
  }

  async getCapture(captureReceiptReference: string): Promise<StoredStripeCapture | null> {
    return canonicalTransaction((client) => selectCapture(client, captureReceiptReference));
  }
}

function fingerprintReplacement(replacement: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(replacement).digest('hex')}`;
}

function assertRestrictedKeyForMode(replacement: Uint8Array, mode: 'test' | 'live'): void {
  const expectedPrefix = Buffer.from(`rk_${mode}_`, 'ascii');
  if (replacement.byteLength < expectedPrefix.byteLength + 8 || replacement.byteLength > 512) {
    throw new UnprocessableError('Stripe replacement is not a restricted key in the approved mode', 'STRIPE_REPLACEMENT_MODE_OR_KIND_MISMATCH');
  }
  for (let index = 0; index < expectedPrefix.byteLength; index += 1) {
    if (replacement[index] !== expectedPrefix[index]) {
      throw new UnprocessableError('Stripe replacement is not a restricted key in the approved mode', 'STRIPE_REPLACEMENT_MODE_OR_KIND_MISMATCH');
    }
  }
  for (let index = expectedPrefix.byteLength; index < replacement.byteLength; index += 1) {
    const character = replacement[index];
    const alphaNumeric = (character >= 48 && character <= 57)
      || (character >= 65 && character <= 90)
      || (character >= 97 && character <= 122);
    if (!alphaNumeric) {
      throw new UnprocessableError('Stripe replacement is not a restricted key in the approved mode', 'STRIPE_REPLACEMENT_MODE_OR_KIND_MISMATCH');
    }
  }
}

/**
 * Trusted local entry point. It is intentionally not an Express handler: raw
 * replacement bytes move only from the operator process into SecretStore.
 */
export class StripeSecureOperatorCapture {
  constructor(
    private readonly secretStore: StripeCredentialSecretStore = new PostgresStripeCredentialSecretStore(),
    private readonly evidenceVerifier = new StripeDashboardEvidenceVerifier(),
  ) {}

  async capture(input: {
    intent: StripeRotationIntent;
    evidence: StripeDashboardEvidence;
    replacement: Uint8Array;
    now?: Date;
  }): Promise<StripeSecureCaptureResult> {
    const intent = StripeRotationIntentSchema.parse(input.intent);
    if (intent.state !== 'WAITING_FOR_AUTHENTICATION') {
      throw new ConflictError('Stripe secure capture requires an intent waiting for authentication');
    }
    const now = input.now ?? new Date();
    const evidence = this.evidenceVerifier.verify(input.evidence, intent, now);
    assertRestrictedKeyForMode(input.replacement, intent.mode);
    const fingerprint = fingerprintReplacement(input.replacement);
    if (fingerprint !== evidence.replacementFingerprint) {
      throw new ForbiddenError('Stripe replacement does not match the signed Dashboard evidence');
    }
    const evidenceDigest = `sha256:${createHash('sha256').update(stableWalJson(evidence), 'utf8').digest('hex')}` as const;
    const stored = await this.secretStore.captureReplacement({
      intent,
      evidence,
      evidenceDigest,
      replacement: input.replacement,
      fingerprint,
      capturedAt: now,
    });
    return StripeSecureCaptureResultSchema.parse(stored.result);
  }
}
