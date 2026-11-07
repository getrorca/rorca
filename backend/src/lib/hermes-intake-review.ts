/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Hermes intake review for persisted briefs (AAV-012).
 *
 * Findings are projected through the canonical AAV-006 lifecycle evidence
 * envelope. Approval is deliberately fail-closed: an automated finding does
 * not approve itself; a reviewer must satisfy it or record a justified waiver.
 */
import { createHash } from 'node:crypto';
import { createCanonicalEvidence, type CanonicalLifecycleEvidence } from './ssdlc-evidence';

export const HERMES_INTAKE_CONCERNS = ['outcome_framing', 'scope_boundaries', 'risk_class'] as const;
export type HermesIntakeConcern = typeof HERMES_INTAKE_CONCERNS[number];
export type HermesIntakeFindingState = 'unreviewed' | 'satisfied' | 'contested' | 'waived';

export interface HermesIntakeFinding {
  findingId: string;
  concern: HermesIntakeConcern;
  controlId: 'CTRL-PLANNING-NEED-SCOPE' | 'CTRL-PLANNING-RISK-CLASSIFICATION';
  skillId: string;
  status: 'pass' | 'blocker';
  evidenceRefs: string[];
  state: HermesIntakeFindingState;
  message: string;
  briefHash: string;
  reviewerId: string | null;
  rationale: string | null;
}

export interface HermesIntakeDecision {
  findingId: string;
  state: Exclude<HermesIntakeFindingState, 'unreviewed'>;
  reviewerId: string;
  rationale?: string;
}

export interface HermesIntakeReviewResult {
  briefHash: string;
  findings: readonly HermesIntakeFinding[];
  evidence: readonly CanonicalLifecycleEvidence[];
  approval: {
    status: 'approved' | 'blocked';
    blockingFindingIds: readonly string[];
    waivedFindingIds: readonly string[];
  };
}

const FINDING_DEFINITIONS: ReadonlyArray<Pick<HermesIntakeFinding, 'concern' | 'controlId' | 'skillId' | 'message'>> = [
  {
    concern: 'outcome_framing',
    controlId: 'CTRL-PLANNING-NEED-SCOPE',
    skillId: 'family:intake/need-validity',
    message: 'Confirm that the brief states the user or mission outcome and how success will be observed.',
  },
  {
    concern: 'scope_boundaries',
    controlId: 'CTRL-PLANNING-NEED-SCOPE',
    skillId: 'family:intake/scope-boundaries',
    message: 'Confirm explicit in-scope and out-of-scope boundaries before forging.',
  },
  {
    concern: 'risk_class',
    controlId: 'CTRL-PLANNING-RISK-CLASSIFICATION',
    skillId: 'family:intake/risk-classification',
    message: 'Confirm the delivery risk class and the reason for that classification.',
  },
];

