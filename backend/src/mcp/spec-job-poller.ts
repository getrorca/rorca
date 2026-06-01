/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { SpecJobState } from '../db/spec-jobs';

const RORCA_API = process.env.RORCA_API_URL || 'http://localhost:3030';

export interface PollSpecJobOptions {
  intervalMs?: number;
  maxWaitMs?: number;
  onProgress?: (state: SpecJobState) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollSpecJob(
  jobId: string,
  options: PollSpecJobOptions = {},
): Promise<SpecJobState> {
  const {
    intervalMs = 2_000,
    maxWaitMs = 1_800_000,
    onProgress,
  } = options;

  const startedAt = Date.now();

  while (true) {
    const res = await fetch(`${RORCA_API}/api/spec-jobs/${encodeURIComponent(jobId)}`);
    const contentType = res.headers.get('content-type') || '';
    const body = contentType.includes('application/json')
      ? await res.json() as SpecJobState | { error?: string }
      : await res.text();

    if (!res.ok) {
      const message = typeof body === 'string'
        ? body
        : body.error || `Polling spec job ${jobId} failed with HTTP ${res.status}`;
      throw new Error(message);
    }

    const state = body as SpecJobState;
    onProgress?.(state);

    if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') {
      return state;
    }

    if (Date.now() - startedAt >= maxWaitMs) {
      throw new Error(`Spec job ${jobId} exceeded maxWaitMs=${maxWaitMs}`);
    }

    await sleep(intervalMs);
  }
}
