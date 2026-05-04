/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { spawn, type ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { closePool } from '../db/index';
import {
  WORKER_HEARTBEAT_STALE_MS,
  getLatestWorkerHeartbeat,
  isWorkerHeartbeatStale,
} from './worker-heartbeat';

interface ChildConfig {
  name: string;
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface SupervisedChild {
  name: string;
  process: ChildProcess;
  restartCount: number;
  lastRestart: number;
}

interface SupervisorOptions {
  api?: Omit<ChildConfig, 'name'>;
  worker?: Omit<ChildConfig, 'name'>;
  apiHealthUrl?: string;
  healthTimeoutMs?: number;
  heartbeatCheckIntervalMs?: number;
}

const HEALTH_POLL_INTERVAL_MS = 200;
const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_CHECK_INTERVAL_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 5;
const RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 30_000];

export class Supervisor {
  private readonly configs = new Map<string, ChildConfig>();
  private readonly children = new Map<string, SupervisedChild>();
  private readonly restartTimestamps = new Map<string, number[]>();
  private readonly apiHealthUrl: string;
  private readonly healthTimeoutMs: number;
  private readonly heartbeatCheckIntervalMs: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private apiHealthy = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: SupervisorOptions = {}) {
    this.apiHealthUrl = options.apiHealthUrl ?? 'http://localhost:3030/api/health';
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.heartbeatCheckIntervalMs = options.heartbeatCheckIntervalMs ?? DEFAULT_HEARTBEAT_CHECK_INTERVAL_MS;

    if (options.api) {
      this.configs.set('api', { name: 'api', ...options.api });
    }
    if (options.worker) {
      this.configs.set('worker', { name: 'worker', ...options.worker });
    }
  }

  spawn(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): SupervisedChild {
    this.configs.set(name, { name, cmd, args, env, cwd });

    const childProcess = spawn(cmd, args, {
      cwd: cwd ?? process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const child: SupervisedChild = {
      name,
      process: childProcess,
      restartCount: 0,
      lastRestart: 0,
    };
    this.children.set(name, child);
    this.attachOutput(child);
    this.attachExitHandler(child);

    childProcess.on('error', (error) => {
      console.error(`[supervisor] Failed to start ${name}: ${error.message}`);
      void this.failUnhealthy();
    });

    return child;
  }

  async start(): Promise<void> {
    const apiConfig = this.requireConfig('api');
    const workerConfig = this.requireConfig('worker');

    this.spawn(apiConfig.name, apiConfig.cmd, apiConfig.args, apiConfig.env, apiConfig.cwd);

    try {
      await this.waitForHealthy(this.apiHealthUrl, this.healthTimeoutMs);
      this.apiHealthy = true;
    } catch (error) {
      console.error('[supervisor] API failed health check during startup');
      const apiChild = this.children.get('api');
      if (apiChild && !apiChild.process.killed) {
        try { apiChild.process.kill('SIGKILL'); } catch { /* best-effort */ }
      }
      throw error;
    }

    this.spawn(workerConfig.name, workerConfig.cmd, workerConfig.args, workerConfig.env, workerConfig.cwd);
    this.startWorkerHeartbeatMonitor();
  }

  async waitForHealthy(url: string, timeoutMs = this.healthTimeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          return;
        }
      } catch {
        // API still starting.
      }
      await this.sleep(HEALTH_POLL_INTERVAL_MS);
    }

    throw new Error(`Health check timed out after ${timeoutMs}ms: ${url}`);
  }

  async stop(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.stopping = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.shutdownPromise = (async () => {
      const shutdownOrder = ['worker', 'api']
        .map(name => this.children.get(name))
        .filter((child): child is SupervisedChild => Boolean(child));

      for (const child of shutdownOrder) {
        try {
          child.process.kill('SIGTERM');
        } catch {
          // best-effort
        }
      }

      const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
      while (this.children.size > 0 && Date.now() < deadline) {
        await this.sleep(200);
      }

      if (this.children.size > 0) {
        for (const child of this.children.values()) {
          try {
            child.process.kill('SIGKILL');
          } catch {
            // best-effort
          }
        }
      }

      try {
        await closePool();
      } catch {
        // best-effort
      }
    })();

    return this.shutdownPromise;
  }

  restartChild(name: string): void {
    const config = this.configs.get(name);
    if (!config || this.stopping) {
      return;
    }

    const now = Date.now();
    const timestamps = (this.restartTimestamps.get(name) ?? []).filter(ts => now - ts < RESTART_WINDOW_MS);
    timestamps.push(now);
    this.restartTimestamps.set(name, timestamps);

    if (timestamps.length > MAX_RESTARTS_PER_WINDOW) {
      console.error(`[supervisor] ${name} exceeded restart limit (${MAX_RESTARTS_PER_WINDOW} in ${RESTART_WINDOW_MS / 1000}s)`);
      void this.failUnhealthy();
      return;
    }

    const restartAttempt = timestamps.length;
    const delayMs = RESTART_DELAYS_MS[Math.min(restartAttempt - 1, RESTART_DELAYS_MS.length - 1)];

    console.error(`[supervisor] Restarting ${name} in ${delayMs}ms (attempt ${restartAttempt})`);

    setTimeout(() => {
      if (this.stopping) {
        return;
      }

      const restarted = this.spawn(config.name, config.cmd, config.args, config.env, config.cwd);
      restarted.restartCount = restartAttempt;
      restarted.lastRestart = Date.now();
    }, delayMs);
  }

  private attachExitHandler(child: SupervisedChild): void {
    child.process.on('exit', (code, signal) => {
      this.children.delete(child.name);
      if (this.stopping) {
        return;
      }

      const exitCode = code ?? 'null';
      const exitSignal = signal ?? 'none';
      console.error(`[supervisor] Child exited name=${child.name} restartCount=${child.restartCount} exitCode=${exitCode} signal=${exitSignal}`);

      if (child.name === 'api' && !this.apiHealthy) {
        void this.failUnhealthy();
        return;
      }

      this.restartChild(child.name);
    });
  }

  private attachOutput(child: SupervisedChild): void {
    this.pipeWithPrefix(child.process.stdout, `[${child.name}] `, process.stdout);
    this.pipeWithPrefix(child.process.stderr, `[${child.name}] `, process.stderr);
  }

  private pipeWithPrefix(
    stream: NodeJS.ReadableStream | null,
    prefix: string,
    destination: NodeJS.WriteStream,
  ): void {
    if (!stream) {
      return;
    }

    const decoder = new StringDecoder('utf8');
    let buffered = '';

    const flushBuffered = (force = false) => {
      let newlineIndex = buffered.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffered.slice(0, newlineIndex + 1);
        destination.write(prefix + line);
        buffered = buffered.slice(newlineIndex + 1);
        newlineIndex = buffered.indexOf('\n');
      }
      if (force && buffered.length > 0) {
        destination.write(prefix + buffered);
        buffered = '';
      }
    };

    stream.on('data', (chunk: Buffer | string) => {
      buffered += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      flushBuffered();
    });
    stream.on('end', () => {
      buffered += decoder.end();
      flushBuffered(true);
    });
  }

  private startWorkerHeartbeatMonitor(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      void this.checkWorkerHeartbeat();
    }, this.heartbeatCheckIntervalMs);
  }

  private async checkWorkerHeartbeat(): Promise<void> {
    if (this.stopping || !this.children.has('worker')) {
      return;
    }

    try {
      const heartbeat = await getLatestWorkerHeartbeat();
      if (!heartbeat || isWorkerHeartbeatStale(heartbeat.last_seen)) {
        const worker = this.children.get('worker');
        if (worker && !worker.process.killed) {
          console.error(
            `[supervisor] Worker heartbeat stale (threshold ${WORKER_HEARTBEAT_STALE_MS / 1000}s) — sending SIGKILL`,
          );
          worker.process.kill('SIGKILL');
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[supervisor] Worker heartbeat check failed: ${message}`);
    }
  }

  private requireConfig(name: string): ChildConfig {
    const config = this.configs.get(name);
    if (!config) {
      throw new Error(`Missing supervisor config for child "${name}"`);
    }
    return config;
  }

  private async failUnhealthy(): Promise<void> {
    if (this.stopping) {
      return;
    }

    await this.stop();
    process.exit(1);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
