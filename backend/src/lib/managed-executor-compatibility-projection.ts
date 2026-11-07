/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export type GovernedMissionMode = 'off' | 'observe' | 'enforce';
export function governedMissionMode(env: NodeJS.ProcessEnv = process.env): GovernedMissionMode {
  const value = env.RORCA_GOVERNED_MISSION_MODE?.trim().toLowerCase();
  return value === 'observe' || value === 'enforce' ? value : 'off';
}

export interface LegacyExecutionFacts {
  workspaceId: string; runId: number; storyId: string; attempt: number; generation: number;
  specRevision: string | null; gitSha: string | null; worktreeId: string | null;
  status: string; closeoutDecisionId: string | null;
}

/**
 * Disabled-by-default read projection. It never fabricates missing revision,
 * lease, policy, checkpoint, evidence, or closeout authority.
 */
export function projectLegacyManagedExecution(facts: LegacyExecutionFacts, mode = governedMissionMode()) {
  if (mode === 'off') return null;
  const exact = Boolean(facts.specRevision && facts.gitSha && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(facts.gitSha) && facts.worktreeId);
  if (!exact) return {
    schemaVersion: 'rorca.managed-executor-compatibility-projection.v1', authoritative: false, mode,
    availability: 'legacy_unmappable', reasonCode: 'exact_revision_or_worktree_missing',
    executionAuthority: 'none', mergeAuthority: 'none', deploymentAuthority: 'none',
  } as const;
  return {
    schemaVersion: 'rorca.managed-executor-compatibility-projection.v1', authoritative: false,
    availability: 'available', mode, workspaceId: facts.workspaceId, runId: facts.runId, storyId: facts.storyId,
    attempt: facts.attempt, generation: facts.generation, specRevision: facts.specRevision,
    gitSha: facts.gitSha, worktreeId: facts.worktreeId, observedStatus: facts.status,
    closeoutDecisionId: facts.closeoutDecisionId,
    storyCompletionAuthority: facts.closeoutDecisionId ? 'referenced_existing_decision' : 'none',
    executionAuthority: 'none', mergeAuthority: 'none', deploymentAuthority: 'none',
  } as const;
}

export function managedExecutorProjectionForPersistence(facts: LegacyExecutionFacts, mode = governedMissionMode()) {
  const projection = projectLegacyManagedExecution(facts, mode);
  if (mode === 'enforce' && projection?.availability !== 'available') {
    const error = new Error('Governed managed-executor enforce mode requires exact spec revision, Git SHA, and worktree identity');
    error.name = 'GovernedManagedExecutorUnmappableError';
    throw error;
  }
  return projection;
}
