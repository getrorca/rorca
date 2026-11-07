/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// ─── OpenCode Server Lifecycle Manager ────────────────────────────────────────
// OC-003: Manages a warm OpenCode server process that stays alive across stories.
//
// When RORCA_AGENT=opencode, the execution engine spawns stories via
//   `opencode run --attach <socket> --format json --model <model> ...`
// The `--attach` flag connects to a pre-warmed server, eliminating cold-start
// overhead per story. This module manages that server's lifecycle.
//
// Usage (from execution-engine.ts or pipeline.ts):
//   const server = new OpenCodeServer();
//   await server.start();
//   const attachFlag = server.attach(); // "--attach /tmp/rorca-oc-xxxxx.sock"
//   // ... spawn N story subprocesses with attachFlag ...
//   server.stop();

import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectOpenCode } from './opencode-detector';

// ─── Constants ───────────────────────────────────────────────────────────────

const GRACEFUL_STOP_TIMEOUT_MS = 5_000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OpenCodeServerOptions {
  /** Override the opencode binary path (defaults to detectOpenCode resolution) */
  binPath?: string;
  /** Pipeline run ID — used to associate server PID in the database */
  runId?: number;
  /** Callback to persist server PID alongside the pipeline run */
  onPidReady?: (pid: number) => void;
}

export type ServerState = 'stopped' | 'starting' | 'running' | 'error';

// ─── OpenCodeServer ──────────────────────────────────────────────────────────

export class OpenCodeServer {
  private process: ChildProcess | null = null;
  private socketPath: string | null = null;
  private logPath: string;
  private state: ServerState = 'stopped';
  private binPath: string;
  private options: OpenCodeServerOptions;
  private restartAttempted = false;

  constructor(options: OpenCodeServerOptions = {}) {
    this.options = options;

    // Resolve binary path
    if (options.binPath) {
      this.binPath = options.binPath;
    } else {
      const status = detectOpenCode();
      if (!status.opencodeBinPath) {
        throw new Error('OpenCode binary not found. Set OPENCODE_BIN or install opencode.');
      }
      this.binPath = status.opencodeBinPath;
    }

    // Log to os.tmpdir() per AC
    this.logPath = path.join(os.tmpdir(), `rorca-opencode-server-${Date.now()}.log`);
  }

  /** Current server state */
  getState(): ServerState {
    return this.state;
  }

  /** Server process PID (null if not running) */
  getPid(): number | null {
    return this.process?.pid ?? null;
  }

  /** Path to the server log file */
  getLogPath(): string {
    return this.logPath;
  }

  /** Socket path the server is listening on (null if not started) */
  getSocketPath(): string | null {
    return this.socketPath;
  }

  /**
   * Start the OpenCode server. Spawns `opencode server` as a detached process,
   * waits for the socket file to appear (up to 10s), then resolves.
   *
   * Rejects if the server fails to start within the timeout or exits immediately.
   */
  async start(): Promise<void> {
    this.state = 'error';
    throw new Error(
      'Warm OpenCode server mode is retired because it cannot share a control socket across isolated namespaces. Use sandboxed per-request OpenCode execution.',
    );
  }

  /**
   * Returns the --attach flag value for use in `opencode run` commands.
   * Throws if server is not running.
   */
  attach(): string {
    if (this.state !== 'running' || !this.socketPath) {
      throw new Error('OpenCode server is not running. Call start() first.');
    }
    return this.socketPath;
  }

  /**
   * Check if the server process is still alive.
   */
  isAlive(): boolean {
    if (!this.process?.pid) return false;
    try {
      process.kill(this.process.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Attempt to restart the server after a crash.
   * Only allows one restart attempt per server instance (per AC).
   * Returns true if restart succeeded, false if already attempted or failed.
   */
  async restart(): Promise<boolean> {
    if (this.restartAttempted) return false;
    this.restartAttempted = true;

    // Clean up old socket if it exists
    if (this.socketPath) {
      try { fs.unlinkSync(this.socketPath); } catch { /* may not exist */ }
    }

    this.state = 'stopped';
    this.process = null;

    try {
      await this.start();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Gracefully stop the server process.
   * Sends SIGTERM, waits up to 5s, then SIGKILL if still alive.
   * Cleans up the socket file.
   */
  async stop(): Promise<void> {
    if (!this.process) {
      this.state = 'stopped';
      return;
    }

    const pid = this.process.pid;
    if (!pid) {
      this.state = 'stopped';
      this.process = null;
      return;
    }

    // Check if still alive before trying to kill
    if (!this.isAlive()) {
      this.state = 'stopped';
      this.process = null;
      this.cleanupSocket();
      return;
    }

    return new Promise<void>((resolve) => {
      const child = this.process!;

      const forceKillTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }, GRACEFUL_STOP_TIMEOUT_MS);

      child.once('exit', () => {
        clearTimeout(forceKillTimer);
        this.state = 'stopped';
        this.process = null;
        this.cleanupSocket();
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        // Already dead
        clearTimeout(forceKillTimer);
        this.state = 'stopped';
        this.process = null;
        this.cleanupSocket();
        resolve();
      }
    });
  }

  /** Remove the socket file from disk */
  private cleanupSocket(): void {
    if (this.socketPath) {
      try { fs.unlinkSync(this.socketPath); } catch { /* may not exist */ }
    }
  }
}
