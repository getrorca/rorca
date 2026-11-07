/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Provider-neutral delivery contract. Delivery is evidence projection, not merge or deploy authority. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const DELIVERY_ADAPTER_CONTRACT_VERSION = 'rorca.delivery-adapter.v1' as const;
export const LOCAL_REVIEW_BUNDLE_SCHEMA_VERSION = 'rorca.local-review-bundle.v1' as const;
export const LOCAL_REVIEW_BUNDLE_READ_MODEL_VERSION = 'rorca.local-review-bundle-read.v1' as const;
export const LOCAL_REVIEW_BUNDLE_ADAPTER_ID = 'local-review-bundle' as const;
export const LOCAL_REVIEW_BUNDLE_ADAPTER_VERSION = '1.1.0' as const;
export const DEFAULT_DELIVERY_ADAPTER_ID = LOCAL_REVIEW_BUNDLE_ADAPTER_ID;

export const SHA1_PATTERN = /^[0-9a-f]{40}$/;
export const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const DeliveryAdapterDescriptorSchema = z.object({
  contractVersion: z.literal(DELIVERY_ADAPTER_CONTRACT_VERSION),
  adapterId: z.string().min(1).max(80),
  adapterVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  label: z.string().min(1).max(120),
  kind: z.enum(['local', 'provider']),
  default: z.boolean(),
  optional: z.boolean(),
  requiresNetwork: z.boolean(),
  requiresCredentials: z.boolean(),
  supportsReviewBundle: z.boolean(),
  supportsExternalChangeRequest: z.boolean(),
  implementationStatus: z.enum(['canonical_adapter', 'legacy_optional_surfaces']),
  mergeAuthority: z.literal('none'),
  deploymentAuthority: z.literal('none'),
}).strict();

export type DeliveryAdapterDescriptor = z.infer<typeof DeliveryAdapterDescriptorSchema>;

export const LOCAL_REVIEW_BUNDLE_ADAPTER_DESCRIPTOR: DeliveryAdapterDescriptor = Object.freeze({
  contractVersion: DELIVERY_ADAPTER_CONTRACT_VERSION,
  adapterId: LOCAL_REVIEW_BUNDLE_ADAPTER_ID,
  adapterVersion: LOCAL_REVIEW_BUNDLE_ADAPTER_VERSION,
  label: 'Local review bundle',
  kind: 'local',
  default: true,
  optional: false,
  requiresNetwork: false,
  requiresCredentials: false,
  supportsReviewBundle: true,
  supportsExternalChangeRequest: false,
  implementationStatus: 'canonical_adapter',
  mergeAuthority: 'none',
  deploymentAuthority: 'none',
});

/** Canonical opt-in GitHub authority adapter; provider actuation always requires separate external-send authority. */
export const GITHUB_OPTIONAL_ADAPTER_DESCRIPTOR: DeliveryAdapterDescriptor = Object.freeze({
  contractVersion: DELIVERY_ADAPTER_CONTRACT_VERSION,
  adapterId: 'github-app',
  adapterVersion: '1.0.0',
  label: 'GitHub App review delivery',
  kind: 'provider',
  default: false,
  optional: true,
  requiresNetwork: true,
  requiresCredentials: true,
  supportsReviewBundle: false,
  supportsExternalChangeRequest: true,
  implementationStatus: 'canonical_adapter',
  mergeAuthority: 'none',
  deploymentAuthority: 'none',
});

/** Canonical opt-in Forgejo authority adapter; provider actuation always requires separate external-send authority. */
export const FORGEJO_OPTIONAL_ADAPTER_DESCRIPTOR: DeliveryAdapterDescriptor = Object.freeze({
  contractVersion: DELIVERY_ADAPTER_CONTRACT_VERSION,
  adapterId: 'forgejo',
  adapterVersion: '1.0.0',
  label: 'Forgejo review delivery',
  kind: 'provider',
  default: false,
  optional: true,
  requiresNetwork: true,
  requiresCredentials: true,
  supportsReviewBundle: false,
  supportsExternalChangeRequest: true,
  implementationStatus: 'canonical_adapter',
  mergeAuthority: 'none',
  deploymentAuthority: 'none',
});

