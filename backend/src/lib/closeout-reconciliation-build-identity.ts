/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Startup-captured deployment identity for historical closeout correction. */
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { ServiceUnavailableError } from './errors';
import { hasExactHostTimestampPrecisionCapability } from './run-host-authority';
import { measureCloseoutReconciliationArtifact } from './closeout-reconciliation-artifact';
import {
  assertWave1DeploymentBinding,
  WAVE_1_IMPLEMENTATION_BASELINE_SHA,
  WAVE_1_SOURCE_REPOSITORY,
  WAVE_1_SPEC_CONTENT_HASH,
} from './wave-1-stabilization';

export const CLOSEOUT_RECONCILIATION_BUILD_RECEIPT_VERSION = 'rorca.build-identity-receipt.v1' as const;
// This integration commit is an actual ancestor of the Wave branch and contains
// the exact timestamp fix. The prior value named a non-ancestor sibling commit
// with an equivalent patch but supplied no governed equivalence proof.
export const REQUIRED_CLOSEOUT_TIMESTAMP_FIX_SHA = 'e0fbcff3dd227ef918da71e3b0fe8761ee79b6d1' as const;
export const CLOSEOUT_RECONCILIATION_BUILD_RECEIPT_ENV = 'RORCA_BUILD_IDENTITY_RECEIPT' as const;
export const CLOSEOUT_RECONCILIATION_BUILD_VERIFICATION_KEY_ENV = 'RORCA_BUILD_IDENTITY_VERIFICATION_KEY' as const;

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ED25519_SIGNATURE = /^ed25519:[A-Za-z0-9+/]{86}==$/;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,255}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const CloseoutReconciliationBuildReceiptSchema = z.object({
  schemaVersion: z.literal(CLOSEOUT_RECONCILIATION_BUILD_RECEIPT_VERSION),
  buildSha: z.string().regex(SHA1),
  reviewedSourceSha: z.string().regex(SHA1),
  requiredFixSha: z.literal(REQUIRED_CLOSEOUT_TIMESTAMP_FIX_SHA),
  artifactDigest: z.string().regex(SHA256),
  deploymentId: z.string().regex(BOUNDED_ID),
  deploymentEnvironment: z.literal('production'),
  workspaceId: z.string().trim().min(1).max(160),
  canonicalSpecPath: z.literal('forge/specs/pending/wave-1-stabilize-evidence-closeout-and-managed-branch-delivery.json'),
  issuer: z.literal('rorca-release-authority'),
  keyId: z.string().regex(BOUNDED_ID),
  signature: z.string().regex(ED25519_SIGNATURE),
  issuedAt: z.string().regex(UTC_TIMESTAMP).refine((value) => Number.isFinite(Date.parse(value))),
  implementationBaselineSha: z.literal(WAVE_1_IMPLEMENTATION_BASELINE_SHA),
  waveSpecRevision: z.literal(WAVE_1_SPEC_CONTENT_HASH),
  sourceRepository: z.literal(WAVE_1_SOURCE_REPOSITORY),
}).strict();

export type CloseoutReconciliationBuildReceipt = z.infer<typeof CloseoutReconciliationBuildReceiptSchema>;

export interface CloseoutReconciliationBuildIdentity {
  buildSha: string;
  buildReceiptHash: string;
  buildReceipt: Readonly<CloseoutReconciliationBuildReceipt>;
  requiredFixSha: typeof REQUIRED_CLOSEOUT_TIMESTAMP_FIX_SHA;
  implementationBaselineSha: typeof WAVE_1_IMPLEMENTATION_BASELINE_SHA;
  waveSpecRevision: typeof WAVE_1_SPEC_CONTENT_HASH;
  sourceRepository: typeof WAVE_1_SOURCE_REPOSITORY;
  artifactDigest: string;
  verification: 'startup-deployment-receipt+measured-artifact+runtime-capability';
}

export interface StartupCapture {
  identity: Readonly<CloseoutReconciliationBuildIdentity> | null;
  error: string | null;
}

function canonicalUnsignedReceipt(receipt: CloseoutReconciliationBuildReceipt): string {
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    buildSha: receipt.buildSha,
    reviewedSourceSha: receipt.reviewedSourceSha,
    requiredFixSha: receipt.requiredFixSha,
    artifactDigest: receipt.artifactDigest,
    deploymentId: receipt.deploymentId,
    deploymentEnvironment: receipt.deploymentEnvironment,
    workspaceId: receipt.workspaceId,
    canonicalSpecPath: receipt.canonicalSpecPath,
    issuer: receipt.issuer,
    keyId: receipt.keyId,
    issuedAt: receipt.issuedAt,
    implementationBaselineSha: receipt.implementationBaselineSha,
    waveSpecRevision: receipt.waveSpecRevision,
    sourceRepository: receipt.sourceRepository,
  });
}

function canonicalReceipt(receipt: CloseoutReconciliationBuildReceipt): string {
  return JSON.stringify({
    ...JSON.parse(canonicalUnsignedReceipt(receipt)) as Record<string, unknown>,
    signature: receipt.signature,
  });
}

