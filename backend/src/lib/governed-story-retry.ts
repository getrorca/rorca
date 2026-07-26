/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { retryHash } from './retry-governance';

export const GOVERNED_RETRY_DISPATCH_VERSION = 'rorca.governed-retry-dispatch.v1' as const;

export type RetryCompletionOutcome = 'accepted' | 'rejected' | 'failed' | 'unresolved';

export interface RetryCompletionEvidence {
  runId: number;
  storyId: string;
  attempt: number;
  resultIdentity: string;
  outcome: RetryCompletionOutcome;
  sourceCommit: string | null;
}

export interface RetryIntegrationEvidence {
  runId: number;
  storyId: string;
  attempt: number;
  state: 'prepared' | 'integrating' | 'conflicted' | 'aborted' | 'integrated' | 'integrated_validated' | 'finalized' | 'failed';
  sourceCommit: string;
  resultingHead: string | null;
  integrationOrder: number;
}

export interface RetryRunCloseoutEvidence {
  runId: number;
  status: 'done' | 'completed' | 'failed' | 'partial_failure';
  integratedRevision: string;
  integrationAncestry: string[];
  acceptedStoryIds: string[];
  evidenceIdentity: string;
}

export interface CarriedForwardStory {
  storyId: string;
  sourceRunId: number;
  sourceAttempt: number;
  resultIdentity: string;
  sourceCommit: string;
  resultingHead: string;
  integrationOrder: number;
  reasonCode: 'ACCEPTED_INTEGRATED_SIBLING';
}

export interface AuthoritativeRetryScope {
  originalRunLineage: number[];
  targetRevision: string;
  priorIntegrationAncestry: string[];
  executableStoryIds: string[];
  carriedForward: CarriedForwardStory[];
  evidenceHash: string;
}

function canonicalUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function latestCompletions(rows: readonly RetryCompletionEvidence[]): RetryCompletionEvidence[] {
  const latest = new Map<string, RetryCompletionEvidence>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.runId) || row.runId < 1 || !Number.isSafeInteger(row.attempt) || row.attempt < 1 || !row.storyId || !row.resultIdentity) {
      throw new Error('[governed-retry] completion evidence identity is invalid');
    }
    const current = latest.get(row.storyId);
    if (!current || row.attempt > current.attempt || (row.attempt === current.attempt && row.runId > current.runId)) latest.set(row.storyId, row);
    else if (row.attempt === current.attempt && row.runId === current.runId && retryHash(row) !== retryHash(current)) {
      throw new Error(`[governed-retry] contradictory completion evidence for ${row.storyId} attempt ${row.attempt}`);
    }
  }
  return [...latest.values()].sort((left, right) => left.storyId.localeCompare(right.storyId));
}

/**
 * Derive retry work exclusively from immutable completion, finalized integration,
 * and run-closeout evidence. An accepted completion with incomplete integration
 * is ambiguous and fails closed instead of being executed again.
 */
export function deriveAuthoritativeRetryScope(input: {
  originalRunLineage: number[];
  targetRunId: number;
  completions: RetryCompletionEvidence[];
  integrations: RetryIntegrationEvidence[];
  closeouts: RetryRunCloseoutEvidence[];
  requestedStoryIds?: string[];
}): AuthoritativeRetryScope {
  const lineage = [...new Set(input.originalRunLineage)];
  if (lineage.length === 0 || lineage.some((runId) => !Number.isSafeInteger(runId) || runId < 1)) {
    throw new Error('[governed-retry] original run lineage is invalid');
  }
  const lineageSet = new Set(lineage);
  if (!lineageSet.has(input.targetRunId)) throw new Error('[governed-retry] target run is outside original lineage');
  const closeouts = input.closeouts.filter((row) => lineageSet.has(row.runId));
  const closeoutByRun = new Map<number, RetryRunCloseoutEvidence>();
  for (const closeout of closeouts) {
    if (closeoutByRun.has(closeout.runId)) throw new Error(`[governed-retry] run ${closeout.runId} has contradictory closeout authority`);
    if (!closeout.integratedRevision || !closeout.evidenceIdentity) {
      throw new Error(`[governed-retry] run ${closeout.runId} closeout identity is incomplete`);
    }
    closeoutByRun.set(closeout.runId, closeout);
  }
  const missingCloseout = lineage.find((runId) => !closeoutByRun.has(runId));
  if (missingCloseout) throw new Error(`[governed-retry] run_closeout evidence is required for run ${missingCloseout}`);
  const targetCloseout = closeoutByRun.get(input.targetRunId)!;
  const completions = latestCompletions(input.completions.filter((row) => lineageSet.has(row.runId)));
  const integrationByAttempt = new Map(
    input.integrations
      .filter((row) => lineageSet.has(row.runId))
      .map((row) => [`${row.runId}:${row.storyId}:${row.attempt}`, row]),
  );
  const ancestryInOrder = closeouts.flatMap((row) => [...row.integrationAncestry, row.integratedRevision]);
  const carriedForward: CarriedForwardStory[] = [];
  const failedOrUnresolved = new Set<string>();

  for (const completion of completions) {
    const integration = integrationByAttempt.get(`${completion.runId}:${completion.storyId}:${completion.attempt}`);
    if (completion.outcome === 'accepted') {
      if (
        !completion.sourceCommit
        || integration?.state !== 'finalized'
        || integration.sourceCommit !== completion.sourceCommit
        || !integration.resultingHead
        || !closeoutByRun.get(completion.runId)?.acceptedStoryIds.includes(completion.storyId)
        || !closeoutByRun.get(completion.runId)?.integrationAncestry.includes(integration.resultingHead)
      ) {
        throw new Error(`[governed-retry] accepted story ${completion.storyId} lacks matching finalized integration and run_closeout ancestry`);
      }
      carriedForward.push({
        storyId: completion.storyId,
        sourceRunId: completion.runId,
        sourceAttempt: completion.attempt,
        resultIdentity: completion.resultIdentity,
        sourceCommit: completion.sourceCommit,
        resultingHead: integration.resultingHead,
        integrationOrder: integration.integrationOrder,
        reasonCode: 'ACCEPTED_INTEGRATED_SIBLING',
      });
      continue;
    }
    if (integration && ['integrated', 'integrated_validated', 'finalized'].includes(integration.state)) {
      throw new Error(`[governed-retry] non-accepted story ${completion.storyId} has integrated evidence; manual review is required`);
    }
    failedOrUnresolved.add(completion.storyId);
  }

  const requested = input.requestedStoryIds?.length
    ? canonicalUnique(input.requestedStoryIds)
    : canonicalUnique([...failedOrUnresolved]);
  const staleRequest = requested.find((storyId) => !failedOrUnresolved.has(storyId));
  if (staleRequest) throw new Error(`[governed-retry] story ${staleRequest} is not failed or unresolved in authoritative evidence`);
  if (requested.length === 0) throw new Error('[governed-retry] no failed or unresolved work remains');

  carriedForward.sort((left, right) => left.integrationOrder - right.integrationOrder || left.storyId.localeCompare(right.storyId));
  const projection = {
    originalRunLineage: lineage,
    targetRevision: targetCloseout.integratedRevision,
    priorIntegrationAncestry: [...new Set(ancestryInOrder)],
    executableStoryIds: requested,
    carriedForward,
  };
  return { ...projection, evidenceHash: retryHash(projection) };
}