function bounded(value: string, field: string, maximum = 4_096): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be a non-empty string`);
  return normalized.slice(0, maximum);
}

export function hashHermesBrief(brief: string): string {
  const normalized = brief.trim();
  if (!normalized) throw new TypeError('brief must be a non-empty string');
  // Evidence identity must cover the complete brief. Request boundaries may
  // impose size limits, but silently truncating here lets distinct persisted
  // briefs alias the same lifecycle subject.
  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}

function findingId(briefHash: string, concern: HermesIntakeConcern): string {
  return `hermes-intake:${briefHash.slice('sha256:'.length)}:${concern}`;
}

function evidenceFor(
  finding: HermesIntakeFinding,
  input: { workspaceId: string; specSlug: string; observedAt: string },
): CanonicalLifecycleEvidence {
  const passed = finding.state === 'satisfied';
  const waived = finding.state === 'waived';
  return createCanonicalEvidence({
    sourceType: 'wal_validation',
    sourceSystem: 'hermes:intake-review',
    sourceEventId: `${finding.findingId}:${finding.state}:${createHash('sha256').update(input.observedAt).digest('hex')}`, 
    observedAt: input.observedAt,
    scope: {
      workspaceId: bounded(input.workspaceId, 'workspaceId', 256),
      specSlug: bounded(input.specSlug, 'specSlug', 512),
      runId: null,
      storyId: 'AAV-012',
      phaseId: 'planning',
      gateId: 'intent',
    },
    subject: { type: 'spec_hash', value: finding.briefHash },
    phaseSubject: { type: 'spec_hash', value: finding.briefHash },
    classification: 'risk_judgment',
    status: passed ? 'passed' : waived ? 'skipped_with_rationale' : 'unknown',
    trustLevel: finding.reviewerId ? 'authenticated_manual' : 'agent_proposed',
    confidence: finding.reviewerId ? 1 : 0.8,
    excerpt: finding.message,
    rawReference: `brief:${finding.briefHash}`,
    details: {
      contract: 'rorca.hermes-intake-finding.v1',
      findingId: finding.findingId,
      concern: finding.concern,
      controlId: finding.controlId,
      reviewState: finding.state,
      findingStatus: finding.status,
      skillId: finding.skillId,
      evidenceRefs: finding.evidenceRefs,
      briefHash: finding.briefHash,
      reviewerId: finding.reviewerId,
      rationale: finding.rationale,
    },
  });
}

/** Produce initial findings, or apply exact reviewer decisions to a prior review. */
export function reviewHermesIntake(input: {
  workspaceId: string;
  specSlug: string;
  brief: string;
  decisions?: readonly HermesIntakeDecision[];
  observedAt?: Date | string;
}): HermesIntakeReviewResult {
  const briefHash = hashHermesBrief(input.brief);
  const expectedIds = new Set(FINDING_DEFINITIONS.map(({ concern }) => findingId(briefHash, concern)));
  const decisions = new Map<string, HermesIntakeDecision>();
  for (const decision of input.decisions ?? []) {
    if (!expectedIds.has(decision.findingId)) throw new TypeError(`decision references unknown intake finding ${decision.findingId}`);
    if (decisions.has(decision.findingId)) throw new TypeError(`duplicate intake decision ${decision.findingId}`);
    if (!['satisfied', 'contested', 'waived'].includes(decision.state)) {
      throw new TypeError(`invalid intake finding state ${String(decision.state)}`);
    }
    const reviewerId = bounded(decision.reviewerId, 'decision.reviewerId', 512);
    const normalizedRationale = decision.rationale?.trim() || null;
    const rationale = normalizedRationale ? bounded(normalizedRationale, 'decision.rationale') : null;
    if ((decision.state === 'waived' || decision.state === 'contested') && !rationale) {
      throw new TypeError(`${decision.state} intake finding requires a rationale`);
    }
    decisions.set(decision.findingId, { ...decision, reviewerId, ...(rationale ? { rationale } : {}) });
  }

  const findings = FINDING_DEFINITIONS.map((definition): HermesIntakeFinding => {
    const id = findingId(briefHash, definition.concern);
    const decision = decisions.get(id);
    return Object.freeze({
      findingId: id,
      ...definition,
      status: decision?.state === 'satisfied' || decision?.state === 'waived' ? 'pass' : 'blocker',
      evidenceRefs: [`brief:${briefHash}`],
      state: decision?.state ?? 'unreviewed',
      briefHash,
      reviewerId: decision?.reviewerId ?? null,
      rationale: decision?.rationale?.trim() || null,
    });
  });
  const observedAt = new Date(input.observedAt ?? new Date()).toISOString();
  const evidence = findings.map((finding) => evidenceFor(finding, { ...input, observedAt }));
  const blockingFindingIds = findings
    .filter(({ state }) => state === 'unreviewed' || state === 'contested')
    .map(({ findingId: id }) => id);
  const waivedFindingIds = findings.filter(({ state }) => state === 'waived').map(({ findingId: id }) => id);
  return Object.freeze({
    briefHash,
    findings: Object.freeze(findings),
    evidence: Object.freeze(evidence),
    approval: Object.freeze({
      status: blockingFindingIds.length === 0 ? 'approved' : 'blocked',
      blockingFindingIds: Object.freeze(blockingFindingIds),
      waivedFindingIds: Object.freeze(waivedFindingIds),
    }),
  });
}
