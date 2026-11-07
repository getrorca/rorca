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

  it('retains local-user parsing compatibility but rejects it before readiness/mutation', async () => {
    expect(() => resolveExecutionEnvironment('local-user', {})).toThrow(expect.objectContaining({
      statusCode: 422,
      code: 'LOCAL_USER_EXECUTION_UNAVAILABLE',
    }));
    await expect(assertExecutionEnvironmentReady(resolveExecutionEnvironment('remote-rorca', {}))).resolves.toBeUndefined();
  });

  it('rejects invalid execution environments', () => {
    expect(() => resolveExecutionEnvironment('somewhere-else', {})).toThrow(/Invalid executionEnvironment/);
  });
});