export interface GovernedRetryStoryAttemptIdentity {
  storyId: string;
  attempt: number;
  sourceRunId: number;
  previousAttempt: number;
  idempotencyKey: string;
}

export interface GovernedRetryDispatchIdentity {
  schemaVersion: typeof GOVERNED_RETRY_DISPATCH_VERSION;
  workspaceId: string;
  specId: string;
  specRevision: string;
  originalRunId: number;
  originalRunLineage: number[];
  retryRunId: number;
  baseRevision: string;
  integratedRevision: string;
  priorIntegrationAncestry: string[];
  recoveryRef: string;
  recoveryRefRevision: string;
  fencingToken: number;
  leaseIdentity: string;
  idempotencyKey: string;
  queueName: 'pipeline:retry';
  queuePayloadHash: string;
  executionManifestHash: string;
  approvedPreviewHash: string;
  scopeHash: string;
  evidenceHash: string;
  taskManifestLineageHash: string | null;
  storyAttempts: GovernedRetryStoryAttemptIdentity[];
  carriedForward: CarriedForwardStory[];
  identityHash: string;
}

export type GovernedRetryDispatchIdentityInput = Omit<GovernedRetryDispatchIdentity, 'schemaVersion' | 'identityHash'>;

export function createGovernedRetryDispatchIdentity(input: GovernedRetryDispatchIdentityInput): GovernedRetryDispatchIdentity {
  if (input.queueName !== 'pipeline:retry' || input.fencingToken < 1 || input.storyAttempts.length === 0) {
    throw new Error('[governed-retry] dispatch identity is incomplete');
  }
  if (input.taskManifestLineageHash !== null
    && !/^sha256:[a-f0-9]{64}$/.test(input.taskManifestLineageHash)) {
    throw new Error('[governed-retry] TaskManifest lineage hash is invalid');
  }
  if (input.baseRevision !== input.integratedRevision || input.recoveryRefRevision !== input.integratedRevision) {
    throw new Error('[governed-retry] retry target must be the exact latest integrated recovery-ref revision');
  }
  for (const attempt of input.storyAttempts) {
    if (attempt.attempt !== attempt.previousAttempt + 1) throw new Error(`[governed-retry] ${attempt.storyId} retry must append exactly one attempt`);
  }
  const base = { schemaVersion: GOVERNED_RETRY_DISPATCH_VERSION, ...input };
  return { ...base, identityHash: retryHash(base) };
}

export function verifyGovernedRetryDispatchIdentity(identity: GovernedRetryDispatchIdentity): boolean {
  const { identityHash, ...base } = identity;
  return identity.schemaVersion === GOVERNED_RETRY_DISPATCH_VERSION && retryHash(base) === identityHash;
}

/** Hash the exact queue authority without recursively hashing its enclosing identity. */
export function governedRetryQueuePayloadHash(payload: Record<string, unknown>): string {
  const { dispatchIdentity: _dispatchIdentity, ...authority } = payload;
  return retryHash(authority);
}

export type PostIntegrationReplayDecision =
  | { action: 'finalize_once'; resultingHead: string }
  | { action: 'manual_review_required'; reason: string };

/** Never apply again after a Git operation: reconcile only the prepared parent/source identity. */
export function reconcilePostIntegrationReplay(input: {
  expectedParentHead: string;
  sourceCommit: string;
  observedHead: string;
  observedParents: string[];
  observedTreeHash: string;
  preparedTreeHash: string;
}): PostIntegrationReplayDecision {
  if (
    input.observedParents.length === 2
    && input.observedParents[0] === input.expectedParentHead
    && input.observedParents[1] === input.sourceCommit
    && input.observedTreeHash === input.preparedTreeHash
  ) return { action: 'finalize_once', resultingHead: input.observedHead };
  return { action: 'manual_review_required', reason: 'observed integration commit/tree does not match prepared identities' };
}
