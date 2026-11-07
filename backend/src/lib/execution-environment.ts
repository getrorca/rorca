/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { z } from 'zod';
import { UnprocessableError, ValidationError } from './errors';

/**
 * Where a pipeline run's implementation engine should execute.
 *
 * - remote-rorca: default. The server-side Rorca worker/container executes the
 *   selected engine CLI against the workspace/worktree mounted on that host.
 * - local-user: retained as a deprecated compatibility input only. The stable
 *   contract rejects it before any run/artifact/queue mutation because no signed
 *   host closeout/release protocol exists.
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
  if (parsed.data === 'local-user') {
    throw new UnprocessableError(
      'local-user execution is deprecated and unavailable; use remote-rorca',
      'LOCAL_USER_EXECUTION_UNAVAILABLE',
      { requestedExecutionEnvironment: 'local-user', availableExecutionEnvironments: ['remote-rorca'] },
    );
  }

  return {
    requested: parsed.data,
    effective: parsed.data,
    localBridgeUrl: env.RORCA_LOCAL_EXECUTION_BRIDGE_URL?.trim() || null,
  };
}

export async function assertExecutionEnvironmentReady(_resolution: ExecutionEnvironmentResolution): Promise<void> {
  // Legacy compatibility hook. Parsing already rejects unavailable local-user
  // before callers can perform workspace/run/artifact/queue mutations.
}
