/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  createCanonicalEvidence,
  type CanonicalLifecycleEvidence,
  type EvidenceScope,
} from '../lib/ssdlc-evidence';

const nonEmpty = z.string().trim().min(1);
const commitSha = z.string().regex(/^[0-9a-f]{40}$/);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export interface ProductionTargetIdentity {
  environment: 'production';
  provider: string;
  service: string;
  region: string | null;
}

export interface ProductionReleaseIdentity {
  commitSha: string;
  artifactDigest: string;
}

export type DeploymentResolution =
  | { state: 'confirmed'; deploymentId: string; target: ProductionTargetIdentity }
  | { state: 'unknown'; reason: string }
  | { state: 'unavailable'; reason: string };

export interface PostDeployHealthResult {
  status: 'healthy' | 'unhealthy';
  checkedAt: string;
  summary: string;
}

export interface HermesProductionConfirmationInput {
  scope: EvidenceScope;
  release: ProductionReleaseIdentity;
  target: ProductionTargetIdentity;
  actor: string;
  rawReference: string;
}

export interface HermesProductionConfirmationDependencies {
  resolveDeployment(input: {
    scope: EvidenceScope;
    release: Readonly<ProductionReleaseIdentity>;
    target: Readonly<ProductionTargetIdentity>;
  }): Promise<DeploymentResolution>;
  checkDeploymentHealth(input: {
    deploymentId: string;
    target: Readonly<ProductionTargetIdentity>;
  }): Promise<PostDeployHealthResult>;
  emitProductionEvidence(evidence: CanonicalLifecycleEvidence): Promise<void>;
}

interface ConfirmedProductionResult {
  state: 'confirmed' | 'failed_health';
  deploymentId: string;
  target: Readonly<ProductionTargetIdentity>;
  observedTarget: Readonly<ProductionTargetIdentity>;
  healthResult: Readonly<PostDeployHealthResult>;
  evidence: CanonicalLifecycleEvidence;
}

interface IndeterminateProductionResult {
  state: 'unknown' | 'unavailable';
  deploymentId: null;
  target: Readonly<ProductionTargetIdentity>;
  observedTarget: Readonly<ProductionTargetIdentity> | null;
  healthResult: null;
  /** Provider or binding explanation surfaced directly to callers, not only in evidence details. */
  reason: string;
  evidence: CanonicalLifecycleEvidence;
}

export type HermesProductionConfirmationResult = ConfirmedProductionResult | IndeterminateProductionResult;

function requiredText(value: string, field: string): string {
  const result = nonEmpty.safeParse(value);
  if (!result.success) throw new TypeError(`${field} must be a non-empty string`);
  return result.data;
}

function normalizeTarget(value: ProductionTargetIdentity, field: string): Readonly<ProductionTargetIdentity> {
  if (value.environment !== 'production') throw new TypeError(`${field}.environment must be production`);
  return Object.freeze({
    environment: 'production' as const,
    provider: requiredText(value.provider, `${field}.provider`),
    service: requiredText(value.service, `${field}.service`),
    region: value.region === null ? null : requiredText(value.region, `${field}.region`),
  });
}

function sameTarget(left: ProductionTargetIdentity, right: ProductionTargetIdentity): boolean {
  return left.environment === right.environment
    && left.provider === right.provider
    && left.service === right.service
    && left.region === right.region;
}

function normalizeHealth(value: PostDeployHealthResult): Readonly<PostDeployHealthResult> {
  const checkedAt = z.iso.datetime({ offset: true }).parse(value.checkedAt);
  return Object.freeze({
    status: z.enum(['healthy', 'unhealthy']).parse(value.status),
    checkedAt,
    summary: requiredText(value.summary, 'healthResult.summary'),
  });
}

function confirmationEventId(input: {
  scope: EvidenceScope;
  release: ProductionReleaseIdentity;
  target: ProductionTargetIdentity;
  resolution: DeploymentResolution;
  healthResult: PostDeployHealthResult | null;
}): string {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return `hermes-production-confirmation:${digest}`;
}

/**
 * Confirm a provider-observed production deployment and run its post-deploy health check.
 * Missing provider state, an unavailable provider, and target mismatches remain explicit
 * indeterminate evidence and can never be promoted to a successful confirmation.
 */
