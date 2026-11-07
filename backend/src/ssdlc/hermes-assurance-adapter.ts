/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash } from 'node:crypto';
import {
  createAssuranceKernel,
  type KernelJudgment,
  type KernelVerificationOutcome,
} from '../lib/assurance-kernel';
import { requireHermesAction, type HermesAuthorityDeclaration } from '../lib/hermes-authority';
import {
  createCanonicalEvidence,
  type CanonicalLifecycleEvidence,
  type EvidenceReleaseIdentity,
  type EvidenceScope,
} from '../lib/ssdlc-evidence';
import {
  AssuranceProfileV1Schema,
  type AssuranceProfile,
  type ControlInstance,
  type DeepReadonly,
} from './assurance-profile';
import type { GateCompilation } from './gates/gate-compiler';
import type { ControlRecord } from './schema/control-schema';
import {
  StructuredFindingSchema,
  StructuredFindingStore,
  type FindingsIngestionResult,
} from './skills/findings';

export const HERMES_PHASE_REVIEW_STORIES = [
  'AAV-012', 'AAV-013', 'AAV-014', 'AAV-015', 'AAV-016', 'AAV-017', 'AAV-018',
] as const;

export interface BoundedMechanismResult {
  summary: string;
  rawReference?: string | null;
  exitCode?: number;
  artifactMatch?: string;
  findingCount?: number;
  humanDecision?: string;
}

export interface HermesAssuranceIdentity {
  specHash: string;
  commitSha: string;
  releaseIdentity: Omit<EvidenceReleaseIdentity, 'commitSha'>;
}

export interface ExecuteHermesAssuranceInput {
  profile: unknown;
  identity: HermesAssuranceIdentity;
  scope: EvidenceScope;
  actor: string;
  auditAuthority: HermesAuthorityDeclaration;
  persistenceAuthority: HermesAuthorityDeclaration;
  reevaluationAuthority: HermesAuthorityDeclaration;
}

export interface HermesAssuranceDependencies {
  runMechanism(
    binding: DeepReadonly<ControlInstance['mechanismBindings'][number]>,
    context: { controlId: string; specId: string; specRevision: AssuranceProfile['specRevision']; commitSha: string },
  ): Promise<BoundedMechanismResult>;
  persistEvidence(evidence: CanonicalLifecycleEvidence, authority: HermesAuthorityDeclaration): Promise<void>;
  requestStageReevaluation(
    input: { scope: EvidenceScope; evidence: readonly CanonicalLifecycleEvidence[]; blockedControlIds: readonly string[] },
    authority: HermesAuthorityDeclaration,
  ): Promise<void>;
}

export interface HermesAssuranceExecutionResult {
  evidence: readonly CanonicalLifecycleEvidence[];
  blockedControlIds: readonly string[];
}

const MAX_SUMMARY_LENGTH = 8_192;
const MAX_REFERENCE_LENGTH = 4_096;

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value.trim().slice(0, maximum);
}

function normalizeResult(value: BoundedMechanismResult): BoundedMechanismResult {
  if (!value || typeof value !== 'object') throw new TypeError('mechanism result must be an object');
  const result: BoundedMechanismResult = { summary: boundedText(value.summary, 'result.summary', MAX_SUMMARY_LENGTH) };
  if (value.rawReference != null) result.rawReference = boundedText(value.rawReference, 'result.rawReference', MAX_REFERENCE_LENGTH);
  if (value.exitCode !== undefined) {
    if (!Number.isSafeInteger(value.exitCode)) throw new TypeError('result.exitCode must be a safe integer');
    result.exitCode = value.exitCode;
  }
  if (value.findingCount !== undefined) {
    if (!Number.isSafeInteger(value.findingCount) || value.findingCount < 0) throw new TypeError('result.findingCount must be a non-negative safe integer');
    result.findingCount = value.findingCount;
  }
  if (value.artifactMatch !== undefined) result.artifactMatch = boundedText(value.artifactMatch, 'result.artifactMatch', 1_024);
  if (value.humanDecision !== undefined) result.humanDecision = boundedText(value.humanDecision, 'result.humanDecision', 1_024);
  return Object.freeze(result);
}

