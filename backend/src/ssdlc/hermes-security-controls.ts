/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash } from 'node:crypto';
import { createAssuranceKernel, type KernelVerificationOutcome } from '../lib/assurance-kernel';
import { GIT_SHA_PATTERN } from '../lib/git-sha';
import type { RevisionRefV1 } from '../lib/mission-contracts';
import {
  createCanonicalEvidence,
  type CanonicalLifecycleEvidence,
  type EvidenceReleaseIdentity,
  type EvidenceScope,
} from '../lib/ssdlc-evidence';
import { executeBounded, type BoundedCommandCapture, type ExecutableMechanism } from './evidence-artifact-adapters';

export const HERMES_SECURITY_CONTROLS = Object.freeze({
  secrets: Object.freeze({ controlId: 'CTRL-TESTING-THREAT-AUTHZ-SECRETS', label: 'secrets scan' }),
  dependencies: Object.freeze({ controlId: 'CTRL-TESTING-SUPPLY-CHAIN', label: 'dependency check' }),
  threats: Object.freeze({ controlId: 'CTRL-TESTING-THREAT-AUTHZ-SECRETS', label: 'threat verification' }),
} as const);

export type HermesSecurityControlKind = keyof typeof HERMES_SECURITY_CONTROLS;

export interface HermesSecurityControlMechanism extends ExecutableMechanism {
  /** Stable caller-owned name; executable and arguments are also included in the bound identity digest. */
  mechanismId: string;
}

export interface HermesSecurityControlsInput {
  scope: EvidenceScope;
  specRevision: RevisionRefV1;
  commitSha: string;
  releaseIdentity?: Omit<EvidenceReleaseIdentity, 'commitSha'>;
  actor: string;
  mechanisms: Record<HermesSecurityControlKind, HermesSecurityControlMechanism>;
}

export interface SecurityControlGap {
  controlId: string;
  mechanismIdentity: string;
  status: 'failed' | 'blocked';
  action: string;
}

export interface HermesSecurityControlsResult {
  decision: 'passed' | 'failed' | 'blocked';
  evidence: readonly CanonicalLifecycleEvidence[];
  gaps: readonly SecurityControlGap[];
}

interface SecurityArtifactOutcome {
  exitCode: number;
  outputDigest: `sha256:${string}`;
  capturedBytes: number;
  outputTruncated: boolean;
  summary: string;
}

export interface HermesSecurityControlDependencies {
  executeCommand(mechanism: ExecutableMechanism): Promise<BoundedCommandCapture>;
  resolveCommitSha(cwd: string): Promise<string>;
  /** Persist or publish the complete security-phase batch before execution is reported complete. */
  emitSecurityEvidence(evidence: readonly CanonicalLifecycleEvidence[]): Promise<void>;
}

type HermesSecurityControlOverrides = Pick<HermesSecurityControlDependencies, 'emitSecurityEvidence'>
  & Partial<Omit<HermesSecurityControlDependencies, 'emitSecurityEvidence'>>;

const requiredText = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
};

function snapshotMechanism(
  kind: HermesSecurityControlKind,
  mechanism: HermesSecurityControlMechanism,
): Readonly<HermesSecurityControlMechanism> {
  const mechanismId = requiredText(mechanism.mechanismId, `mechanisms.${kind}.mechanismId`);
  const executable = requiredText(mechanism.executable, `mechanisms.${kind}.executable`);
  const cwd = requiredText(mechanism.cwd, `mechanisms.${kind}.cwd`);
  if (!Array.isArray(mechanism.args) || mechanism.args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError(`mechanisms.${kind}.args must be a string array`);
  }
  return Object.freeze({ mechanismId, executable, cwd, args: Object.freeze([...mechanism.args]) });
}

function mechanismIdentity(kind: HermesSecurityControlKind, mechanism: HermesSecurityControlMechanism): string {
  const digest = createHash('sha256').update(JSON.stringify({
    kind,
    id: mechanism.mechanismId,
    executable: mechanism.executable,
    args: mechanism.args,
    cwd: mechanism.cwd,
  })).digest('hex');
  return `hermes-security:${kind}:sha256:${digest}`;
}

