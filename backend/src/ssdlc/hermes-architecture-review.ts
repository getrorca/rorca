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

export const THREAT_MODEL_SURFACES = ['auth', 'secrets', 'network-egress', 'execution-boundary'] as const;
export type ThreatModelSurface = (typeof THREAT_MODEL_SURFACES)[number];
export type ArchitectureChangeSurface = ThreatModelSurface | 'data' | 'interface' | 'storage' | 'other';

const nonEmpty = z.string().trim().min(1);
const findingStatus = z.enum(['pass', 'fail', 'blocker']);

const decisionSchema = z.object({
  decisionId: nonEmpty,
  stakeholder: nonEmpty,
  concern: nonEmpty,
  decision: nonEmpty,
  rationale: nonEmpty,
  status: findingStatus,
  evidenceRefs: z.array(nonEmpty).min(1),
}).strict();

const threatFindingSchema = z.object({
  findingId: nonEmpty,
  threat: nonEmpty,
  affectedBoundary: nonEmpty,
  mitigation: nonEmpty,
  residualRisk: nonEmpty,
  status: findingStatus,
  evidenceRefs: z.array(nonEmpty).min(1),
}).strict();

export type ArchitectureDecisionFinding = z.infer<typeof decisionSchema>;
export type ThreatModelFinding = z.infer<typeof threatFindingSchema>;

export interface ArchitectureGap {
  gapId: string;
  category: 'architecture-decision' | 'threat-model';
  status: 'fail' | 'blocker';
  controlId: 'CTRL-DESIGN-DECISIONS-QUALITY' | 'CTRL-DESIGN-THREAT-BOUNDARIES';
  message: string;
  decisionRationale: string;
  evidenceRefs: readonly string[];
}

export interface HermesArchitectureReviewInput {
  scope: EvidenceScope;
  specHash: string;
  changeSurfaces: readonly ArchitectureChangeSurface[];
  decisions: readonly unknown[];
  rawReference: string;
  actor: string;
}

export interface ThreatModelPassInput {
  scope: EvidenceScope;
  specHash: string;
  changeSurfaces: readonly ThreatModelSurface[];
  decisions: readonly ArchitectureDecisionFinding[];
}

export interface HermesArchitectureReviewResult {
  evidence: CanonicalLifecycleEvidence;
  gaps: readonly ArchitectureGap[];
  threatFindings: readonly ThreatModelFinding[];
  threatModel: {
    applicable: boolean;
    executed: boolean;
    surfaces: readonly ThreatModelSurface[];
  };
}

export interface HermesArchitectureReviewDependencies {
  runThreatModel(input: ThreatModelPassInput): Promise<readonly unknown[]>;
  emitArchitectureEvidence(evidence: CanonicalLifecycleEvidence): Promise<void>;
}

