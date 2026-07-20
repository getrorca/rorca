/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Provider-neutral dispatch seam for one pipeline story execution.
 *
 * Production providers and deterministic qualification fixtures both enter
 * through this contract. The adapter owns process launch/termination details;
 * the caller owns host validation, integration, and closeout gates.
 */
export interface StoryExecutionAdapterRequest<TPayload> {
  executionId: string;
  storyId: string;
  cwd: string;
  timeoutMs: number;
  payload: Readonly<TPayload>;
}

export interface StoryExecutionAdapterResult<TResult> {
  executionId: string;
  storyId: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  exitSignal: NodeJS.Signals | null;
  output: TResult;
}

export interface StoryExecutionAdapter<TPayload, TResult> {
  readonly name: string;
  execute(request: Readonly<StoryExecutionAdapterRequest<TPayload>>): Promise<StoryExecutionAdapterResult<TResult>>;
}

function assertIsoTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`[story-execution-adapter] ${label} must be an ISO timestamp`);
  return timestamp;
}

/** Validate adapter identity and bounded lifecycle facts at the canonical seam. */
export async function executeStoryWithAdapter<TPayload, TResult>(
  adapter: StoryExecutionAdapter<TPayload, TResult>,
  request: StoryExecutionAdapterRequest<TPayload>,
): Promise<StoryExecutionAdapterResult<TResult>> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(request.executionId)) {
    throw new Error('[story-execution-adapter] executionId is invalid');
  }
  if (!request.storyId || request.storyId.length > 128) {
    throw new Error('[story-execution-adapter] storyId is invalid');
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1) {
    throw new Error('[story-execution-adapter] timeoutMs must be a positive safe integer');
  }

  const frozenRequest = Object.freeze({
    ...request,
    payload: Object.freeze({ ...request.payload }),
  });
  const result = await adapter.execute(frozenRequest);
  if (result.executionId !== request.executionId || result.storyId !== request.storyId) {
    throw new Error(`[story-execution-adapter] ${adapter.name} returned mismatched execution identity`);
  }
  if (!Number.isInteger(result.exitCode)) {
    throw new Error(`[story-execution-adapter] ${adapter.name} returned an invalid exit code`);
  }
  const startedAt = assertIsoTimestamp(result.startedAt, 'startedAt');
  const finishedAt = assertIsoTimestamp(result.finishedAt, 'finishedAt');
  if (finishedAt < startedAt) {
    throw new Error(`[story-execution-adapter] ${adapter.name} returned reversed timestamps`);
  }
  return result;
}
