/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { spawn } from 'child_process';
import * as readline from 'readline/promises';
import { describePgvectorFix, setDbMode } from './db-strategy';

const CONTAINER_NAME = 'rorca-db';
const VOLUME_NAME = 'rorca-db-data';
const DOCKER_IMAGE = 'apache/age:latest';

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface ContainerStatus {
  exists: boolean;
  running: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runDockerCommand(
  args: string[],
  options?: { timeoutMs?: number; stdio?: 'inherit' | 'pipe' }
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const stdio = options?.stdio ?? 'pipe';
    const child = spawn('docker', args, {
      stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      signal: options?.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
    });
    let stdout = '';
    let stderr = '';
    if (stdio === 'pipe') {
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

async function runDockerOrThrow(
  args: string[],
  options?: { timeoutMs?: number; stdio?: 'inherit' | 'pipe' }
): Promise<CommandResult> {
  const result = await runDockerCommand(args, options);
  if (result.code === 0) return result;
  const detail = result.stderr || result.stdout || `docker ${args.join(' ')} failed`;
  throw new Error(detail);
}

export async function requireDocker(): Promise<void> {
  try {
    await runDockerOrThrow(['info'], { timeoutMs: 3000 });
    return;
  } catch {
    // fall through
  }
  throw {
    code: 'DOCKER_UNAVAILABLE',
    hint: 'Install Docker Desktop or run `rorca db use native`',
  };
}

async function inspectContainer(): Promise<ContainerStatus> {
  const result = await runDockerCommand([
    'inspect',
    CONTAINER_NAME,
    '--format',
    '{{.State.Running}}',
  ]);
  if (result.code !== 0) return { exists: false, running: false };
  return { exists: true, running: result.stdout === 'true' };
}

async function waitForReady(): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const result = await runDockerCommand([
      'exec',
      CONTAINER_NAME,
      'pg_isready',
      '-U',
      'rorca',
    ]);
    if (result.code === 0) return;
    await delay(1000);
  }
  throw new Error('Docker Postgres did not become ready within 15s');
}

async function confirmReset(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Reset Docker Postgres and delete all data? [y/N] ');
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

async function extensionEnabled(extname: 'age' | 'vector'): Promise<boolean> {
  const result = await runDockerCommand([
    'exec',
    CONTAINER_NAME,
    'psql',
    '-U',
    'rorca',
    '-d',
    'rorca',
    '-tAc',
    `SELECT 1 FROM pg_extension WHERE extname = '${extname}'`,
  ]);
  return result.code === 0 && result.stdout === '1';
}

async function ageExtensionEnabled(): Promise<boolean> {
  return extensionEnabled('age');
}

async function vectorExtensionEnabled(): Promise<boolean> {
  return extensionEnabled('vector');
}

export async function dbStart(): Promise<void> {
  await requireDocker();
  const status = await inspectContainer();
  if (!status.exists) {
    await runDockerOrThrow([
      'run', '-d', '--name', CONTAINER_NAME, '-p', '5432:5432',
      '-v', `${VOLUME_NAME}:/var/lib/postgresql/data`,
      '-e', 'POSTGRES_DB=rorca',
      '-e', 'POSTGRES_USER=rorca',
      '-e', 'POSTGRES_PASSWORD=rorca',
      DOCKER_IMAGE,
    ]);
  } else if (!status.running) {
    await runDockerOrThrow(['start', CONTAINER_NAME]);
  }
  await waitForReady();
  await enableAgeExtension();
  // LHM-009: Verify pgvector actually bootstrapped in the image before the Docker
  // path is marked ready. enableAgeExtension() requests it, but a stale/foreign
  // image may not provide it — surface a concrete fix path instead of silently
  // accepting a vector-less database.
  if (!(await vectorExtensionEnabled())) {
    throw new Error(describePgvectorFix('docker'));
  }
  setDbMode('docker');
}

export async function dbStop(): Promise<void> {
  await runDockerOrThrow(['stop', CONTAINER_NAME]);
}

export async function dbStatus(): Promise<{ running: boolean; containerExists: boolean; ageEnabled: boolean; vectorEnabled: boolean }> {
  try {
    const status = await inspectContainer();
    if (!status.exists) {
      return { running: false, containerExists: false, ageEnabled: false, vectorEnabled: false };
    }
    const ageEnabled = status.running ? await ageExtensionEnabled() : false;
    const vectorEnabled = status.running ? await vectorExtensionEnabled() : false;
    return { running: status.running, containerExists: true, ageEnabled, vectorEnabled };
  } catch {
    return { running: false, containerExists: false, ageEnabled: false, vectorEnabled: false };
  }
}

export async function dbReset(): Promise<void> {
  if (!(await confirmReset())) return;
  await runDockerOrThrow(['rm', '-f', CONTAINER_NAME]);
  await runDockerOrThrow(['volume', 'rm', VOLUME_NAME]);
  await dbStart();
}

export async function dbLogs(tail: number = 50): Promise<void> {
  await runDockerOrThrow(['logs', '--tail', String(tail), '--follow', CONTAINER_NAME], {
    stdio: 'inherit',
  });
}

export async function enableAgeExtension(): Promise<void> {
  await runDockerOrThrow([
    'exec',
    CONTAINER_NAME,
    'psql',
    '-U',
    'rorca',
    '-d',
    'rorca',
    '-c',
    'CREATE EXTENSION IF NOT EXISTS age; CREATE EXTENSION IF NOT EXISTS vector;',
  ]);
}