function verifyReceiptSignature(receipt: CloseoutReconciliationBuildReceipt, publicKey: string | undefined): boolean {
  if (!publicKey?.includes('BEGIN PUBLIC KEY')) return false;
  try {
    const key = crypto.createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const signature = Buffer.from(receipt.signature.slice('ed25519:'.length), 'base64');
    return signature.length === 64 && crypto.verify(
      null,
      Buffer.from(canonicalUnsignedReceipt(receipt), 'utf8'),
      key,
      signature,
    );
  } catch {
    return false;
  }
}

function receiptHash(receipt: CloseoutReconciliationBuildReceipt): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalReceipt(receipt)).digest('hex')}`;
}

/**
 * Parse and freeze the deployment receipt exactly once. This deliberately does
 * not inspect Git or accept RORCA_BUILD_SHA: a mutable checkout cannot attest
 * which artifact an already-running API or worker process loaded.
 */
export function captureCloseoutReconciliationBuildIdentity(
  raw: string | undefined,
  verificationKey: string | undefined = process.env[CLOSEOUT_RECONCILIATION_BUILD_VERIFICATION_KEY_ENV],
): StartupCapture {
  const serialized = String(raw ?? '').trim();
  if (!serialized) {
    return {
      identity: null,
      error: `${CLOSEOUT_RECONCILIATION_BUILD_RECEIPT_ENV} was absent at process startup`,
    };
  }
  if (Buffer.byteLength(serialized, 'utf8') > 4096) {
    return { identity: null, error: 'Build identity receipt exceeds the 4096-byte startup bound' };
  }
  try {
    const parsed = CloseoutReconciliationBuildReceiptSchema.parse(JSON.parse(serialized) as unknown);
    assertWave1DeploymentBinding(parsed);
    const measuredArtifact = measureCloseoutReconciliationArtifact();
    if (parsed.buildSha !== parsed.reviewedSourceSha
      || parsed.requiredFixSha !== REQUIRED_CLOSEOUT_TIMESTAMP_FIX_SHA
      || parsed.artifactDigest !== measuredArtifact.digest
      || !verifyReceiptSignature(parsed, verificationKey)) {
      return { identity: null, error: 'Build identity receipt signature or reviewed source binding is invalid' };
    }
    const buildReceipt = Object.freeze({ ...parsed });
    return {
      identity: Object.freeze({
        buildSha: buildReceipt.buildSha,
        buildReceiptHash: receiptHash(buildReceipt),
        buildReceipt,
        requiredFixSha: REQUIRED_CLOSEOUT_TIMESTAMP_FIX_SHA,
        implementationBaselineSha: buildReceipt.implementationBaselineSha,
        waveSpecRevision: buildReceipt.waveSpecRevision,
        sourceRepository: buildReceipt.sourceRepository,
        artifactDigest: measuredArtifact.digest,
        verification: 'startup-deployment-receipt+measured-artifact+runtime-capability' as const,
      }),
      error: null,
    };
  } catch {
    return { identity: null, error: 'Build identity receipt was malformed at process startup' };
  }
}

// Module initialization is the process-startup capture boundary. Later changes
// to process.env or the checkout cannot alter this immutable in-memory receipt.
const STARTUP_CAPTURE = captureCloseoutReconciliationBuildIdentity(
  process.env[CLOSEOUT_RECONCILIATION_BUILD_RECEIPT_ENV],
  process.env[CLOSEOUT_RECONCILIATION_BUILD_VERIFICATION_KEY_ENV],
);

export function resolveCloseoutReconciliationBuildIdentity(): Readonly<CloseoutReconciliationBuildIdentity> {
  if (!STARTUP_CAPTURE.identity) {
    throw new ServiceUnavailableError(
      `Closeout reconciliation requires an exact startup deployment receipt: ${STARTUP_CAPTURE.error}`,
    );
  }
  if (!hasExactHostTimestampPrecisionCapability()) {
    throw new ServiceUnavailableError(
      `Running process lacks audited timestamp capability ${REQUIRED_CLOSEOUT_TIMESTAMP_FIX_SHA}`,
    );
  }
  return STARTUP_CAPTURE.identity;
}

export function sameCloseoutReconciliationBuildIdentity(
  expected: Pick<CloseoutReconciliationBuildIdentity,
    'buildSha' | 'buildReceiptHash' | 'requiredFixSha' | 'artifactDigest'
    | 'implementationBaselineSha' | 'waveSpecRevision' | 'sourceRepository'>,
  actual: Pick<CloseoutReconciliationBuildIdentity,
    'buildSha' | 'buildReceiptHash' | 'requiredFixSha' | 'artifactDigest'
    | 'implementationBaselineSha' | 'waveSpecRevision' | 'sourceRepository'>,
): boolean {
  return expected.buildSha === actual.buildSha
    && expected.buildReceiptHash === actual.buildReceiptHash
    && expected.requiredFixSha === actual.requiredFixSha
    && expected.artifactDigest === actual.artifactDigest
    && expected.implementationBaselineSha === actual.implementationBaselineSha
    && expected.waveSpecRevision === actual.waveSpecRevision
    && expected.sourceRepository === actual.sourceRepository;
}
