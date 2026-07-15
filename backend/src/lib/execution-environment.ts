/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { z } from 'zod';

export const EXECUTION_ENVIRONMENT_VALUES = ['remote-rorca', 'local-user'] as const;

export type ExecutionEnvironment = (typeof EXECUTION_ENVIRONMENT_VALUES)[number];

export const DEFAULT_EXECUTION_ENVIRONMENT: ExecutionEnvironment = 'remote-rorca';

export const ExecutionEnvironmentSchema = z.enum(EXECUTION_ENVIRONMENT_VALUES);

export function isExecutionEnvironment(value: unknown): value is ExecutionEnvironment {
  return value === 'remote-rorca' || value === 'local-user';
}

export function normalizeExecutionEnvironment(value: string | null | undefined): ExecutionEnvironment {
  return value === 'local-user' ? 'local-user' : DEFAULT_EXECUTION_ENVIRONMENT;
}
