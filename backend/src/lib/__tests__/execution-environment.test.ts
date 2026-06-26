/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { assertExecutionEnvironmentReady, resolveExecutionEnvironment } from '../execution-environment';

describe('execution-environment', () => {
  it('defaults to remote-rorca', () => {
    const resolution = resolveExecutionEnvironment(undefined, {});
    expect(resolution.effective).toBe('remote-rorca');
    expect(resolution.localBridgeUrl).toBeNull();
  });

  it('accepts explicit local-user but fails closed without a bridge', async () => {
    const resolution = resolveExecutionEnvironment('local-user', {});
    expect(resolution.effective).toBe('local-user');
    await expect(assertExecutionEnvironmentReady(resolution)).rejects.toThrow('local_user_execution_bridge_not_configured');
  });

  it('rejects invalid execution environments', () => {
    expect(() => resolveExecutionEnvironment('somewhere-else', {})).toThrow(/Invalid executionEnvironment/);
  });
});
