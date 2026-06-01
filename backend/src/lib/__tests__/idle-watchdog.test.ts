/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { EventEmitter } from 'events';
import { ChildProcess } from 'child_process';
import { createIdleWatchdog, IdleWatchdog } from '../execution-engine';

/** Minimal mock that satisfies ChildProcess.kill() for the watchdog. */
function mockChild(): ChildProcess & { killCalls: Array<NodeJS.Signals | number> } {
  const emitter = new EventEmitter() as ChildProcess & { killCalls: Array<NodeJS.Signals | number> };
  emitter.killCalls = [];
  emitter.kill = ((signal?: NodeJS.Signals | number): boolean => {
    emitter.killCalls.push(signal ?? 'SIGTERM');
    return true;
  }) as ChildProcess['kill'];
  Object.defineProperty(emitter, 'pid', { value: 99999, writable: true });
  return emitter;
}

describe('createIdleWatchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('fires SIGTERM when child is idle for timeoutMs', () => {
    const child = mockChild();
    const onFire = jest.fn();

    createIdleWatchdog(child, 1000, onFire);

    // Nothing should fire before the timeout
    jest.advanceTimersByTime(999);
    expect(onFire).not.toHaveBeenCalled();
    expect(child.killCalls).toHaveLength(0);

    // At timeout: onFire callback + SIGTERM
    jest.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(child.killCalls).toContain('SIGTERM');
  });

  test('fires SIGKILL 10s after SIGTERM', () => {
    const child = mockChild();
    createIdleWatchdog(child, 500, jest.fn());

    jest.advanceTimersByTime(500); // trigger fire
    expect(child.killCalls).toEqual(['SIGTERM']);

    jest.advanceTimersByTime(10_000); // escalation delay
    expect(child.killCalls).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('reset() restarts the idle timer — SIGTERM not sent before new timeout elapses', () => {
    const child = mockChild();
    const onFire = jest.fn();
    const watchdog = createIdleWatchdog(child, 1000, onFire);

    // Advance 800ms — within the first timeout window
    jest.advanceTimersByTime(800);
    expect(onFire).not.toHaveBeenCalled();

    // Simulate data event — resets the timer
    watchdog.reset();

    // Advance another 800ms — still within the NEW timeout window (800ms < 1000ms)
    jest.advanceTimersByTime(800);
    expect(onFire).not.toHaveBeenCalled();
    expect(child.killCalls).toHaveLength(0);

    // Advance remaining 200ms — now the new timeout fires
    jest.advanceTimersByTime(200);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(child.killCalls).toContain('SIGTERM');
  });

  test('child emits data at t=0, then silence — SIGTERM fires only after timeoutMs from last data event', () => {
    const child = mockChild();
    const onFire = jest.fn();
    const watchdog = createIdleWatchdog(child, 2000, onFire);

    // Simulate a data event immediately (at t=0)
    watchdog.reset();

    // At t=1999 — should still be silent
    jest.advanceTimersByTime(1999);
    expect(onFire).not.toHaveBeenCalled();

    // At t=2000 — fires
    jest.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(child.killCalls).toContain('SIGTERM');
  });

  test('clear() prevents watchdog from ever firing', () => {
    const child = mockChild();
    const onFire = jest.fn();
    const watchdog = createIdleWatchdog(child, 500, onFire);

    // Clear before timeout
    watchdog.clear();

    // Advance well past timeout
    jest.advanceTimersByTime(10_000);
    expect(onFire).not.toHaveBeenCalled();
    expect(child.killCalls).toHaveLength(0);
  });

  test('clear() on child error prevents dangling timer from firing', () => {
    const child = mockChild();
    const onFire = jest.fn();
    const watchdog = createIdleWatchdog(child, 1000, onFire);

    // Register error handler (as execution-engine.ts does) that calls clear()
    child.on('error', () => {
      watchdog.clear();
    });

    // Simulate child error
    child.emit('error', new Error('spawn ENOENT'));

    // Advance past timeout — watchdog must NOT fire
    jest.advanceTimersByTime(5000);
    expect(onFire).not.toHaveBeenCalled();
    expect(child.killCalls).toHaveLength(0);
  });

  test('onFire log message matches expected pattern', () => {
    const child = mockChild();
    const messages: string[] = [];
    const onFire = () => {
      const idleMinutes = Math.round(300_000 / 60_000);
      messages.push(
        `[System] Watchdog triggered: No output received for ${idleMinutes} minutes. Killing process...\n`,
      );
    };

    createIdleWatchdog(child, 500, onFire);
    jest.advanceTimersByTime(500);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/\[System\] Watchdog triggered/);
  });

  test('SIGTERM failure (already dead) does not throw', () => {
    const child = mockChild();
    // Override kill to throw (simulating already-dead process)
    child.kill = (() => {
      throw new Error('kill ESRCH');
    }) as ChildProcess['kill'];

    const onFire = jest.fn();
    createIdleWatchdog(child, 200, onFire);

    // Should not throw
    expect(() => jest.advanceTimersByTime(200)).not.toThrow();
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  test('multiple reset() calls — only the last timer matters', () => {
    const child = mockChild();
    const onFire = jest.fn();
    const watchdog = createIdleWatchdog(child, 1000, onFire);

    // Rapid resets at 100ms intervals
    for (let i = 0; i < 10; i++) {
      jest.advanceTimersByTime(100);
      watchdog.reset();
    }

    // We're now at t=1000 from start, but last reset was at t=1000
    // So timeout should fire at t=2000 from start
    jest.advanceTimersByTime(999);
    expect(onFire).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});
