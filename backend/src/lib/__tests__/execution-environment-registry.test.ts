/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { getExecutionEnvironmentReadiness, hashRunnerToken, listExecutionEnvironments } from '../execution-environment-registry';

describe('execution-environment-registry', () => {
  it('seeds only the Release-1 remote Rorca execution environment', async () => {
    const envs = await listExecutionEnvironments();
    expect(envs.map((env) => env.id)).toContain('remote-rorca');
    expect(envs.map((env) => env.id)).not.toContain('local-user');
  });

  it('does not synthesize a deprecated local-user bridge from runtime state', async () => {
    await expect(getExecutionEnvironmentReadiness('local-user')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('hashes runner tokens deterministically without returning the token', () => {
    const token = 'test-runner-token-that-is-long-enough';
    const hash = hashRunnerToken(token);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token);
    expect(hashRunnerToken(token)).toBe(hash);
  });
});
