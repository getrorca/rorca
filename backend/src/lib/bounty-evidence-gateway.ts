/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash, randomUUID } from 'node:crypto';

export const EVIDENCE_SOURCES = ['target-response', 'browser-artifact', 'callback', 'local-tool', 'worker-observation', 'oracle-result'] as const;
export type EvidenceSource = typeof EVIDENCE_SOURCES[number];
export const EVIDENCE_REASON_CODES = ['LATE', 'STALE', 'CROSS_PROGRAM', 'OVERSIZED', 'TAMPERED', 'UNTRACEABLE', 'ACTIVE_DOCUMENT_UNSANDBOXED', 'POLICY_VIOLATION'] as const;
export type EvidenceReasonCode = typeof EVIDENCE_REASON_CODES[number];
export type EvidenceDisposition = 'admitted' | 'rejected' | 'quarantined';
export type Sensitivity = 'public' | 'program-confidential' | 'secret' | 'regulated';

export interface EvidenceBinding {
  programId: string; missionId: string; generationId: string; packageId: string; attemptId: string;
  operationId: string; producerId: string; source: EvidenceSource; sensitivity: Sensitivity; lineage: readonly string[];
  authorityEpoch: number;
}
export interface InertTargetClaim { kind: 'command' | 'tool-call' | 'approval' | 'url' | 'scope-claim'; value: unknown }
export interface EvidenceRetentionPolicy {
  retainRaw: boolean; encryptionKeyRef?: string; accessRoles: readonly string[]; legalHold: boolean;
  expiresAt: string; tombstoneOnDelete: boolean; integrityManifest: boolean;
}
export interface ActiveDocumentSandboxReceipt {
  sandboxId: string; disposable: true; network: 'disabled'; destroyedAt: string; inputHash: string;
}
export interface EvidenceSubmission {
  binding: EvidenceBinding;
  bytes?: Uint8Array;
  immutableRef?: { uri: string; digest: string; byteLength: number };
  expectedOriginalHash?: string;
  mediaType: string;
  observedAt: string;
  submittedAt?: string;
  targetClaims?: readonly InertTargetClaim[];
  sandboxReceipt?: ActiveDocumentSandboxReceipt;
}
export interface EvidenceContext {
  programId: string; missionId: string; generationId: string; packageId: string; attemptId: string; operationId: string;
  authorityEpoch: number; currentAuthorityEpoch: number;
  now?: number; earliestObservedAt: string; latestObservedAt: string;
}
export interface EvidencePolicy { maxBytes: number; transformVersion: string; activeDocumentMediaTypes: readonly string[]; retention: EvidenceRetentionPolicy }
export interface AdmittedEvidence {
  id: string; binding: Readonly<EvidenceBinding>; disposition: EvidenceDisposition; reasonCodes: readonly EvidenceReasonCode[];
  originalHash: string; redactedHash?: string; transformVersion?: string; byteLength: number; mediaType: string;
  targetClaims: readonly Readonly<InertTargetClaim>[]; retention: Readonly<EvidenceRetentionPolicy>; sandboxReceipt?: Readonly<ActiveDocumentSandboxReceipt>;
}

const sha256 = (bytes: Uint8Array | string): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const validHash = (value: string): boolean => /^sha256:[a-f0-9]{64}$/.test(value);
const freeze = <T>(value: T): Readonly<T> => Object.freeze(value);

/**
 * Admission boundary for all model-bound bounty evidence. It returns data only: target claims are
 * deliberately inert and cannot mutate authority, routing, budgets, approvals, or stop state.
 */
