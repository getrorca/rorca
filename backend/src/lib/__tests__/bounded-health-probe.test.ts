// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0.
// See LICENSE file in the project root for full license text.

import {
  HealthProbeTimeoutError,
  type HealthProbeTimers,
  withHealthProbeDeadline,
} from '../bounded-health-probe';

interface ScheduledTimer {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
}

function deterministicTimers() {
  const scheduled: ScheduledTimer[] = [];
  const timers: HealthProbeTimers = {
    setTimeout(callback, delayMs) {
      const timer = { callback, delayMs, cleared: false };
      scheduled.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(handle) {
      (handle as unknown as ScheduledTimer).cleared = true;
    },
  };
  return { timers, scheduled };
}

describe('withHealthProbeDeadline', () => {
  it('returns a completed readiness probe and cancels its deadline', async () => {
    const { timers, scheduled } = deterministicTimers();

    await expect(withHealthProbeDeadline(Promise.resolve({ activeRuns: 0 }), 750, timers))
      .resolves.toEqual({ activeRuns: 0 });

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ delayMs: 750, cleared: true });
  });

  it('fails closed at the configured deadline without a wall-clock assertion', async () => {
    const { timers, scheduled } = deterministicTimers();
    let resolveProbe!: (value: { activeRuns: number }) => void;
    const pendingProbe = new Promise<{ activeRuns: number }>((resolve) => { resolveProbe = resolve; });
    const result = withHealthProbeDeadline(pendingProbe, 750, timers);

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delayMs).toBe(750);
    scheduled[0].callback();

    await expect(result).rejects.toEqual(expect.objectContaining({
      name: 'HealthProbeTimeoutError',
      code: 'HEALTH_PROBE_TIMEOUT',
      timeoutMs: 750,
    } satisfies Partial<HealthProbeTimeoutError>));

    // A non-cancellable dependency completing later is still safely observed.
    resolveProbe({ activeRuns: 0 });
    await Promise.resolve();
  });

  it('rejects invalid deadlines before scheduling work', async () => {
    const { timers, scheduled } = deterministicTimers();
    await expect(withHealthProbeDeadline(Promise.resolve(true), 0, timers))
      .rejects.toThrow('health probe timeout must be a positive number');
    expect(scheduled).toHaveLength(0);
  });
});