function criterionActual(
  result: BoundedMechanismResult,
  criterion: DeepReadonly<ControlInstance['criteria'][number]>,
): string {
  switch (criterion.evaluator) {
    case 'exit-code':
      if (result.exitCode === undefined) throw new TypeError(`${criterion.criterionId} requires result.exitCode`);
      return String(result.exitCode);
    case 'artifact-match':
      if (result.artifactMatch === undefined) throw new TypeError(`${criterion.criterionId} requires result.artifactMatch`);
      return result.artifactMatch;
    case 'finding-count':
      if (result.findingCount === undefined) throw new TypeError(`${criterion.criterionId} requires result.findingCount`);
      return String(result.findingCount);
    case 'human-decision':
      if (result.humanDecision === undefined) throw new TypeError(`${criterion.criterionId} requires result.humanDecision`);
      return result.humanDecision;
  }
}

function judgeCriteria(
  result: BoundedMechanismResult,
  criteria: DeepReadonly<ControlInstance['criteria']>,
): KernelJudgment {
  const failures = criteria.flatMap((criterion) => {
    const actual = criterionActual(result, criterion);
    return actual === criterion.expected
      ? []
      : [`${criterion.criterionId} expected ${JSON.stringify(criterion.expected)}, observed ${JSON.stringify(actual)}`];
  });
  return failures.length === 0
    ? { verdict: 'pass', gap: 'Use this canonical evidence in the next US-005 stage evaluation.' }
    : { verdict: 'fail', gap: `Correct the mechanism result and rerun: ${failures.join('; ')}` };
}

function exactRevision(profile: DeepReadonly<AssuranceProfile>): string {
  return `${profile.specRevision.kind}:${profile.specRevision.value}`;
}

function evidenceEventId(input: {
  profile: DeepReadonly<AssuranceProfile>;
  controlId: string;
  binding: DeepReadonly<ControlInstance['mechanismBindings'][number]>;
  outcomeDigest: string;
  identity: HermesAssuranceIdentity;
}): string {
  // The source event is immutable evidence identity, not merely an execution-result identity.
  // Include every subject/release and compiled-binding field so the same mechanism result on a
  // new commit or release cannot replay (or conflict with) evidence for an older exact subject.
  const identityDigest = createHash('sha256')
    .update(JSON.stringify({
      profileId: input.profile.profileId,
      compilationReceiptHash: input.profile.compilationReceiptHash,
      specRevision: {
        kind: input.profile.specRevision.kind,
        value: input.profile.specRevision.value,
      },
      controlId: input.controlId,
      binding: {
        mechanismId: input.binding.mechanismId,
        kind: input.binding.kind,
        locator: input.binding.locator,
      },
      specHash: input.identity.specHash,
      commitSha: input.identity.commitSha,
      releaseIdentity: {
        artifactDigest: input.identity.releaseIdentity.artifactDigest ?? null,
        deploymentId: input.identity.releaseIdentity.deploymentId ?? null,
      },
      outcomeDigest: input.outcomeDigest,
    }))
    .digest('hex');
  return `hermes-assurance:${identityDigest}`;
}

/**
 * Hermes execution boundary: execute each compiled binding, normalize the kernel result exactly
 * once into rorca.lifecycle-evidence.v1, persist it, then notify US-005 of the new evidence.
 */
