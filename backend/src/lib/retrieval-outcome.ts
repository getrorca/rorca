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
  /** Human-readable memory title for trace/detail displays. */
  title?: string;
  /** Prompt-ready memory text/snippet for trace/detail displays. */
  snippet?: string;
  /** Final retrieval relevance score when available. */
  score?: number;
  source?: string;
  sourceType?: string;
}

type RetrievedForSelection = Pick<RetrievedContext, 'meta'> & Partial<Pick<RetrievedContext, 'memory'>>;

export function buildRetrievalSelectionsFromContext(
  retrieved?: RetrievedForSelection | null,
): RetrievalSelection[] {
  if (!retrieved) return [];
  const skillName = retrieved.meta.matchedSkills?.[0];
  const memoryByKey = indexSelectedMemories(retrieved.memory ?? []);
  const canonicalKeys = retrieved.meta.selectedCandidateKeys ?? [];
  if (canonicalKeys.length > 0) {
    return canonicalKeys.map((candidateKey) => ({
      candidateKey,
      candidateKind: 'memory',
      skillName,
      ...memorySelectionDetails(memoryByKey.get(candidateKey)),
    }));
  }
  return (retrieved.meta.selectedCandidateIds ?? []).map((candidateId) => {
    const candidateKey = `memory:${candidateId}`;
    return {
      candidateKey,
      candidateKind: 'memory',
      skillName,
      ...memorySelectionDetails(memoryByKey.get(candidateKey) ?? memoryByKey.get(candidateId)),
    };
  });
}

function indexSelectedMemories(memories: NonNullable<RetrievedForSelection['memory']>): Map<string, NonNullable<RetrievedForSelection['memory']>[number]> {
  const byKey = new Map<string, NonNullable<RetrievedForSelection['memory']>[number]>();
  for (const memory of memories) {
    if (memory.canonicalKey) byKey.set(memory.canonicalKey, memory);
    if (memory.id) {
      byKey.set(memory.id, memory);
      byKey.set(`memory:${memory.id}`, memory);
    }
  }
  return byKey;
}

function memorySelectionDetails(memory: NonNullable<RetrievedForSelection['memory']>[number] | undefined): Partial<RetrievalSelection> {
  if (!memory) return {};
  return {
    title: deriveMemoryTitle(memory.text),
    snippet: memory.text,
    score: memory.score,
    source: memory.source,
    ...(memory.sourceType ? { sourceType: memory.sourceType } : {}),
  };
}

function deriveMemoryTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const colonIndex = normalized.indexOf(':');
  if (colonIndex >= 4 && colonIndex <= 120) {
    const title = normalized.slice(0, colonIndex).trim();
    if (title.length >= 4) return title;
  }
  if (normalized.length <= 110) return normalized || 'Retrieved memory';
  return `${normalized.slice(0, 109).trimEnd()}…`;
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
