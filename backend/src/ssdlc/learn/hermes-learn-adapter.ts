/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import type { HermesWatchdogEvent } from '../../lib/hermes-watchdog';
import {
  consumeProductionOutcome,
  LearnLoopError,
  type LearnCandidate,
  type LearnCandidateType,
  type ProductionOutcome,
} from './learn-loop';
import type { Phase } from '../schema/control-schema';

export interface PendingAdjustmentProposal {
  target: 'control' | 'mechanism';
  rationale: string;
}

interface HermesLearnInput {
  controlId: string;
  phase: Phase;
  /** Durable evidence URI/reference. It is forwarded byte-for-byte. */
  evidenceRef: string;
  candidateType: LearnCandidateType;
  proposedAdjustment: PendingAdjustmentProposal;
  provenance?: Readonly<Record<string, unknown>>;
}

export interface HermesHealingLearnInput extends HermesLearnInput {
  event: HermesWatchdogEvent;
}

export interface HermesRunLearnInput extends HermesLearnInput {
  outcome: Readonly<{
    eventId: string;
    runId: number;
    rootRunId: number;
    status: string;
    executionIdentity: string;
  }>;
}

export type ProductionOutcomeConsumer = (outcome: ProductionOutcome) => LearnCandidate | undefined;

function assertPendingProposal(proposal: PendingAdjustmentProposal): void {
  if (!proposal || (proposal.target !== 'control' && proposal.target !== 'mechanism')) {
    throw new LearnLoopError('INVALID_ADJUSTMENT', "proposal target must be 'control' or 'mechanism'");
  }
  if (typeof proposal.rationale !== 'string' || !proposal.rationale.trim()) {
    throw new LearnLoopError('INVALID_ADJUSTMENT', 'proposal rationale is required');
  }
}

/**
 * Stateless AAV boundary for US-007. It owns neither candidate shape/storage nor
 * review/application: both methods return consumeProductionOutcome's value unchanged.
 */
export function createHermesLearnLoopAdapter(
  consume: ProductionOutcomeConsumer = consumeProductionOutcome,
): Readonly<{
  consumeHealingEvent(input: HermesHealingLearnInput): LearnCandidate | undefined;
  consumeRunOutcome(input: HermesRunLearnInput): LearnCandidate | undefined;
}> {
  return Object.freeze({
    consumeHealingEvent(input) {
      assertPendingProposal(input.proposedAdjustment);
      const { event } = input;
      return consume({
        source: 'aav-heal',
        outcomeType: 'healing',
        candidateType: input.candidateType,
        controlId: input.controlId,
        phase: input.phase,
        evidenceRef: input.evidenceRef,
        provenance: Object.freeze({
          ...input.provenance,
          adapter: 'AAV-022',
          sourceEventId: event.sourceEventId,
          sourceEventType: event.sourceEventType,
          hermesAuditIdentity: event.hermesAuditIdentity,
          runId: event.lineage.runId,
          rootRunId: event.lineage.rootRunId,
          healingOutcome: event.outcome,
          proposedAdjustment: Object.freeze({ ...input.proposedAdjustment }),
        }),
      });
    },

    consumeRunOutcome(input) {
      assertPendingProposal(input.proposedAdjustment);
      const { outcome } = input;
      return consume({
        source: 'aav-run',
        outcomeType: 'run',
        candidateType: input.candidateType,
        controlId: input.controlId,
        phase: input.phase,
        evidenceRef: input.evidenceRef,
        provenance: Object.freeze({
          ...input.provenance,
          adapter: 'AAV-022',
          sourceEventId: outcome.eventId,
          runId: outcome.runId,
          rootRunId: outcome.rootRunId,
          runStatus: outcome.status,
          executionIdentity: outcome.executionIdentity,
          proposedAdjustment: Object.freeze({ ...input.proposedAdjustment }),
        }),
      });
    },
  });
}

export const hermesLearnLoopAdapter = createHermesLearnLoopAdapter();
