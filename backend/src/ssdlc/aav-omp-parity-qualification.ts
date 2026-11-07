/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { AssuranceProfileV1Schema, type AssuranceProfile, type DeepReadonly } from './assurance-profile';
import type { CanonicalLifecycleEvidence } from '../lib/ssdlc-evidence';
import {
  OrchestrationEventV1Schema,
  type OrchestrationEventV1,
} from '../lib/omp-orchestration-events';
import type { GateEvaluationTrace } from './evaluation/gate-evaluator';

export const AAV_OMP_PARITY_QUALIFICATION_VERSION = 'rorca.aav-omp-parity-qualification.v1' as const;
export const AAV_INTEROPERABILITY_QUALIFICATION_BOUNDARY = 'docs/contracts/ssdlc-interoperability.md#component-parity-qualification' as const;

export interface AavOmpParityQualificationInput {
  profile: unknown;
  persistedSpec: { id: string; revision: { kind: string; value: string }; specHash: string };
  commitSha: string;
  orchestrationEvents: readonly unknown[];
  evidence: readonly CanonicalLifecycleEvidence[];
  gate: GateEvaluationTrace;
  terminalMode: 'pipe' | 'pty' | 'native-pty';
}

export interface AavOmpParityQualificationReceipt {
  schemaVersion: typeof AAV_OMP_PARITY_QUALIFICATION_VERSION;
  profileId: string;
  compilationReceiptHash: string;
  specId: string;
  specRevision: string;
  specHash: string;
  commitSha: string;
  stage: GateEvaluationTrace['stage'];
  stageStatus: GateEvaluationTrace['status'];
  orchestration: {
    firstSequence: number;
    lastSequence: number;
    eventCount: number;
    agentCount: number;
    subagentCount: number;
    failedAgentIds: readonly string[];
    retryOrContinuationCount: number;
  };
  evidenceCount: number;
  blockedControlIds: readonly string[];
  terminalMode: AavOmpParityQualificationInput['terminalMode'];
  rawTerminalAvailable: true;
  qualificationBoundary: typeof AAV_INTEROPERABILITY_QUALIFICATION_BOUNDARY;
}

function exactRevision(profile: DeepReadonly<AssuranceProfile>): string {
  return `${profile.specRevision.kind}:${profile.specRevision.value}`;
}

function stringDetail(evidence: CanonicalLifecycleEvidence, key: string): string | null {
  const value = evidence.details[key];
  return typeof value === 'string' ? value : null;
}

function rawString(event: OrchestrationEventV1, ...keys: string[]): string | null {
  const nested = [event.omp.raw, event.omp.raw.event, event.omp.raw.data]
    .filter((value): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value));
  for (const source of nested) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return null;
}

/**
 * Fail-closed AAV-010 component qualification. This consumes provider-owned artifacts; it does
 * not replace the interoperability qualification for the complete HMG-to-learning chain.
 */