export function createHermesAssuranceAdapter(
  dependencies: HermesAssuranceDependencies,
  options: { now?: () => Date; findingStore?: StructuredFindingStore } = {},
): {
  execute(input: ExecuteHermesAssuranceInput): Promise<HermesAssuranceExecutionResult>;
  ingestPhaseReview(input: {
    agentStoryId: string;
    findings: readonly unknown[];
    controls: readonly ControlRecord[];
    activeControlIds: readonly string[];
    compilation: Pick<GateCompilation, 'readiness'>;
    auditAuthority: HermesAuthorityDeclaration;
  }): FindingsIngestionResult;
} {
  const now = options.now ?? (() => new Date());
  const kernel = createAssuranceKernel({ now });
  const findingStore = options.findingStore ?? new StructuredFindingStore();

  return {
    async execute(input) {
      requireHermesAction(input.auditAuthority, 'subscription', 'service-audit');
      requireHermesAction(input.persistenceAuthority, 'persist', 'operator-dispatch');
      requireHermesAction(input.reevaluationAuthority, 'dispatch', 'operator-dispatch');
      const profile = AssuranceProfileV1Schema.parse(input.profile) as DeepReadonly<AssuranceProfile>;
      if (profile.profileKind !== 'compiled') throw new TypeError('Hermes assurance execution requires a compiled assurance profile');
      if (input.scope.workspaceId !== profile.specRef.workspaceId || input.scope.specSlug !== profile.specRef.id) {
        throw new TypeError('evidence scope must exactly match the compiled profile spec');
      }
      if (!/^sha256:[0-9a-f]{64}$/.test(input.identity.specHash)) {
        throw new TypeError('specHash must be an exact lowercase sha256 digest');
      }

      const outcomes = [] as Array<{
        control: DeepReadonly<ControlInstance>;
        binding: DeepReadonly<ControlInstance['mechanismBindings'][number]>;
        outcome: KernelVerificationOutcome<BoundedMechanismResult>;
      }>;
      for (const control of profile.controlInstances) {
        for (const binding of control.mechanismBindings) {
          const outcome = await kernel.verify({
            controlId: control.controlId,
            specId: profile.specRef.id,
            specRevision: profile.specRevision,
            commitSha: input.identity.commitSha,
            mechanism: {
              identity: binding.mechanismId,
              execute: async () => ({
                subject: {
                  specId: profile.specRef.id,
                  specRevision: profile.specRevision,
                  commitSha: input.identity.commitSha,
                },
                outcome: normalizeResult(await dependencies.runMechanism(binding, {
                  controlId: control.controlId,
                  specId: profile.specRef.id,
                  specRevision: profile.specRevision,
                  commitSha: input.identity.commitSha,
                })),
              }),
            },
            criteria: { judge: (result) => judgeCriteria(result, control.criteria) },
          }, input.actor);
          outcomes.push({ control, binding, outcome });
        }
      }

      const evidence = outcomes.map(({ control, binding, outcome }) => {
        const requirement = control.evidenceRequirements[0];
        return createCanonicalEvidence({
          sourceType: 'wal_validation',
          sourceSystem: 'hermes-assurance',
          sourceEventId: evidenceEventId({
            profile,
            controlId: control.controlId,
            binding,
            outcomeDigest: outcome.outcomeDigest,
            identity: input.identity,
          }),
          observedAt: outcome.verifiedAt,
          scope: input.scope,
          subject: { type: 'spec_hash', value: input.identity.specHash },
          releaseIdentity: { ...input.identity.releaseIdentity, commitSha: input.identity.commitSha },
          classification: 'testing',
          status: outcome.verdict === 'pass' ? 'passed'
            : outcome.verdict === 'fail' ? 'story_caused_failure' : 'environment_credential_blocker',
          trustLevel: 'host_observed',
          confidence: 1,
          excerpt: outcome.mechanismOutcome?.summary ?? outcome.gap,
          rawReference: outcome.mechanismOutcome?.rawReference ?? null,
          details: {
            controlId: control.controlId,
            profileId: profile.profileId,
            compilationReceiptHash: profile.compilationReceiptHash,
            mechanismIdentity: outcome.mechanismIdentity,
            mechanismId: binding.mechanismId,
            mechanismKind: binding.kind,
            mechanismLocator: binding.locator,
            specId: outcome.specId,
            specRevision: exactRevision(profile),
            specRevisionKind: profile.specRevision.kind,
            specRevisionValue: profile.specRevision.value,
            specHash: input.identity.specHash,
            commitSha: outcome.commitSha,
            outcomeDigest: outcome.outcomeDigest,
            verdict: outcome.verdict,
            actionableGap: outcome.gap,
            requirementClassification: requirement?.classification,
            evidenceSourceType: requirement?.allowedSourceTypes[0],
            evidenceDepth: requirement?.evidenceDepth,
          },
        });
      });

      for (const record of evidence) await dependencies.persistEvidence(record, input.persistenceAuthority);
      const blockedControlIds = [...new Set(outcomes
        .filter(({ outcome }) => outcome.verdict === 'blocked')
        .map(({ control }) => control.controlId))];
      await dependencies.requestStageReevaluation(
        { scope: input.scope, evidence, blockedControlIds },
        input.reevaluationAuthority,
      );
      return { evidence: Object.freeze(evidence), blockedControlIds: Object.freeze(blockedControlIds) };
    },

    ingestPhaseReview(input) {
      requireHermesAction(input.auditAuthority, 'subscription', 'service-audit');
      if (!(HERMES_PHASE_REVIEW_STORIES as readonly string[]).includes(input.agentStoryId)) {
        throw new TypeError('only AAV-012 through AAV-018 may ingest Hermes phase-review findings');
      }
      // Validate and attribute the complete batch before touching the canonical store. Phase agents
      // do not get an agent-specific/legacy envelope: this boundary accepts only US-006 records.
      const findings = input.findings.map((finding) => StructuredFindingSchema.parse(finding));
      if (findings.some(({ storyId }) => storyId !== 'US-006')) {
        throw new TypeError('Hermes phase-review findings must be attributed to US-006');
      }
      return findingStore.ingestFindings({ ...input, findings });
    },
  };
}
