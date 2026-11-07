/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { retryHash } from './retry-governance';
import { deriveStoryContractRevision } from './story-execution-packet';

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
  // pg returns BIGINT as text; callers must hand us numbers but coerce here so a
  // string runId can never silently drop immutable evidence (and flip an accepted
  // story into a false "lacks finalized integration" failure).
  const inLineage = (runId: number | string): boolean => lineageSet.has(Number(runId));
  const closeouts = input.closeouts.filter((row) => inLineage(row.runId));
  const closeoutByRun = new Map<number, RetryRunCloseoutEvidence>();
  for (const closeout of closeouts) {
    const closeoutRunId = Number(closeout.runId);
    if (closeoutByRun.has(closeoutRunId)) throw new Error(`[governed-retry] run ${closeoutRunId} has contradictory closeout authority`);
    if (!closeout.integratedRevision || !closeout.evidenceIdentity) {
      throw new Error(`[governed-retry] run ${closeoutRunId} closeout identity is incomplete`);
    }
    closeoutByRun.set(closeoutRunId, closeout);
  }
  const missingCloseout = lineage.find((runId) => !closeoutByRun.has(runId));
  if (missingCloseout) throw new Error(`[governed-retry] run_closeout evidence is required for run ${missingCloseout}`);
  const targetCloseout = closeoutByRun.get(input.targetRunId)!;
  if (new Set(targetCloseout.integrationAncestry).size !== targetCloseout.integrationAncestry.length) {
    throw new Error(`[governed-retry] run ${input.targetRunId} has contradictory integration ancestry`);
  }
  const targetIntegrationOrder = new Map(
    targetCloseout.integrationAncestry.map((revision, index) => [revision, index]),
  );
  const completions = latestCompletions(input.completions.filter((row) => inLineage(row.runId)));
  const integrationByAttempt = new Map(
    input.integrations
      .filter((row) => inLineage(row.runId))
      .map((row) => [`${Number(row.runId)}:${row.storyId}:${row.attempt}`, row]),
  );
  const ancestryInOrder = closeouts.flatMap((row) => [...row.integrationAncestry, row.integratedRevision]);
  const carriedForward: CarriedForwardStory[] = [];
  const failedOrUnresolved = new Set<string>();

  for (const completion of completions) {
    const integration = integrationByAttempt.get(`${completion.runId}:${completion.storyId}:${completion.attempt}`);
    if (completion.outcome === 'accepted') {
      const targetOrder = integration?.resultingHead
        ? targetIntegrationOrder.get(integration.resultingHead)
        : undefined;
      if (
        !completion.sourceCommit
        || integration?.state !== 'finalized'
        || integration.sourceCommit !== completion.sourceCommit
        || !integration.resultingHead
        || targetOrder === undefined
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
        // Source integration_order is scoped to one run. Reindex against the
        // target closeout ancestry so transitive carry-forward rows have one
        // deterministic, collision-free order in the new dispatch.
        integrationOrder: targetOrder,
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

export function deriveNextGovernedRetryAttempt(input: {
  storyRetries: number;
  latestGovernedAttempt?: number | null;
}): { previousAttempt: number; attempt: number } {
  if (!Number.isSafeInteger(input.storyRetries) || input.storyRetries < 0) {
    throw new Error('[governed-retry] story retry count is invalid');
  }
  if (
    input.latestGovernedAttempt != null
    && (!Number.isSafeInteger(input.latestGovernedAttempt) || input.latestGovernedAttempt < 1)
  ) {
    throw new Error('[governed-retry] latest governed attempt is invalid');
  }
  const previousAttempt = Math.max(input.storyRetries + 1, input.latestGovernedAttempt ?? 0);
  return { previousAttempt, attempt: previousAttempt + 1 };
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
/**
 * Canonical spec projections may change after an attempt (for example passes or
 * operator notes). A scoped retry remains safe only when every story it will
 * execute still exactly matches immutable manifest authority from the lineage.
 */
export function hasExactExecutableStoryRevisionAuthority(input: {
  executableStoryIds: string[];
  currentStories: Array<Record<string, unknown>>;
  parentManifestRevisions: Array<{ story_id: string; story_revision: string }>;
  /** Retry-transformed stories (buildGovernedRetrySpec output). Legacy retry
   *  manifests froze this shape (effort/model/excluded/passes injected); the
   *  canonical shape is what new manifests freeze. Accept either derivation so
   *  retry-of-retry remains safe while old manifests stay authoritative. */
  retrySpecStories?: Array<Record<string, unknown>>;
}): boolean {
  if (input.executableStoryIds.length === 0) return false;
  const executable = new Set(input.executableStoryIds);
  if (executable.size !== input.executableStoryIds.length) return false;

  const currentById = new Map<string, Record<string, unknown>>();
  for (const story of input.currentStories) {
    if (typeof story.id !== 'string' || !executable.has(story.id)) continue;
    if (currentById.has(story.id)) return false;
    currentById.set(story.id, story);
  }

  const retryById = new Map<string, Record<string, unknown>>();
  for (const story of input.retrySpecStories ?? []) {
    if (typeof story.id !== 'string' || !executable.has(story.id)) continue;
    if (retryById.has(story.id)) return false;
    retryById.set(story.id, story);
  }

  const manifestById = new Map<string, string>();
  for (const manifest of input.parentManifestRevisions) {
    if (!executable.has(manifest.story_id) || manifestById.has(manifest.story_id)) return false;
    manifestById.set(manifest.story_id, manifest.story_revision);
  }

  return currentById.size === executable.size
    && manifestById.size === executable.size
    && input.executableStoryIds.every((storyId) => {
      const frozen = manifestById.get(storyId);
      const canonical = deriveStoryContractRevision(currentById.get(storyId));
      const retrySpecStory = retryById.get(storyId);
      return frozen === canonical
        || (retrySpecStory !== undefined && frozen === deriveStoryContractRevision(retrySpecStory));
    });
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