export class BountyEvidenceGateway {
  constructor(private readonly policy: Readonly<EvidencePolicy>, private readonly redact: (bytes: Uint8Array, sensitivity: Sensitivity) => Uint8Array) {
    if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes < 1 || !policy.transformVersion || !policy.retention.accessRoles.length ||
        !Number.isFinite(Date.parse(policy.retention.expiresAt)) || (policy.retention.retainRaw && !policy.retention.encryptionKeyRef) ||
        !policy.retention.tombstoneOnDelete || !policy.retention.integrityManifest) throw new TypeError('invalid evidence governance policy');
  }

  admit(input: EvidenceSubmission, context: EvidenceContext): Readonly<AdmittedEvidence> {
    const reasons: EvidenceReasonCode[] = [];
    const bytes = input.bytes;
    const originalHash = bytes ? sha256(bytes) : input.immutableRef?.digest ?? '';
    const length = bytes?.byteLength ?? input.immutableRef?.byteLength ?? 0;
    if (!bytes && (!input.immutableRef || !validHash(input.immutableRef.digest) || !input.immutableRef.uri || !Number.isSafeInteger(input.immutableRef.byteLength) || input.immutableRef.byteLength < 0)) reasons.push('UNTRACEABLE');
    if (bytes && input.immutableRef) reasons.push('POLICY_VIOLATION');
    if (!validHash(originalHash) || input.expectedOriginalHash && input.expectedOriginalHash !== originalHash) reasons.push('TAMPERED');
    if (length > this.policy.maxBytes) reasons.push('OVERSIZED');
    const identityKeys = ['programId', 'missionId', 'generationId', 'packageId', 'attemptId', 'operationId', 'producerId', 'source', 'sensitivity'] as const;
    const required = identityKeys.every((key) => typeof input.binding[key] === 'string' && input.binding[key].length > 0);
    if (!required || !input.binding.lineage.length || !input.binding.lineage.every(validHash) || !Number.isSafeInteger(input.binding.authorityEpoch) || input.binding.authorityEpoch < 1) reasons.push('UNTRACEABLE');
    const keys = ['programId', 'missionId', 'generationId', 'packageId', 'attemptId', 'operationId'] as const;
    if (keys.some(key => input.binding[key] !== context[key])) reasons.push('CROSS_PROGRAM');
    if (input.binding.authorityEpoch !== context.authorityEpoch || context.authorityEpoch !== context.currentAuthorityEpoch) reasons.push('STALE');
    const observed = Date.parse(input.observedAt); const submitted = Date.parse(input.submittedAt ?? new Date(context.now ?? Date.now()).toISOString());
    if (!Number.isFinite(observed) || observed < Date.parse(context.earliestObservedAt)) reasons.push('STALE');
    if (!Number.isFinite(submitted) || submitted > Date.parse(context.latestObservedAt) || submitted < observed) reasons.push('LATE');
    if (this.policy.activeDocumentMediaTypes.includes(input.mediaType)) {
      const receipt = input.sandboxReceipt;
      if (!receipt || !receipt.disposable || receipt.network !== 'disabled' || !receipt.destroyedAt || receipt.inputHash !== originalHash) reasons.push('ACTIVE_DOCUMENT_UNSANDBOXED');
    }
    const redacted = bytes && reasons.length === 0 ? this.redact(Uint8Array.from(bytes), input.binding.sensitivity) : undefined;
    const disposition: EvidenceDisposition = reasons.length === 0 ? 'admitted' : reasons.some(r => r === 'TAMPERED' || r === 'CROSS_PROGRAM' || r === 'UNTRACEABLE') ? 'rejected' : 'quarantined';
    return freeze({
      id: randomUUID(), binding: freeze({ ...input.binding, lineage: freeze([...input.binding.lineage]) }), disposition, reasonCodes: freeze([...new Set(reasons)]),
      originalHash, redactedHash: redacted ? sha256(redacted) : undefined, transformVersion: redacted ? this.policy.transformVersion : undefined,
      byteLength: length, mediaType: input.mediaType, targetClaims: freeze((input.targetClaims ?? []).map(claim => freeze({ kind: claim.kind, value: structuredClone(claim.value) }))),
      retention: freeze({ ...this.policy.retention, accessRoles: freeze([...this.policy.retention.accessRoles]) }), sandboxReceipt: input.sandboxReceipt ? freeze({ ...input.sandboxReceipt }) : undefined,
    });
  }

  deletionTombstone(item: AdmittedEvidence, deletedAt = new Date().toISOString()): Readonly<{ evidenceId: string; originalHash: string; deletedAt: string; legalHold: boolean }> {
    if (item.retention.legalHold) throw new Error('evidence is under legal hold');
    return freeze({ evidenceId: item.id, originalHash: item.originalHash, deletedAt, legalHold: false });
  }

  integrityManifest(items: readonly AdmittedEvidence[]): Readonly<{ algorithm: 'sha256'; itemHashes: readonly string[]; rootHash: string }> {
    const itemHashes = items.map(item => sha256(JSON.stringify([item.id, item.originalHash, item.redactedHash, item.binding.lineage]))).sort();
    return freeze({ algorithm: 'sha256', itemHashes: freeze(itemHashes), rootHash: sha256(itemHashes.join('\n')) });
  }
}