export function createHermesProductionConfirmer(
  dependencies: HermesProductionConfirmationDependencies,
  options: { now?: () => Date } = {},
): { confirm(input: HermesProductionConfirmationInput): Promise<HermesProductionConfirmationResult> } {
  const now = options.now ?? (() => new Date());
  return {
    async confirm(input) {
      if (input.scope.phaseId !== 'deployment') {
        throw new TypeError('production confirmation evidence requires scope.phaseId production');
      }
      const release = Object.freeze({
        commitSha: commitSha.parse(input.release.commitSha),
        artifactDigest: sha256.parse(input.release.artifactDigest),
      });
      const target = normalizeTarget(input.target, 'target');
      const actor = requiredText(input.actor, 'actor');
      const rawReference = requiredText(input.rawReference, 'rawReference');
      const resolved = await dependencies.resolveDeployment({
        scope: structuredClone(input.scope), release, target,
      });

      let state: HermesProductionConfirmationResult['state'];
      let deploymentId: string | null = null;
      let observedTarget: Readonly<ProductionTargetIdentity> | null = null;
      let healthResult: Readonly<PostDeployHealthResult> | null = null;
      let reason: string;

      if (resolved.state === 'confirmed') {
        deploymentId = requiredText(resolved.deploymentId, 'deployment.deploymentId');
        observedTarget = normalizeTarget(resolved.target, 'deployment.target');
        if (!sameTarget(target, observedTarget)) {
          state = 'unknown';
          deploymentId = null;
          reason = 'Provider returned a deployment for a different production target.';
        } else {
          healthResult = normalizeHealth(await dependencies.checkDeploymentHealth({ deploymentId, target }));
          state = healthResult.status === 'healthy' ? 'confirmed' : 'failed_health';
          reason = healthResult.summary;
        }
      } else {
        state = resolved.state;
        reason = requiredText(resolved.reason, `deployment.${resolved.state}.reason`);
      }

      const observedAt = now();
      const sourceEventId = confirmationEventId({
        scope: input.scope, release, target, resolution: resolved, healthResult,
      });
      const evidence = createCanonicalEvidence({
        sourceType: 'deployment_proof',
        sourceSystem: 'hermes:production-confirmation',
        sourceEventId,
        observedAt,
        scope: input.scope,
        subject: deploymentId
          ? { type: 'deployment_id', value: deploymentId }
          : { type: 'artifact_digest', value: release.artifactDigest },
        phaseSubject: deploymentId
          ? { type: 'deployment_id', value: deploymentId }
          : { type: 'artifact_digest', value: release.artifactDigest },
        releaseIdentity: { ...release, deploymentId },
        classification: 'deployment',
        status: state === 'confirmed' ? 'passed'
          : state === 'failed_health' ? 'story_caused_failure' : 'unknown',
        trustLevel: 'host_observed',
        confidence: state === 'confirmed' || state === 'failed_health' ? 1 : 0,
        excerpt: state === 'confirmed'
          ? `Confirmed production deployment ${deploymentId}; post-deploy health is healthy.`
          : state === 'failed_health'
            ? `Production deployment ${deploymentId} failed its post-deploy health check.`
            : `Production deployment state is ${state}: ${reason}`,
        rawReference,
        provenanceChain: [{
          system: 'hermes:production-confirmation',
          eventId: sourceEventId,
          observedAt: observedAt.toISOString(),
          principal: actor,
          verification: 'deployment-id-target-binding-and-post-deploy-health',
        }],
        details: {
          phase: 'deployment',
          confirmationState: state,
          deployment_id: deploymentId,
          targetIdentity: target,
          observedTargetIdentity: observedTarget,
          healthResult,
          reason,
        },
      });

      await dependencies.emitProductionEvidence(evidence);
      if (state === 'confirmed' || state === 'failed_health') {
        return Object.freeze({ state, deploymentId: deploymentId!, target, observedTarget: observedTarget!, healthResult: healthResult!, evidence });
      }
      return Object.freeze({ state, deploymentId: null, target, observedTarget, healthResult: null, reason, evidence });
    },
  };
}
