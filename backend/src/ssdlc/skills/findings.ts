/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { z } from 'zod';
import type { GateCompilation, StageReadiness } from '../gates/gate-compiler';
import type { ControlRecord } from '../schema/control-schema';

const nonEmpty = z.string().trim().min(1);

export type FindingStatus = 'pass' | 'fail' | 'blocker';

/** The sole accepted phase-review result contract for AAV-012 through AAV-018. */
export interface StructuredFinding {
  findingId: string;
  controlId: string;
  skillId: string;
  requirementId?: string;
  storyId?: string;
  status: FindingStatus;
  evidenceRefs: string[];
  message: string;
}

export const StructuredFindingSchema: z.ZodType<StructuredFinding> = z.object({
  findingId: nonEmpty,
  controlId: nonEmpty,
  skillId: nonEmpty,
  requirementId: nonEmpty.optional(),
  storyId: nonEmpty.optional(),
  status: z.enum(['pass', 'fail', 'blocker']),
  evidenceRefs: z.array(nonEmpty).min(1).refine((refs) => new Set(refs).size === refs.length, 'evidenceRefs must be unique'),
  message: nonEmpty,
}).strict();

export type FindingGateVerdict = 'pass' | 'fail' | 'blocked';

export interface IngestFindingsInput {
  findings: readonly unknown[];
  controls: readonly ControlRecord[];
  activeControlIds: readonly string[];
  /** US-004 compilation whose stage readiness is projected, never mutated. */
  compilation: Pick<GateCompilation, 'readiness'>;
}

export interface FindingsIngestionResult {
  findings: ReadonlyArray<Readonly<StructuredFinding>>;
  gateVerdict: FindingGateVerdict;
  readiness: ReadonlyArray<Readonly<StageReadiness>>;
  blockedControlIds: readonly string[];
}

export class FindingValidationError extends TypeError {
  constructor(
    readonly code: 'UNKNOWN_CONTROL' | 'SKILL_CONTROL_MISMATCH' | 'DUPLICATE_FINDING' | 'ACTIVE_CONTROL_STAGE_MISSING',
    message: string,
  ) {
    super(message);
    this.name = 'FindingValidationError';
  }
}

/** Isolated canonical finding store. It accepts no legacy or agent-specific finding shape. */
export class StructuredFindingStore {
  private readonly findingsById = new Map<string, StructuredFinding>();

  ingestFindings(input: IngestFindingsInput): FindingsIngestionResult {
    // Parse the complete batch before changing storage so invalid phase-review output is atomic.
    const findings = input.findings.map((finding) => StructuredFindingSchema.parse(finding));
    const controlsById = new Map(input.controls.map((control) => [control.controlId, control]));
    const batchIds = new Set<string>();

    for (const finding of findings) {
      const control = controlsById.get(finding.controlId);
      if (!control) {
        throw new FindingValidationError('UNKNOWN_CONTROL', `Finding ${finding.findingId} references unknown control ${finding.controlId}`);
      }
      if (!control.skillRefs.includes(finding.skillId)) {
        throw new FindingValidationError(
          'SKILL_CONTROL_MISMATCH',
          `Finding ${finding.findingId} skill ${finding.skillId} is not referenced by control ${finding.controlId}`,
        );
      }
      if (batchIds.has(finding.findingId) || this.findingsById.has(finding.findingId)) {
        throw new FindingValidationError('DUPLICATE_FINDING', `Duplicate findingId ${finding.findingId}`);
      }
      batchIds.add(finding.findingId);
    }

    const active = new Set(input.activeControlIds);
    const blockingIds = [...new Set(findings
      .filter(({ status, controlId }) => status === 'blocker' && active.has(controlId))
      .map(({ controlId }) => controlId))];
    const readiness = input.compilation.readiness.map((stage): StageReadiness => {
      const stageBlockers = blockingIds.filter((controlId) => stage.controlIds.includes(controlId));
      if (stageBlockers.length === 0) return structuredClone(stage);
      return {
        ...structuredClone(stage),
        unresolvedControlIds: [...new Set([...stage.unresolvedControlIds, ...stageBlockers])],
        blocking: true,
        status: 'blocked',
      };
    });
    const unprojected = blockingIds.filter((controlId) => !readiness.some((stage) => stage.controlIds.includes(controlId)));
    if (unprojected.length > 0) {
      throw new FindingValidationError(
        'ACTIVE_CONTROL_STAGE_MISSING',
        `Active blocker controls are absent from US-004 stage readiness: ${unprojected.join(', ')}`,
      );
    }

    for (const finding of findings) this.findingsById.set(finding.findingId, structuredClone(finding));
    const gateVerdict: FindingGateVerdict = blockingIds.length > 0
      ? 'blocked'
      : findings.some(({ status }) => status === 'fail') ? 'fail' : 'pass';
    return {
      findings: findings.map((finding) => Object.freeze(structuredClone(finding))),
      gateVerdict,
      readiness: readiness.map((stage) => Object.freeze(stage)),
      blockedControlIds: Object.freeze(blockingIds),
    };
  }

  getFinding(findingId: string): Readonly<StructuredFinding> | undefined {
    const finding = this.findingsById.get(findingId);
    return finding ? Object.freeze(structuredClone(finding)) : undefined;
  }

  listFindings(): ReadonlyArray<Readonly<StructuredFinding>> {
    return [...this.findingsById.values()].map((finding) => Object.freeze(structuredClone(finding)));
  }
}

const defaultStore = new StructuredFindingStore();

/** Ingest into the process-local canonical store. Prefer StructuredFindingStore for isolation. */
export function ingestFindings(input: IngestFindingsInput): FindingsIngestionResult {
  return defaultStore.ingestFindings(input);
}
