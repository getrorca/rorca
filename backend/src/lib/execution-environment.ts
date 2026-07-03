/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { z } from 'zod';
import { ValidationError } from './errors';

/**
 * Where a pipeline run's implementation engine should execute.
 *
 * - remote-rorca: default. The server-side Rorca worker/container executes the
 *   selected engine CLI against the workspace/worktree mounted on that host.
 * - local-user: reserved for a user-local runner/bridge that executes with the
 *   user's local CLI installs/auth. It intentionally fails closed unless a local
 *   execution bridge URL is configured and reachable.
 */
export const ExecutionEnvironmentSchema = z.enum(['remote-rorca', 'local-user']);
export type ExecutionEnvironment = z.infer<typeof ExecutionEnvironmentSchema>;

export interface ExecutionEnvironmentResolution {
  requested: ExecutionEnvironment;
  effective: ExecutionEnvironment;
  localBridgeUrl: string | null;
}

export function resolveExecutionEnvironment(input: unknown, env: NodeJS.ProcessEnv = process.env): ExecutionEnvironmentResolution {
  const fallback = (env.RORCA_EXECUTION_ENVIRONMENT ?? 'remote-rorca').trim();
  const raw = input === undefined || input === null || input === '' ? fallback : input;
  const parsed = ExecutionEnvironmentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid executionEnvironment. Expected one of: remote-rorca, local-user');
  }

  return {
    requested: parsed.data,
    effective: parsed.data,
    localBridgeUrl: env.RORCA_LOCAL_EXECUTION_BRIDGE_URL?.trim() || null,
  };
}

export async function assertExecutionEnvironmentReady(_resolution: ExecutionEnvironmentResolution): Promise<void> {
  // Legacy compatibility hook. Full readiness is evaluated after agent/model
  // resolution by execution-environment-registry.ts so local-user can be backed
  // by either the old bridge URL or the new outbound runner registry.
}
