/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execute } from '../../db/index';
import { getExecutionEnvironmentReadiness, hashRunnerToken, listExecutionEnvironments } from '../execution-environment-registry';

describe('execution-environment-registry', () => {
  it('seeds default remote and local execution environments', async () => {
    const envs = await listExecutionEnvironments();
    expect(envs.map((env) => env.id)).toEqual(expect.arrayContaining(['remote-rorca', 'local-user']));
  });

  it('fails local-user closed until a runner heartbeat is present', async () => {
    await execute(`UPDATE execution_environments SET last_heartbeat_at = NULL, metadata = '{}'::jsonb WHERE id = 'local-user'`);
    const readiness = await getExecutionEnvironmentReadiness('local-user');
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toBe('execution_runner_not_connected');
  });

  it('hashes runner tokens deterministically without returning the token', () => {
    const token = 'test-runner-token-that-is-long-enough';
    const hash = hashRunnerToken(token);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token);
    expect(hashRunnerToken(token)).toBe(hash);
  });
});
