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
  persistCanonicalStoryResult,
  type CanonicalStoryResultInput,
  type CanonicalStoryResultOutcome,
} from './story-result-persistence';
import { writeFallbackResult, type FallbackResultEntry } from './resilient-post';

export interface EngineResultDeliveryContext {
  readonly runId: number;
  readonly workspaceId: string;
  readonly fallbackRoot: string;
}

export interface EngineResultDeliveryDependencies {
  persist?: (input: CanonicalStoryResultInput) => Promise<CanonicalStoryResultOutcome>;
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
  input: Omit<CanonicalStoryResultInput, 'runId' | 'expectedWorkspaceId'>,
  dependencies: EngineResultDeliveryDependencies = {},
): Promise<CanonicalStoryResultOutcome> {
  const persist = dependencies.persist ?? persistCanonicalStoryResult;
  const journal = dependencies.journal ?? writeFallbackResult;
  const now = dependencies.now ?? (() => new Date());
  const canonicalInput: CanonicalStoryResultInput = {
    ...input,
    runId: context.runId,
    expectedWorkspaceId: context.workspaceId,
  };

  try {
    return await persist(canonicalInput);
  } catch (error) {
    if (!isRetryableStoryResultPersistenceError(error)) throw error;
    const observedAt = now().toISOString();
    const entry: FallbackResultEntry = {
      type: 'story_result',
      storyId: canonicalInput.storyId,
      status: canonicalInput.status,
      runId: context.runId,
      retries: 0,
      ts: observedAt,
      idempotencyKey: canonicalInput.idempotencyKey,
      payload: {
        ...canonicalInput,
        runId: context.runId,
        expectedWorkspaceId: undefined,
        finishedAt: observedAt,
      },
    };
    if (!await journal(context.fallbackRoot, entry)) {
      throw new Error(`Story-result fallback persistence failed for ${canonicalInput.storyId}`, { cause: error });
    }
    throw error;
  }
}