function requiredText(value: string, field: string): string {
  const parsed = nonEmpty.safeParse(value);
  if (!parsed.success) throw new TypeError(`${field} must be a non-empty string`);
  return parsed.data;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function eventId(
  input: HermesArchitectureReviewInput,
  decisions: readonly ArchitectureDecisionFinding[],
  threatFindings: readonly ThreatModelFinding[],
  gaps: readonly ArchitectureGap[],
): string {
  const digest = createHash('sha256').update(JSON.stringify({
    specHash: input.specHash,
    surfaces: [...input.changeSurfaces].sort(),
    decisions,
    threatFindings,
    gaps,
  })).digest('hex');
  return `hermes-architecture-review:${digest}`;
}

/** True only for explicit sensitive change-surface declarations; free text cannot suppress this pass. */
export function threatModelApplies(changeSurfaces: readonly ArchitectureChangeSurface[]): boolean {
  const sensitive = new Set<string>(THREAT_MODEL_SURFACES);
  return changeSurfaces.some((surface) => sensitive.has(surface));
}

/**
 * Execute Hermes' 42010-style architecture review. Sensitive surfaces always invoke the
 * supplied threat pass; malformed or empty threat output fails closed rather than disappearing.
 */
export function createHermesArchitectureReviewer(
  dependencies: HermesArchitectureReviewDependencies,
  options: { now?: () => Date } = {},
): { review(input: HermesArchitectureReviewInput): Promise<HermesArchitectureReviewResult> } {
  const now = options.now ?? (() => new Date());
  return {
    async review(input) {
      if (input.scope.phaseId !== 'design') throw new TypeError('design review evidence requires scope.phaseId design');
      if (!/^sha256:[0-9a-f]{64}$/.test(input.specHash)) throw new TypeError('specHash must be an exact lowercase sha256 digest');
      const rawReference = requiredText(input.rawReference, 'rawReference');
      const actor = requiredText(input.actor, 'actor');
      const surfaces = unique(input.changeSurfaces);
      const unknownSurface = surfaces.find((surface) => ![
        ...THREAT_MODEL_SURFACES, 'data', 'interface', 'storage', 'other',
      ].includes(surface));
      if (unknownSurface) throw new TypeError(`unknown architecture change surface ${unknownSurface}`);
      const decisions = z.array(decisionSchema).min(1).parse(input.decisions);
      const applicableSurfaces = surfaces.filter((surface): surface is ThreatModelSurface =>
        (THREAT_MODEL_SURFACES as readonly string[]).includes(surface));

      let threatFindings: ThreatModelFinding[] = [];
      const gaps: ArchitectureGap[] = decisions
        .filter((decision): decision is ArchitectureDecisionFinding & { status: 'fail' | 'blocker' } => decision.status !== 'pass')
        .map((decision) => ({
          gapId: `architecture:${decision.decisionId}`,
          category: 'architecture-decision',
          status: decision.status,
          controlId: 'CTRL-DESIGN-DECISIONS-QUALITY',
          message: `${decision.stakeholder}: ${decision.concern}`,
          decisionRationale: decision.rationale,
          evidenceRefs: Object.freeze([...decision.evidenceRefs]),
        }));

      if (applicableSurfaces.length > 0) {
        try {
          const rawFindings = await dependencies.runThreatModel({
            scope: structuredClone(input.scope),
            specHash: input.specHash,
            changeSurfaces: Object.freeze(applicableSurfaces),
            decisions: Object.freeze(decisions),
          });
          const parsedFindings = z.array(threatFindingSchema).safeParse(rawFindings);
          if (!parsedFindings.success) {
            gaps.push({
              gapId: 'threat-model:invalid-findings',
              category: 'threat-model',
              status: 'blocker',
              controlId: 'CTRL-DESIGN-THREAT-BOUNDARIES',
              message: `Threat-model pass returned invalid structured findings for: ${applicableSurfaces.join(', ')}`,
              decisionRationale: 'Malformed threat output cannot establish a reviewed security disposition for a sensitive boundary.',
              evidenceRefs: Object.freeze([rawReference]),
            });
          } else {
            threatFindings = parsedFindings.data;
            if (threatFindings.length === 0) {
              gaps.push({
                gapId: 'threat-model:missing-findings',
                category: 'threat-model',
                status: 'blocker',
                controlId: 'CTRL-DESIGN-THREAT-BOUNDARIES',
                message: `Threat-model pass returned no structured findings for: ${applicableSurfaces.join(', ')}`,
                decisionRationale: 'Sensitive boundaries require an explicit threat disposition, including a pass finding when no exploitable threat is identified.',
                evidenceRefs: Object.freeze([rawReference]),
              });
            }
          }
        } catch {
          gaps.push({
            gapId: 'threat-model:pass-failed',
            category: 'threat-model',
            status: 'blocker',
            controlId: 'CTRL-DESIGN-THREAT-BOUNDARIES',
            message: `Threat-model pass failed for: ${applicableSurfaces.join(', ')}`,
            decisionRationale: 'Threat-pass failure leaves sensitive boundaries unreviewed and must block architecture approval.',
            evidenceRefs: Object.freeze([rawReference]),
          });
        }
        for (const finding of threatFindings.filter(
          (item): item is ThreatModelFinding & { status: 'fail' | 'blocker' } => item.status !== 'pass',
        )) {
          gaps.push({
            gapId: `threat-model:${finding.findingId}`,
            category: 'threat-model',
            status: finding.status,
            controlId: 'CTRL-DESIGN-THREAT-BOUNDARIES',
            message: `${finding.threat}; boundary: ${finding.affectedBoundary}; mitigation: ${finding.mitigation}`,
            decisionRationale: `Residual risk: ${finding.residualRisk}`,
            evidenceRefs: Object.freeze([...finding.evidenceRefs]),
          });
        }
      }

      const observedAt = now();
      const reviewEventId = eventId(input, decisions, threatFindings, gaps);
      const evidence = createCanonicalEvidence({
        sourceType: 'documentation_review',
        sourceSystem: 'hermes:architecture-review',
        sourceEventId: reviewEventId,
        observedAt,
        scope: input.scope,
        subject: { type: 'spec_hash', value: input.specHash },
        classification: 'documentation',
        status: gaps.length === 0 ? 'passed' : 'story_caused_failure',
        trustLevel: 'authenticated_manual',
        confidence: 1,
        excerpt: `Reviewed ${decisions.length} architecture decision(s); ${gaps.length} structured gap(s).`,
        rawReference,
        actor,
        rationale: decisions.map((decision) => `${decision.decisionId}: ${decision.rationale}`).join('\n'),
        provenanceChain: [{
          system: 'hermes:architecture-review', eventId: reviewEventId,
          observedAt: observedAt.toISOString(), verification: 'structured-architecture-and-threat-review',
        }],
        details: {
          phase: 'design',
          decisions,
          changeSurfaces: surfaces,
          threatModel: { applicable: applicableSurfaces.length > 0, executed: applicableSurfaces.length > 0, surfaces: applicableSurfaces },
          threatFindings,
          structuredGaps: gaps,
        },
      });

      // Emit only after both review passes have been reduced to one canonical artifact so
      // consumers cannot observe architecture evidence without its mandatory threat gaps.
      await dependencies.emitArchitectureEvidence(evidence);

      return Object.freeze({
        evidence,
        gaps: Object.freeze(gaps.map((gap) => Object.freeze(gap))),
        threatFindings: Object.freeze(threatFindings.map((finding) => Object.freeze(finding))),
        threatModel: Object.freeze({
          applicable: applicableSurfaces.length > 0,
          executed: applicableSurfaces.length > 0,
          surfaces: Object.freeze(applicableSurfaces),
        }),
      });
    },
  };
}
