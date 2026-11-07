/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Exact-once lexical ownership for worker broker/runtime/child resources. */

import type { ChildProcess } from 'node:child_process';

export interface WorkerChildTerminal {
  kind: 'close' | 'error';
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

interface OwnedCleanup {
  label: string;
  cleanup: () => void | Promise<void>;
}

export class WorkerChildQuiescenceError extends Error {
  constructor(message = 'Worker-owned child did not become quiescent after SIGTERM/SIGKILL') {
    super(message);
    this.name = 'WorkerChildQuiescenceError';
  }
}

export function includesWorkerChildQuiescenceError(error: unknown): boolean {
  if (error instanceof WorkerChildQuiescenceError) return true;
  if (error instanceof AggregateError) return error.errors.some(includesWorkerChildQuiescenceError);
  return false;
}

export function includesWorkerResourceCleanupError(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some(candidate => includesWorkerResourceCleanupError(candidate));
  }
  return error instanceof Error && typeof (error as Error & { resourceLabel?: unknown }).resourceLabel === 'string';
}

export interface WorkerRunResourceOwnerOptions {
  runId?: number;
  termTimeoutMs?: number;
  killTimeoutMs?: number;
  onChildActive?: (runId: number, child: ChildProcess) => void;
  onChildInactive?: (runId: number, child: ChildProcess) => void;
}

function waitBounded(terminal: Promise<unknown>, ms: number): Promise<'terminal' | 'timeout'> {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve('timeout');
    }, ms);
    timer.unref?.();
    void terminal.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve('terminal');
    });
  });
}

/**
 * One owner is constructed before a worker job performs side effects and is
 * disposed by that job's outermost finally. Cleanup registration is LIFO and
 * disposal is promise-idempotent, so close/error/cancellation races cannot
 * release an identity twice or leave a later-acquired child alive.
 */
