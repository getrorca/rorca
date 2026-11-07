/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { createHash } from 'node:crypto';
import { ValidationError } from './errors';

export const BOUNTY_QUALIFICATION_SCHEMA_VERSION = 'bounty.qualification-receipt.v1' as const;
export const BOUNTY_QUALIFICATION_SUITE_KINDS = [
  'unit', 'property', 'postgresql', 'pg-boss', 'adapter', 'browser', 'sandbox',
  'concurrency', 'crash', 'recovery', 'route-tool', 'ui', 'oracle', 'receipt',
] as const;
export const BOUNTY_QUALIFICATION_CONTROL_IDS = [
  'sole-broker-egress', 'credential-isolation', 'scope-dns-redirect-containment',
  'rule-of-two', 'stop-ordering', 'evidence-integrity', 'zero-submission-paths',
] as const;
export const BOUNTY_QUALIFICATION_METRIC_KEYS = [
  'classSuccess', 'falsePositiveRate', 'rejectionRate', 'oracleFailures', 'costMicrousd',
  'inputTokens', 'outputTokens', 'activity', 'cacheSpendMicrousd', 'authSpendMicrousd',
] as const;
export const BOUNTY_REQUALIFICATION_TRIGGERS = [
  'prompt', 'skill', 'router', 'oracle', 'persona', 'model', 'runtime', 'policy',
  'broker', 'adapter', 'migration', 'configuration', 'corpus', 'test-evidence',
] as const;
export const BOUNTY_RECEIPT_BINDING_KEYS = [
  'sourceSha', 'sourceTreeHash', 'migrationHash', 'configHash', 'brokerHash', 'adapterHash',
  'promptHash', 'skillHash', 'routerHash', 'oracleHash', 'personaHash', 'modelHash',
  'runtimeHash', 'policyHash', 'evidenceRoot',
] as const;

const HASH = /^sha256:[0-9a-f]{64}$/;
const SOURCE_SHA = /^[0-9a-f]{40,64}$/;

type SuiteKind = typeof BOUNTY_QUALIFICATION_SUITE_KINDS[number];
type ControlId = typeof BOUNTY_QUALIFICATION_CONTROL_IDS[number];
type MetricKey = typeof BOUNTY_QUALIFICATION_METRIC_KEYS[number];
type RequalificationTrigger = typeof BOUNTY_REQUALIFICATION_TRIGGERS[number];
type BindingKey = typeof BOUNTY_RECEIPT_BINDING_KEYS[number];

export interface BountyQualificationSuiteEvidence {
  kind: SuiteKind;
  name: string;
  result: 'passed';
  evidenceSha256: string;
}

export interface BountyQualificationControlProof {
  id: ControlId;
  result: 'passed';
  namedTest: string;
  evidenceSha256: string;
}

export interface BountyQualificationReceipt {
  schemaVersion: typeof BOUNTY_QUALIFICATION_SCHEMA_VERSION;
  receiptId: string;
  candidateId: string;
  issuedAt: string;
  immutable: true;
  qualificationMode: 'hermetic';
  release: {
    qualifiedFixture: true;
    featureState: 'disabled';
    enableAvailable: false;
    disposition: string;
  };
  requalificationTriggers: RequalificationTrigger[];
  requalificationFingerprint: string;
  bindings: Record<BindingKey, string>;
  corpora: Array<{
    id: string;
    class: 'private' | 'anti-cheat';
    manifestSha256: string;
    itemCount: number;
    blinded: true;
    immutable: true;
    repositoryContentIncluded: false;
  }>;
  suiteEvidence: BountyQualificationSuiteEvidence[];
  controlProofs: BountyQualificationControlProof[];
  metrics: Record<MetricKey, unknown>;
  traceabilityHash: string;
  receiptHash: string;
}

export interface BountyQualificationStatus {
  state: 'requalification-required';
  featureState: 'disabled';
  releaseEnableAvailable: false;
  qualificationMode: 'hermetic';
  requiredSuiteCount: number;
  fixturePassedSuiteCount: number;
  requiredControlProofCount: number;
  requalificationTriggerCount: number;
  reason: string;
}