function artifactOutcome(kind: HermesSecurityControlKind, capture: BoundedCommandCapture): SecurityArtifactOutcome {
  const outputDigest = capture.outputDigest;
  return Object.freeze({
    exitCode: capture.exitCode,
    outputDigest,
    capturedBytes: capture.truncation.reduce((sum, item) => sum + item.capturedBytes, 0),
    outputTruncated: capture.truncation.some((item) => item.truncated),
    summary: `${HERMES_SECURITY_CONTROLS[kind].label} exited ${capture.exitCode}; artifact output ${outputDigest}`,
  });
}

async function defaultResolveCommitSha(cwd: string): Promise<string> {
  const capture = await executeBounded({ executable: 'git', args: ['rev-parse', 'HEAD'], cwd }, 256);
  const commitSha = capture.stdout.trim();
  if (capture.exitCode !== 0 || !GIT_SHA_PATTERN.test(commitSha)) throw new TypeError('git rev-parse HEAD did not return an exact commit SHA');
  return commitSha;
}

function eventId(input: {
  controlId: string;
  mechanismIdentity: string;
  outcomeDigest: string;
  scope: EvidenceScope;
  specRevision: RevisionRefV1;
  commitSha: string;
  releaseIdentity?: Omit<EvidenceReleaseIdentity, 'commitSha'>;
}): string {
  // Source identity includes the exact evidence subject and release, not only scanner output.
  // Identical clean output on two commits must never alias the same persistence idempotency key.
  return `hermes-security:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

function actionableGap(
  kind: HermesSecurityControlKind,
  mechanism: HermesSecurityControlMechanism,
  outcome: KernelVerificationOutcome<SecurityArtifactOutcome>,
): string {
  if (outcome.verdict !== 'blocked') return outcome.gap;
  return `Restore the ${HERMES_SECURITY_CONTROLS[kind].label} mechanism ${mechanism.mechanismId} and rerun it against the exact commit. ${outcome.gap}`;
}

/**
 * Execute the mandatory security controls through the shared execute -> judge -> bind kernel,
 * map real bounded command artifacts to canonical security-phase evidence, then decide fail closed.
 */
export function createHermesSecurityControls(
  overrides: HermesSecurityControlOverrides,
  options: { now?: () => Date } = {},
): { execute(input: HermesSecurityControlsInput): Promise<HermesSecurityControlsResult> } {
  if (typeof overrides?.emitSecurityEvidence !== 'function') {
    throw new TypeError('emitSecurityEvidence must be a function');
  }
  const dependencies: HermesSecurityControlDependencies = {
    executeCommand: overrides.executeCommand ?? executeBounded,
    resolveCommitSha: overrides.resolveCommitSha ?? defaultResolveCommitSha,
    emitSecurityEvidence: overrides.emitSecurityEvidence,
  };
  const kernel = createAssuranceKernel({ now: options.now });

  return {
    async execute(input) {
      if (input.scope.phaseId !== 'testing') throw new TypeError('security control evidence requires scope.phaseId testing');
      if (!GIT_SHA_PATTERN.test(input.commitSha)) throw new TypeError('commitSha must be exactly 40 lowercase hexadecimal characters');
      requiredText(input.specRevision?.kind, 'specRevision.kind');
      requiredText(input.specRevision?.value, 'specRevision.value');
      const actor = requiredText(input.actor, 'actor');
      // Snapshot every binding-critical caller value before the first asynchronous execution.
      const scope = Object.freeze(structuredClone(input.scope));
      const specRevision = Object.freeze({ ...input.specRevision });
      const commitSha = input.commitSha;
      const releaseIdentity = input.releaseIdentity ? Object.freeze({ ...input.releaseIdentity }) : undefined;
      for (const kind of ['secrets', 'dependencies', 'threats'] as const) {
        if (!input.mechanisms[kind]) throw new TypeError(`mechanisms.${kind} is required`);
      }
      const mechanisms = Object.freeze({
        secrets: snapshotMechanism('secrets', input.mechanisms.secrets),
        dependencies: snapshotMechanism('dependencies', input.mechanisms.dependencies),
        threats: snapshotMechanism('threats', input.mechanisms.threats),
      });

      const outcomes: Array<{
        kind: HermesSecurityControlKind;
        identity: string;
        mechanism: Readonly<HermesSecurityControlMechanism>;
        outcome: KernelVerificationOutcome<SecurityArtifactOutcome>;
      }> = [];
      for (const kind of ['secrets', 'dependencies', 'threats'] as const) {
        const mechanism = mechanisms[kind];
        const identity = mechanismIdentity(kind, mechanism);
        const control = HERMES_SECURITY_CONTROLS[kind];
        const outcome = await kernel.verify({
          controlId: control.controlId,
          specId: scope.specSlug,
          specRevision,
          commitSha,
          mechanism: {
            identity,
            execute: async () => {
              const commitBeforeExecution = await dependencies.resolveCommitSha(mechanism.cwd);
              const capture = await dependencies.executeCommand(mechanism);
              const commitAfterExecution = await dependencies.resolveCommitSha(mechanism.cwd);
              // A passing scanner artifact is only authoritative when the checkout stayed on the
              // contracted revision for the complete execution window. Prefer the first mismatch
              // so the shared kernel blocks evidence when either observation is stale.
              const observedCommit = commitBeforeExecution === commitSha
                ? commitAfterExecution
                : commitBeforeExecution;
              return {
                subject: { specId: scope.specSlug, specRevision, commitSha: observedCommit },
                outcome: artifactOutcome(kind, capture),
              };
            },
          },
          criteria: {
            judge: (result) => result.exitCode === 0
              ? { verdict: 'pass', gap: 'Use this security artifact in stage evaluation.' }
              : { verdict: 'fail', gap: `Remediate the ${control.label} findings and rerun ${mechanism.mechanismId} against commit ${commitSha}.` },
          },
        }, actor);
        outcomes.push({ kind, identity, mechanism, outcome });
      }

      const evidence = outcomes.map(({ kind, identity, mechanism, outcome }) => createCanonicalEvidence({
        sourceType: 'wal_validation',
        sourceSystem: 'hermes:security-controls',
        sourceEventId: eventId({
          controlId: outcome.controlId,
          mechanismIdentity: identity,
          outcomeDigest: outcome.outcomeDigest,
          scope,
          specRevision,
          commitSha,
          releaseIdentity,
        }),
        observedAt: outcome.verifiedAt,
        scope,
        subject: { type: 'commit_sha', value: commitSha },
        releaseIdentity: { ...releaseIdentity, commitSha },
        classification: 'testing',
        status: outcome.verdict === 'pass' ? 'passed'
          : outcome.verdict === 'fail' ? 'story_caused_failure' : 'environment_credential_blocker',
        trustLevel: 'host_observed',
        confidence: 1,
        excerpt: outcome.mechanismOutcome?.summary ?? outcome.gap,
        rawReference: outcome.mechanismOutcome ? `security-artifact:${outcome.mechanismOutcome.outputDigest}` : null,
        provenanceChain: [{
          system: 'hermes:security-controls', eventId: outcome.outcomeDigest,
          observedAt: outcome.verifiedAt, verification: 'direct-executable-args-capture',
        }],
        details: {
          phase: 'testing',
          securityControl: kind,
          controlId: outcome.controlId,
          mechanismIdentity: identity,
          mechanismId: mechanism.mechanismId,
          commitSha: outcome.commitSha,
          outcomeDigest: outcome.outcomeDigest,
          verdict: outcome.verdict,
          actionableGap: actionableGap(kind, mechanism, outcome),
          ...(outcome.mechanismOutcome ? {
            exitCode: outcome.mechanismOutcome.exitCode,
            artifactOutputDigest: outcome.mechanismOutcome.outputDigest,
            capturedBytes: outcome.mechanismOutcome.capturedBytes,
            outputTruncated: outcome.mechanismOutcome.outputTruncated,
          } : {}),
        },
      }));

      const gaps = outcomes.flatMap(({ kind, identity, mechanism, outcome }) => outcome.verdict === 'pass' ? [] : [Object.freeze({
        controlId: outcome.controlId,
        mechanismIdentity: identity,
        status: outcome.verdict === 'blocked' ? 'blocked' as const : 'failed' as const,
        action: actionableGap(kind, mechanism, outcome),
      })]);
      const decision = outcomes.some(({ outcome }) => outcome.verdict === 'blocked') ? 'blocked' as const
        : outcomes.some(({ outcome }) => outcome.verdict === 'fail') ? 'failed' as const : 'passed' as const;
      const evidenceBatch = Object.freeze(evidence);
      // Emission is part of control execution, not a best-effort side effect. Reject when the
      // persistence/publication boundary is unavailable so a caller cannot advance without evidence.
      await dependencies.emitSecurityEvidence(evidenceBatch);
      return Object.freeze({ decision, evidence: evidenceBatch, gaps: Object.freeze(gaps) });
    },
  };
}