export class WorkerRunResourceOwner {
  private readonly cleanups: OwnedCleanup[] = [];
  private disposePromise: Promise<void> | null = null;
  private child: ChildProcess | null = null;
  private childTerminalPromise: Promise<WorkerChildTerminal> | null = null;
  private childClosePromise: Promise<void> | null = null;
  private childTerminalSettled = false;
  private childQuiescencePromise: Promise<void> | null = null;
  private resolveChildTerminal: ((terminal: WorkerChildTerminal) => void) | null = null;
  private resolveChildClose: (() => void) | null = null;
  private childClosed = false;
  private childInactive = false;
  private childDeadlineOwned = false;
  private childDeadlineTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: WorkerRunResourceOwnerOptions = {}) {}

  own(label: string, cleanup: () => void | Promise<void>): void {
    if (this.disposePromise) throw new Error(`Cannot acquire ${label} after worker resource disposal started`);
    this.cleanups.push({ label, cleanup });
  }

  ownTimer(timer: NodeJS.Timeout): void {
    this.own('lease timer', () => clearInterval(timer));
  }

  /**
   * Must be called in the same synchronous turn as spawn(). It installs error,
   * exit, and close listeners before the caller can await a PID/fence write.
   */
  ownChild(child: ChildProcess, runId = this.options.runId): Promise<WorkerChildTerminal> {
    if (this.child) throw new Error('Worker resource owner already owns a child');
    if (!Number.isSafeInteger(runId) || Number(runId) <= 0) throw new Error('Worker child ownership requires a valid run id');
    this.child = child;
    this.childTerminalPromise = new Promise(resolve => { this.resolveChildTerminal = resolve; });
    // `error` can win the semantic terminal race before `close`. Keep a
    // separate close proof so cleanup never mistakes a spawn/IPC error for
    // process quiescence when the child still has a PID.
    this.childClosePromise = new Promise(resolve => { this.resolveChildClose = resolve; });

    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    const settle = (terminal: WorkerChildTerminal): void => {
      if (this.childTerminalSettled) return;
      this.childTerminalSettled = true;
      this.resolveChildTerminal?.(terminal);
      this.resolveChildTerminal = null;
    };
    child.once('error', (error) => settle({
      kind: 'error',
      code: exitCode,
      signal: exitSignal,
      error: error instanceof Error ? error : new Error(String(error)),
    }));
    child.once('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.once('close', (code, signal) => {
      this.childClosed = true;
      this.resolveChildClose?.();
      this.resolveChildClose = null;
      settle({
        kind: 'close',
        code: code ?? exitCode,
        signal: signal ?? exitSignal,
      });
    });

    this.options.onChildActive?.(Number(runId), child);
    this.own('engine child', async () => {
      try {
        await this.quiesceChild();
      } catch (error) {
        // Unknown quiescence keeps the active identity for recovery. If close
        // proof arrives late, release that identity exactly once then.
        void this.childClosePromise?.then(() => this.markChildInactive(Number(runId), child));
        throw error;
      }
      this.markChildInactive(Number(runId), child);
    });
    return this.childTerminalPromise;
  }

  /**
   * Race semantic terminal observation against the hard run deadline. Deadline
   * expiry enters the same idempotent quiescence state machine as disposal:
   * TERM -> bounded close wait -> KILL -> bounded close proof. A missing close
   * rejects the worker await instead of leaving pg-boss to expire around a
   * still-pending callback.
   */
  ownChildDeadline(timeoutMs: number): Promise<WorkerChildTerminal> {
    if (!this.child || !this.childTerminalPromise) throw new Error('Worker resource owner has no child for deadline ownership');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_000_000) {
      throw new Error('Worker child deadline is outside the bounded timer range');
    }
    if (this.childDeadlineOwned) throw new Error('Worker resource owner already owns a child deadline');
    this.childDeadlineOwned = true;
    const deadlineFailure = new Promise<never>((_resolve, reject) => {
      this.childDeadlineTimer = setTimeout(() => {
        this.childDeadlineTimer = null;
        void this.quiesceChild().then(() => {
          if (!this.childClosed && !this.childTerminalSettled) {
            reject(new WorkerChildQuiescenceError('Worker-owned child produced no terminal close proof at its deadline'));
          }
        }, reject);
      }, timeoutMs);
      this.childDeadlineTimer.unref?.();
    });
    this.own('engine whole-run deadline', () => {
      if (this.childDeadlineTimer) clearTimeout(this.childDeadlineTimer);
      this.childDeadlineTimer = null;
    });
    const terminalOrDeadline = Promise.race([this.childTerminalPromise, deadlineFailure]);
    // Install rejection ownership immediately; callers still observe the same
    // rejecting promise when they reach their canonical terminal await.
    void terminalOrDeadline.catch(() => undefined);
    return terminalOrDeadline;
  }

  waitForChild(): Promise<WorkerChildTerminal> {
    if (!this.childTerminalPromise) throw new Error('Worker resource owner has no child');
    return this.childTerminalPromise;
  }

  signalChild(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (!this.child || this.childClosed) return false;
    try { return this.child.kill(signal); } catch { return false; }
  }

  private markChildInactive(runId: number, child: ChildProcess): void {
    if (this.childInactive) return;
    this.childInactive = true;
    this.options.onChildInactive?.(runId, child);
  }

  private quiesceChild(): Promise<void> {
    this.childQuiescencePromise ??= this.performChildQuiescence();
    return this.childQuiescencePromise;
  }

  private async performChildQuiescence(): Promise<void> {
    const child = this.child;
    const closed = this.childClosePromise;
    // Failed spawn has no PID to quiesce. An `error` with a PID, however, is
    // not sufficient evidence of death: wait for `close` and escalate exactly
    // as for cancellation so cleanup cannot release later resources early.
    if (!child || !closed || this.childClosed || !child.pid) return;
    this.signalChild('SIGTERM');
    if (await waitBounded(closed, this.options.termTimeoutMs ?? 2_000) === 'terminal') return;
    this.signalChild('SIGKILL');
    if (await waitBounded(closed, this.options.killTimeoutMs ?? 2_000) !== 'terminal') {
      throw new WorkerChildQuiescenceError();
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      const errors: Array<Error & { resourceLabel?: string }> = [];
      for (const owned of [...this.cleanups].reverse()) {
        try {
          await owned.cleanup();
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          Object.assign(normalized, { resourceLabel: owned.label });
          errors.push(normalized);
        }
      }
      this.cleanups.length = 0;
      if (errors.length > 0) throw new AggregateError(errors, 'Worker exact-once resource cleanup failed');
    })();
    return this.disposePromise;
  }
}
