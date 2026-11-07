/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { apiFetch } from '../lib/apiFetch';

export interface DeliveryAdapterDescriptor {
  contractVersion: 'rorca.delivery-adapter.v1';
  adapterId: string;
  adapterVersion: string;
  label: string;
  kind: 'local' | 'provider';
  default: boolean;
  optional: boolean;
  requiresNetwork: boolean;
  requiresCredentials: boolean;
  supportsReviewBundle: boolean;
  supportsExternalChangeRequest: boolean;
  implementationStatus: 'canonical_adapter' | 'legacy_optional_surfaces';
  mergeAuthority: 'none';
  deploymentAuthority: 'none';
}

export interface DeliveryAdapterCatalog {
  contractVersion: 'rorca.delivery-adapter.v1';
  defaultAdapterId: 'local-review-bundle';
  adapters: DeliveryAdapterDescriptor[];
}

export interface LocalReviewBundleReadModel {
  schemaVersion: 'rorca.local-review-bundle-read.v1';
  bundleId: string;
  adapter: {
    contractVersion: string;
    adapterId: string;
    adapterVersion: string;
    default: boolean;
    requiresNetwork: false;
    requiresCredentials: false;
  };
  identity: {
    workspaceId: string;
    specId: string;
    storyId: string;
    runId: number;
    attempt: number;
    generation: string;
    hostAttemptEnvelopeId: string;
  };
  specification: {
    canonicalPath: string;
    revision: string;
    bytesHash: string;
    storyRevision: string;
    executionManifestHash: string;
  };
  repository: {
    repositoryIdentity: string;
    repositoryPathDigest: string;
    worktreeIdentity: string;
    worktreePathDigest: string;
    runBaseSha: string;
    baseSha: string;
    headSha: string;
    branch: string;
  };
  changedFileCount: number;
  changedContentBytes: number;
  artifacts: Array<{ name: 'changes.patch'; mediaType: 'text/x-diff'; bytes: number; sha256: string }>;
  validation: {
    status: 'passed' | 'blocked';
    authoredBy: 'host_closeout' | 'none';
    receiptCount: number;
    evidenceReferenceCount: number;
    rejectsAgentAuthoredPass: true;
  };
  createdAt: string;
  projectionKey: string;
  projectionIntegrity: 'verified' | 'missing' | 'corrupt';
  delivery: {
    reviewStatus: 'awaiting_local_review';
    mergeStatus: 'not_authorized';
    deploymentStatus: 'not_authorized';
    mergeAuthority: 'none';
    deploymentAuthority: 'none';
  };
}

export function getDeliveryAdapters(signal?: AbortSignal): Promise<DeliveryAdapterCatalog> {
  return apiFetch('/api/delivery/adapters', { signal });
}

export function listLocalReviewBundles(input: {
  workspaceId: string;
  runId?: number;
  limit?: number;
  signal?: AbortSignal;
}): Promise<{ schemaVersion: 'rorca.local-review-bundle-read.v1'; items: LocalReviewBundleReadModel[]; limit: number }> {
  const query = new URLSearchParams({ workspaceId: input.workspaceId });
  if (input.runId !== undefined) query.set('runId', String(input.runId));
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  return apiFetch(`/api/delivery/review-bundles?${query}`, { signal: input.signal });
}

export function getLocalReviewBundle(
  workspaceId: string,
  runId: number,
  bundleId: string,
  signal?: AbortSignal,
): Promise<LocalReviewBundleReadModel> {
  return apiFetch(`/api/delivery/review-bundles/${encodeURIComponent(bundleId)}?workspaceId=${encodeURIComponent(workspaceId)}&runId=${runId}`, { signal });
}

export async function deriveLocalReviewBundleIdempotencyKey(input: {
  workspaceId: string;
  runId: number;
  storyId: string;
  attempt: number;
  generation: string;
  hostAttemptEnvelopeId: string;
}): Promise<string> {
  const basis = JSON.stringify([
    'rorca.delivery-adapter.v1', 'local-review-bundle', '1.1.0', input.workspaceId,
    input.runId, input.storyId, input.attempt, input.generation, input.hostAttemptEnvelopeId,
  ]);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(basis));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `local-review:${input.runId}:${input.attempt}:${hex}`;
}

export function createLocalReviewBundle(input: {
  workspaceId: string;
  runId: number;
  storyId: string;
  attempt: number;
  generation: string;
  hostAttemptEnvelopeId: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<{
  schemaVersion: 'rorca.local-review-bundle.v1';
  bundleId: string;
  contentHash: string;
  manifestHash: string;
  projectionKey: string;
  replayed: boolean;
  validationStatus: 'passed' | 'blocked';
  delivery: LocalReviewBundleReadModel['delivery'];
}> {
  return apiFetch('/api/delivery/review-bundles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
    body: JSON.stringify({
      workspaceId: input.workspaceId,
      runId: input.runId,
      storyId: input.storyId,
      attempt: input.attempt,
      generation: input.generation,
      hostAttemptEnvelopeId: input.hostAttemptEnvelopeId,
    }),
    signal: input.signal,
  });
}
