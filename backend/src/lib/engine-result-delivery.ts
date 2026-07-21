/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Fail-closed, run-scoped delivery for execution-engine story results. */

import * as path from 'path';
import { AppError } from './errors';
import {
  EXECUTION_ENGINE_RESULT_AUTHORITY,
  persistCanonicalStoryResult,
  stageIntegratedPassRecoveryPacket,
  type CanonicalStoryResultInput,
  type CanonicalStoryResultOutcome,
  type StoryResultAtomicFinalizationOptions,
} from './story-result-persistence';
import { writeFallbackResult, type FallbackResultEntry } from './resilient-post';

export interface EngineResultDeliveryContext {
  readonly runId: number;
  readonly workspaceId: string;
  readonly fallbackRoot: string;
}

export interface EngineResultDeliveryDependencies {
  persist?: (input: CanonicalStoryResultInput, options?: StoryResultAtomicFinalizationOptions) => Promise<CanonicalStoryResultOutcome>;
  journal?: (cwd: string, entry: FallbackResultEntry) => Promise<boolean>;
  now?: () => Date;
}

export function createEngineResultDeliveryContext(
  runId: number,
  workspaceId: string,
  fallbackRoot: string,
): EngineResultDeliveryContext {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new RangeError('runId must be a positive integer');
  if (!workspaceId) throw new Error('workspaceId is required for canonical story-result delivery');
  if (!fallbackRoot) throw new Error('fallbackRoot is required for canonical story-result delivery');
  return Object.freeze({
    runId,
    workspaceId,
    fallbackRoot: path.resolve(fallbackRoot),
  });
}

/** Only transient PostgreSQL/transport failures are eligible for durable replay. */
export function isRetryableStoryResultPersistenceError(error: unknown): boolean {
  if (error instanceof AppError) return false;
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  if (/^(08|53|57P0)/.test(code) || code === '40001' || code === '40P01') return true;
  if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) {
    return true;
  }
  const message = typeof candidate?.message === 'string' ? candidate.message.toLowerCase() : '';
  return /connection (?:terminated|refused|reset|closed)|timeout|timed out|pool is ending|server closed the connection/.test(message);
}

/**
 * The canonical DB transaction is the acknowledgement boundary. A transient
 * failure is journaled at the immutable run root for worker recovery, but is
 * still thrown so no caller can advance a local pass from a file append.
 */
export async function deliverEngineStoryResult(
  context: EngineResultDeliveryContext,
  input: Omit<CanonicalStoryResultInput, 'runId' | 'expectedWorkspaceId'> & StoryResultAtomicFinalizationOptions,
  dependencies: EngineResultDeliveryDependencies = {},
): Promise<CanonicalStoryResultOutcome> {
  const journal = dependencies.journal ?? writeFallbackResult;
  const now = dependencies.now ?? (() => new Date());
  // Freeze one observation time before the first DB attempt. A transport-
  // ambiguous commit and its fallback proposal therefore share an exact
  // immutable timestamp and can be compared during host refinalization.
  const finishedAt = input.finishedAt ?? now().toISOString();
  const { integrationFinalization, ...canonicalPayload } = input;
  const canonicalInput: CanonicalStoryResultInput = {
    ...canonicalPayload,
    finishedAt,
    runId: context.runId,
    expectedWorkspaceId: context.workspaceId,
  };

  try {
    const finalizationOptions = { integrationFinalization };
    if (integrationFinalization && !dependencies.persist) {
      // Freeze recovery authority in the application ledger before the result
      // transaction. A later journal is only a proposal to trigger this scan.
      await stageIntegratedPassRecoveryPacket(canonicalInput, finalizationOptions);
    }
    return dependencies.persist
      ? await dependencies.persist(canonicalInput, finalizationOptions)
      : await persistCanonicalStoryResult(canonicalInput, EXECUTION_ENGINE_RESULT_AUTHORITY, finalizationOptions);
  } catch (error) {
    if (!isRetryableStoryResultPersistenceError(error)) throw error;
    // The stable journal is intentionally untrusted. Preserve the complete
    // proposed outbox only so worker replay can compare it byte-for-byte with an
    // already immutable, ready host outbox. Replay has no insert/update/promote
    // path and this proposal can never mint governing WAL.
    const entry: FallbackResultEntry = {
      type: 'story_result',
      storyId: canonicalInput.storyId,
      status: canonicalInput.status,
      runId: context.runId,
      retries: 0,
      ts: finishedAt,
      idempotencyKey: canonicalInput.idempotencyKey,
      payload: {
        ...canonicalInput,
        runId: context.runId,
        expectedWorkspaceId: undefined,
        finishedAt,
        ...(integrationFinalization ? { integrationFinalization } : {}),
      },
    };
    if (!await journal(context.fallbackRoot, entry)) {
      throw new Error(`Story-result fallback persistence failed for ${canonicalInput.storyId}`, { cause: error });
    }
    throw error;
  }
}