export function qualifyAavOmpParity(input: AavOmpParityQualificationInput): Readonly<AavOmpParityQualificationReceipt> {
  const profile = AssuranceProfileV1Schema.parse(input.profile) as DeepReadonly<AssuranceProfile>;
  if (profile.profileKind !== 'compiled' || !profile.compilationReceiptHash) {
    throw new TypeError('AAV-010 requires a compiled assurance profile with a receipt');
  }
  const compilationReceiptHash = profile.compilationReceiptHash;
  const revision = exactRevision(profile);
  if (input.persistedSpec.id !== profile.specRef.id
    || input.persistedSpec.revision.kind !== profile.specRevision.kind
    || input.persistedSpec.revision.value !== profile.specRevision.value) {
    throw new TypeError('persisted spec identity does not exactly match the assurance profile revision');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(input.persistedSpec.specHash)) throw new TypeError('persisted spec hash must be an exact lowercase sha256 digest');
  if (!/^[0-9a-f]{40}$/.test(input.commitSha)) throw new TypeError('commitSha must be an exact lowercase Git SHA');

  const events = input.orchestrationEvents.map((event) => OrchestrationEventV1Schema.parse(event));
  if (events.length === 0) throw new TypeError('OMP qualification requires durable orchestration events');
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  if (ordered.some((event, index) => event.sequence !== index + ordered[0].sequence)) {
    throw new TypeError('OMP orchestration sequence must be monotonic and gap-free');
  }
  if (ordered.some((event) => event.omp.provider !== 'omp'
    || event.spec.id !== profile.specRef.id
    || event.spec.revision?.kind !== profile.specRevision.kind
    || event.spec.revision.value !== profile.specRevision.value
    || event.specRevisionHash !== input.persistedSpec.specHash)) {
    throw new TypeError('OMP orchestration events do not bind the exact persisted spec revision');
  }
  const startedAgentIds = new Set(ordered
    .filter(({ kind }) => kind === 'agent_started')
    .flatMap(({ omp }) => omp.agentId ? [omp.agentId] : []));
  const terminalAgentIds = ordered
    .filter(({ kind }) => kind === 'agent_completed' || kind === 'agent_failed')
    .flatMap(({ omp }) => omp.agentId ? [omp.agentId] : []);
  if (startedAgentIds.size === 0 || terminalAgentIds.length === 0
    || terminalAgentIds.some((agentId) => !startedAgentIds.has(agentId))
    || [...startedAgentIds].some((agentId) => !terminalAgentIds.includes(agentId))) {
    throw new TypeError('OMP orchestration receipt must contain a complete started-to-terminal lifecycle per agent');
  }

  if (input.evidence.length === 0) throw new TypeError('qualification requires canonical validation evidence');
  for (const evidence of input.evidence) {
    if (evidence.schemaVersion !== 'rorca.lifecycle-evidence.v1'
      || stringDetail(evidence, 'profileId') !== profile.profileId
      || stringDetail(evidence, 'compilationReceiptHash') !== profile.compilationReceiptHash
      || stringDetail(evidence, 'specRevision') !== revision
      || stringDetail(evidence, 'specHash') !== input.persistedSpec.specHash
      || stringDetail(evidence, 'commitSha') !== input.commitSha
      || evidence.subject.type !== 'spec_hash'
      || evidence.subject.value !== input.persistedSpec.specHash
      || evidence.releaseIdentity.commitSha !== input.commitSha) {
      throw new TypeError('canonical evidence does not bind the exact profile, spec revision, hash, and commit');
    }
  }

  const failedAgentIds = [...new Set(ordered
    .filter(({ kind }) => kind === 'agent_failed')
    .flatMap(({ omp }) => omp.agentId ? [omp.agentId] : []))];
  const blockedEvidenceControls = [...new Set(input.evidence
    .filter(({ status }) => status !== 'passed')
    .flatMap((evidence) => {
      const controlId = stringDetail(evidence, 'controlId');
      const gap = stringDetail(evidence, 'actionableGap');
      if (!controlId || !gap) throw new TypeError('blocked evidence requires a controlId and actionableGap');
      return [controlId];
    }))];
  const gateBlocked = input.gate.status === 'blocked';
  if (failedAgentIds.length > 0 && (!gateBlocked || blockedEvidenceControls.length === 0)) {
    throw new TypeError('a failed OMP subagent must produce blocked evidence and a blocked US-005 stage');
  }
  if (gateBlocked !== (blockedEvidenceControls.length > 0)
    || [...blockedEvidenceControls].sort().join(',') !== [...input.gate.unresolvedControlIds].sort().join(',')) {
    throw new TypeError('US-005 stage outcome does not agree with acceptable canonical evidence');
  }
  if (!gateBlocked && (input.evidence.some(({ status }) => status !== 'passed')
    || input.gate.controlResults.some((control) => control.status !== 'pass' || control.demonstratedEvidence.length === 0))) {
    throw new TypeError('a stage may pass only with acceptable demonstrated evidence');
  }

  const agentIds = new Set(ordered.flatMap(({ omp }) => omp.agentId ? [omp.agentId] : []));
  const subagentIds = new Set(ordered.flatMap(({ omp }) => omp.agentId && omp.parentAgentId ? [omp.agentId] : []));
  const retryOrContinuationCount = ordered.filter((event) => rawString(
    event, 'retryOfAgentId', 'retry_of_agent_id', 'continuationOfAgentId', 'continuation_of_agent_id',
  ) !== null).length;
  return Object.freeze({
    schemaVersion: AAV_OMP_PARITY_QUALIFICATION_VERSION,
    profileId: profile.profileId,
    compilationReceiptHash,
    specId: profile.specRef.id,
    specRevision: revision,
    specHash: input.persistedSpec.specHash,
    commitSha: input.commitSha,
    stage: input.gate.stage,
    stageStatus: input.gate.status,
    orchestration: Object.freeze({
      firstSequence: ordered[0].sequence,
      lastSequence: ordered.at(-1)!.sequence,
      eventCount: ordered.length,
      agentCount: agentIds.size,
      subagentCount: subagentIds.size,
      failedAgentIds: Object.freeze(failedAgentIds),
      retryOrContinuationCount,
    }),
    evidenceCount: input.evidence.length,
    blockedControlIds: Object.freeze(blockedEvidenceControls),
    terminalMode: input.terminalMode,
    rawTerminalAvailable: true,
    qualificationBoundary: AAV_INTEROPERABILITY_QUALIFICATION_BOUNDARY,
  });
}
