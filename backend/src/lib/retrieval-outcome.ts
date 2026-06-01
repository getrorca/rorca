/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { RetrievedContext } from './memory-router';
import { recordRetrievalOutcome } from './retrieval-feedback';
import { logger } from './logger';

export interface RetrievalSelection {
  candidateKey: string;
  candidateKind: string;
  skillName?: string;
}

export function buildRetrievalSelectionsFromContext(
  retrieved?: Pick<RetrievedContext, 'meta'> | null,
): RetrievalSelection[] {
  if (!retrieved) return [];
  const skillName = retrieved.meta.matchedSkills?.[0];
  const canonicalKeys = retrieved.meta.selectedCandidateKeys ?? [];
  if (canonicalKeys.length > 0) {
    return canonicalKeys.map((candidateKey) => ({
      candidateKey,
      candidateKind: 'memory',
      skillName,
    }));
  }
  return (retrieved.meta.selectedCandidateIds ?? []).map((candidateId) => ({
    candidateKey: `memory:${candidateId}`,
    candidateKind: 'memory',
    skillName,
  }));
}

export async function recordRetrievalSelectionsOutcome(
  workspaceId: string | null | undefined,
  selections: RetrievalSelection[],
  success: boolean,
): Promise<void> {
  if (!workspaceId || selections.length === 0) return;

  try {
    await Promise.all(
      selections.map(selection => recordRetrievalOutcome({
        workspaceId,
        candidateKey: selection.candidateKey,
        candidateKind: selection.candidateKind,
        skillName: selection.skillName,
        success,
      })),
    );
  } catch (err: any) {
    logger.warn(`  [retrieval-feedback] Failed to record retrieval outcome: ${err?.message ?? String(err)}`);
  }
}

export async function recordRetrievedContextOutcome(
  workspaceId: string | null | undefined,
  retrieved: Pick<RetrievedContext, 'meta'> | null | undefined,
  success: boolean,
): Promise<void> {
  await recordRetrievalSelectionsOutcome(
    workspaceId,
    buildRetrievalSelectionsFromContext(retrieved),
    success,
  );
}