/** Experimental local-operator browser identity broker. It never grants delivery authority. */
export const BROWSER_SESSION_BROKER_ADAPTER_DESCRIPTOR: DeliveryAdapterDescriptor = Object.freeze({
  contractVersion: DELIVERY_ADAPTER_CONTRACT_VERSION,
  adapterId: 'browser-session-broker',
  adapterVersion: '1.0.0',
  label: 'Authenticated browser session broker',
  kind: 'provider',
  default: false,
  optional: true,
  requiresNetwork: true,
  requiresCredentials: true,
  supportsReviewBundle: false,
  supportsExternalChangeRequest: false,
  implementationStatus: 'canonical_adapter',
  mergeAuthority: 'none',
  deploymentAuthority: 'none',
});

const DigestSchema = z.string().regex(SHA256_PATTERN);
const GitShaSchema = z.string().regex(SHA1_PATTERN);
const FORBIDDEN_LOCAL_REVIEW_PATH_SEGMENT = /^(?:\.git(?:modules)?|\.ssh|\.aws|\.azure|\.gcloud|\.gnupg|\.docker|\.kube|\.env(?:\..*)?|\.npmrc|\.pypirc|credentials?(?:[-_.].*)?|secrets?(?:[-_.].*)?|auth(?:[-_.].*)?|tokens?(?:[-_.].*)?|service[-_.]?accounts?(?:[-_.].*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|jks|keystore|secret|kdbx))$/i;
export const SafeRelativePathSchema = z.string().min(1).max(4096).refine((value) => {
  if (value.startsWith('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0
      && segment !== '.' && segment !== '..'
      && !FORBIDDEN_LOCAL_REVIEW_PATH_SEGMENT.test(segment))
    && segments.join('/') === value;
}, 'Expected a normalized non-secret safe relative path');

export const LocalReviewFileSnapshotSchema = z.object({
  bytes: z.number().int().min(0).max(1024 * 1024),
  sha256: DigestSchema,
}).strict();

export const LocalReviewChangedFileSchema = z.object({
  path: SafeRelativePathSchema,
  change: z.enum(['added', 'modified', 'deleted', 'type_changed', 'unmerged', 'unknown']),
  before: LocalReviewFileSnapshotSchema.nullable(),
  after: LocalReviewFileSnapshotSchema.nullable(),
}).strict().refine((value) => value.before !== null || value.after !== null, {
  message: 'A changed file must bind at least one exact Git snapshot',
});

export const LocalReviewArtifactSchema = z.object({
  name: z.literal('changes.patch'),
  mediaType: z.literal('text/x-diff'),
  bytes: z.number().int().min(0).max(8 * 1024 * 1024),
  sha256: DigestSchema,
}).strict();

export const LocalReviewEvidenceReferenceSchema = z.object({
  kind: z.enum(['host_attempt', 'execution_manifest', 'attempt_result', 'closeout_decision', 'validation_receipt', 'run_closeout']),
  reference: z.string().min(1).max(255),
  digest: DigestSchema.nullable(),
  trustClass: z.literal('host_observed'),
}).strict();

export const LocalReviewValidationReceiptSchema = z.object({
  receiptId: z.string().min(1).max(255),
  gate: z.string().min(1).max(80),
  checkpointSha: GitShaSchema,
  evidenceDigest: DigestSchema,
  passedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  revoked: z.boolean(),
  trustClass: z.literal('host_observed'),
}).strict();

export const LocalReviewBundleManifestSchema = z.object({
  schemaVersion: z.literal(LOCAL_REVIEW_BUNDLE_SCHEMA_VERSION),
  adapter: DeliveryAdapterDescriptorSchema,
  bundleId: z.string().regex(/^lrb-[0-9a-f]{64}$/),
  contentHash: DigestSchema,
  idempotencyKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  identity: z.object({
    workspaceId: z.string().min(1).max(255),
    specId: z.string().min(1).max(255),
    storyId: z.string().min(1).max(160),
    runId: z.number().int().positive(),
    attempt: z.number().int().positive(),
    generation: z.string().regex(UUID_PATTERN),
    hostAttemptEnvelopeId: z.string().regex(UUID_PATTERN),
  }).strict(),
  specification: z.object({
    canonicalPath: SafeRelativePathSchema,
    revision: DigestSchema,
    bytesHash: DigestSchema,
    storyRevision: DigestSchema,
    executionManifestHash: DigestSchema,
  }).strict(),
  repository: z.object({
    repositoryIdentity: DigestSchema,
    repositoryPathDigest: DigestSchema,
    worktreeIdentity: DigestSchema,
    worktreePathDigest: DigestSchema,
    runBaseSha: GitShaSchema,
    baseSha: GitShaSchema,
    headSha: GitShaSchema,
    branch: z.string().min(1).max(1024),
  }).strict(),
  changedFiles: z.array(LocalReviewChangedFileSchema).max(500),
  artifacts: z.array(LocalReviewArtifactSchema).length(1),
  validation: z.object({
    status: z.enum(['passed', 'blocked']),
    authoredBy: z.enum(['host_closeout', 'none']),
    receipts: z.array(LocalReviewValidationReceiptSchema).max(32),
    agentProseAccepted: z.literal(false),
    ptyAccepted: z.literal(false),
    processExitAcceptedAsPass: z.literal(false),
    memoryAccepted: z.literal(false),
  }).strict(),
  evidenceReferences: z.array(LocalReviewEvidenceReferenceSchema).max(64),
  createdAt: z.string().datetime(),
  delivery: z.object({
    reviewStatus: z.literal('awaiting_local_review'),
    mergeStatus: z.literal('not_authorized'),
    deploymentStatus: z.literal('not_authorized'),
    mergeAuthority: z.literal('none'),
    deploymentAuthority: z.literal('none'),
  }).strict(),
}).strict();

export type LocalReviewBundleManifest = z.infer<typeof LocalReviewBundleManifestSchema>;

export const LocalReviewBundleReadModelSchema = z.object({
  schemaVersion: z.literal(LOCAL_REVIEW_BUNDLE_READ_MODEL_VERSION),
  bundleId: z.string().regex(/^lrb-[0-9a-f]{64}$/),
  adapter: z.object({
    contractVersion: z.literal(DELIVERY_ADAPTER_CONTRACT_VERSION),
    adapterId: z.literal(LOCAL_REVIEW_BUNDLE_ADAPTER_ID),
    adapterVersion: z.string(),
    default: z.literal(true),
    requiresNetwork: z.literal(false),
    requiresCredentials: z.literal(false),
  }).strict(),
  identity: LocalReviewBundleManifestSchema.shape.identity,
  specification: LocalReviewBundleManifestSchema.shape.specification,
  repository: LocalReviewBundleManifestSchema.shape.repository,
  changedFileCount: z.number().int().min(0).max(500),
  changedContentBytes: z.number().int().min(0).max(8 * 1024 * 1024),
  artifacts: z.array(LocalReviewArtifactSchema).length(1),
  validation: z.object({
    status: z.enum(['passed', 'blocked']),
    authoredBy: z.enum(['host_closeout', 'none']),
    receiptCount: z.number().int().min(0).max(32),
    evidenceReferenceCount: z.number().int().min(0).max(64),
    rejectsAgentAuthoredPass: z.literal(true),
  }).strict(),
  createdAt: z.string().datetime(),
  projectionKey: z.string().regex(/^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/),
  projectionIntegrity: z.enum(['verified', 'missing', 'corrupt']),
  delivery: LocalReviewBundleManifestSchema.shape.delivery,
}).strict();

export type LocalReviewBundleReadModel = z.infer<typeof LocalReviewBundleReadModelSchema>;

export interface DeliveryCreateRequest {
  workspaceId: string;
  runId: number;
  storyId: string;
  attempt: number;
  generation: string;
  hostAttemptEnvelopeId: string;
  idempotencyKey: string;
  requestedBy: string;
}

export interface DeliveryCreateResult {
  manifest: LocalReviewBundleManifest;
  manifestHash: string;
  projectionKey: string;
  replayed: boolean;
}

export interface DeliveryAdapter {
  readonly descriptor: DeliveryAdapterDescriptor;
  create(request: DeliveryCreateRequest): Promise<DeliveryCreateResult>;
}

type JsonRecord = Record<string, unknown>;

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as JsonRecord)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]) => [key, sortJson(nested)]));
}

export function canonicalDeliveryJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

export function deliverySha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function getDeliveryAdapterCatalog(): {
  contractVersion: typeof DELIVERY_ADAPTER_CONTRACT_VERSION;
  defaultAdapterId: typeof DEFAULT_DELIVERY_ADAPTER_ID;
  adapters: DeliveryAdapterDescriptor[];
} {
  return {
    contractVersion: DELIVERY_ADAPTER_CONTRACT_VERSION,
    defaultAdapterId: DEFAULT_DELIVERY_ADAPTER_ID,
    adapters: [LOCAL_REVIEW_BUNDLE_ADAPTER_DESCRIPTOR, GITHUB_OPTIONAL_ADAPTER_DESCRIPTOR, FORGEJO_OPTIONAL_ADAPTER_DESCRIPTOR],
  };
}
