// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0.
// See LICENSE file in the project root for full license text.

export class HealthProbeTimeoutError extends Error {
  readonly code = 'HEALTH_PROBE_TIMEOUT';

  constructor(readonly timeoutMs: number) {
    super(`health probe exceeded ${timeoutMs}ms`);
    this.name = 'HealthProbeTimeoutError';
  }
}

export interface HealthProbeTimers {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const defaultTimers: HealthProbeTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * Bound a health dependency without relying on elapsed-time assertions.
 *
 * The dependency may not support cancellation (for example, a query already
 * queued in pg). Promise.race still attaches rejection handling to that work,
 * while this wrapper guarantees that the HTTP decision is made by the fixed
 * deadline and clears the timer when the dependency wins.
 */
export async function withHealthProbeDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timers: HealthProbeTimers = defaultTimers,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('health probe timeout must be a positive number');
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = timers.setTimeout(() => reject(new HealthProbeTimeoutError(timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutHandle !== undefined) timers.clearTimeout(timeoutHandle);
  }
}