export const BOUNTY_QUALIFICATION_STATUS: Readonly<BountyQualificationStatus> = Object.freeze({
  state: 'requalification-required',
  featureState: 'disabled',
  releaseEnableAvailable: false,
  qualificationMode: 'hermetic',
  requiredSuiteCount: BOUNTY_QUALIFICATION_SUITE_KINDS.length,
  fixturePassedSuiteCount: BOUNTY_QUALIFICATION_SUITE_KINDS.length,
  requiredControlProofCount: BOUNTY_QUALIFICATION_CONTROL_IDS.length,
  requalificationTriggerCount: BOUNTY_REQUALIFICATION_TRIGGERS.length,
  reason: 'Hermetic fixture certification passed; an exact post-commit receipt is required before enablement.',
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function exactSet(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length
      || [...actual].sort().join('\n') !== [...expected].sort().join('\n')) {
    throw new ValidationError(`Bounty qualification ${label} is incomplete or duplicated`);
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new ValidationError(`Bounty qualification ${label} is not a SHA-256 digest`);
}

/**
 * Verify an immutable receipt and optionally bind it to identities recomputed
 * from the current checkout. A one-byte change in any required input makes the
 * receipt unusable; fixture qualification never makes enablement available.
 */
export function verifyBountyQualificationReceipt(
  candidate: unknown,
  currentBindings?: Record<BindingKey, string>,
): Readonly<BountyQualificationReceipt> {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new ValidationError('Bounty qualification receipt must be an object');
  }
  const receipt = candidate as BountyQualificationReceipt;
  if (receipt.schemaVersion !== BOUNTY_QUALIFICATION_SCHEMA_VERSION || receipt.immutable !== true
      || receipt.qualificationMode !== 'hermetic' || receipt.release?.qualifiedFixture !== true
      || receipt.release.featureState !== 'disabled' || receipt.release.enableAvailable !== false) {
    throw new ValidationError('Bounty qualification receipt cannot authorize this release posture');
  }
  if (!HASH.test(receipt.receiptId) || !receipt.candidateId || !Number.isFinite(Date.parse(receipt.issuedAt))) {
    throw new ValidationError('Bounty qualification receipt identity is invalid');
  }

  exactSet(receipt.requalificationTriggers ?? [], BOUNTY_REQUALIFICATION_TRIGGERS, 'requalification triggers');
  exactSet(receipt.suiteEvidence?.map((entry) => entry.kind) ?? [], BOUNTY_QUALIFICATION_SUITE_KINDS, 'suite evidence');
  exactSet(receipt.controlProofs?.map((entry) => entry.id) ?? [], BOUNTY_QUALIFICATION_CONTROL_IDS, 'control proofs');
  exactSet(Object.keys(receipt.metrics ?? {}), BOUNTY_QUALIFICATION_METRIC_KEYS, 'metrics');
  exactSet(Object.keys(receipt.bindings ?? {}), BOUNTY_RECEIPT_BINDING_KEYS, 'bindings');
  if (currentBindings) exactSet(Object.keys(currentBindings), BOUNTY_RECEIPT_BINDING_KEYS, 'current checkout bindings');

  if (!SOURCE_SHA.test(receipt.bindings.sourceSha)) throw new ValidationError('Bounty qualification source SHA is invalid');
  for (const key of BOUNTY_RECEIPT_BINDING_KEYS) {
    if (key !== 'sourceSha') assertHash(receipt.bindings[key], `binding ${key}`);
    const current = currentBindings?.[key];
    if (current !== undefined && current !== receipt.bindings[key]) {
      throw new ValidationError(`Bounty qualification is stale: ${key} changed`);
    }
  }
  for (const suite of receipt.suiteEvidence) {
    if (!suite.name || suite.result !== 'passed') throw new ValidationError(`Bounty qualification suite ${suite.kind} did not pass`);
    assertHash(suite.evidenceSha256, `suite ${suite.kind} evidence`);
  }
  for (const proof of receipt.controlProofs) {
    if (!proof.namedTest.endsWith('.contract') || proof.result !== 'passed') {
      throw new ValidationError(`Bounty qualification control ${proof.id} is not proven by a named contract test`);
    }
    assertHash(proof.evidenceSha256, `control ${proof.id} evidence`);
  }
  const boundedRates = [receipt.metrics.falsePositiveRate, receipt.metrics.rejectionRate];
  const nonNegative = [
    receipt.metrics.oracleFailures, receipt.metrics.costMicrousd, receipt.metrics.inputTokens,
    receipt.metrics.outputTokens, receipt.metrics.cacheSpendMicrousd, receipt.metrics.authSpendMicrousd,
  ];
  if (boundedRates.some((value) => typeof value !== 'number' || value < 0 || value > 1)
      || nonNegative.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      || !receipt.metrics.classSuccess || typeof receipt.metrics.classSuccess !== 'object'
      || !receipt.metrics.activity || typeof receipt.metrics.activity !== 'object') {
    throw new ValidationError('Bounty qualification metrics are invalid');
  }
  exactSet(receipt.corpora?.map((corpus) => corpus.class) ?? [], ['private', 'anti-cheat'], 'corpora');
  for (const corpus of receipt.corpora) {
    if (!corpus.id || !Number.isSafeInteger(corpus.itemCount) || corpus.itemCount < 1 || !corpus.blinded
        || !corpus.immutable || corpus.repositoryContentIncluded !== false) {
      throw new ValidationError(`Bounty qualification corpus ${corpus.id || 'unknown'} is not frozen and blinded`);
    }
    assertHash(corpus.manifestSha256, `corpus ${corpus.id} manifest`);
  }

  const evidenceRoot = sha256(canonical({
    suites: receipt.suiteEvidence,
    controlProofs: receipt.controlProofs,
    metrics: receipt.metrics,
  }));
  if (evidenceRoot !== receipt.bindings.evidenceRoot) throw new ValidationError('Bounty qualification evidence root mismatch');
  const fingerprint = sha256(canonical({
    triggers: receipt.requalificationTriggers,
    bindings: receipt.bindings,
    corpora: receipt.corpora.map(({ id, manifestSha256 }) => ({ id, manifestSha256 })),
  }));
  if (fingerprint !== receipt.requalificationFingerprint) throw new ValidationError('Bounty qualification fingerprint mismatch');
  assertHash(receipt.traceabilityHash, 'traceability');
  const { receiptHash, ...unsigned } = receipt;
  if (sha256(canonical(unsigned)) !== receiptHash) throw new ValidationError('Bounty qualification receipt hash mismatch');
  return Object.freeze(receipt);
}
