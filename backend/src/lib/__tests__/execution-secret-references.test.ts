/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

jest.mock('../../routes/env-vars', () => ({ getWorkspaceEnvVars: jest.fn() }));
jest.mock('../../routes/vault', () => ({ getVaultKey: jest.fn() }));

import { getWorkspaceEnvVars } from '../../routes/env-vars';
import { getVaultKey } from '../../routes/vault';
import { createExecutionSecretReferences, redactExecutionJobPayload, redactSecretText, resolveExecutionSecrets } from '../execution-secret-references';

const mockedWorkspaceEnv = getWorkspaceEnvVars as jest.Mock;
const mockedVault = getVaultKey as jest.Mock;

describe('execution secret references', () => {
  beforeEach(() => jest.resetAllMocks());

  it('serializes opaque references and resolves provider/workspace values only at spawn time', async () => {
    const refs = createExecutionSecretReferences({ workspaceId: 'ws-1', vaultUserId: 'user-1', providers: ['anthropic'] });
    expect(JSON.stringify(refs)).not.toContain('sk-ant-');
    mockedWorkspaceEnv.mockResolvedValue({ WORKSPACE_SECRET: 'workspace-secret' });
    mockedVault.mockResolvedValue({ key: 'sk-ant-real-secret' });

    await expect(resolveExecutionSecrets(refs)).resolves.toEqual({
      WORKSPACE_SECRET: 'workspace-secret', ANTHROPIC_API_KEY: 'sk-ant-real-secret',
    });
    expect(mockedWorkspaceEnv).toHaveBeenCalledWith('ws-1');
    expect(mockedVault).toHaveBeenCalledWith('user-1', 'anthropic');
  });

  it('redacts queue logs and hook output without retaining plaintext credentials', () => {
    const payload = { runId: 7, envOverrides: { ANTHROPIC_API_KEY: 'sk-ant-real-secret' }, secretReferences: createExecutionSecretReferences({ workspaceId: 'ws-1' }) };
    const logPayload = JSON.stringify(redactExecutionJobPayload(payload));
    expect(logPayload).not.toContain('sk-ant-real-secret');
    expect(logPayload).toContain('[redacted]');
    expect(redactSecretText('provider=sk-ant-real-secret', { ANTHROPIC_API_KEY: 'sk-ant-real-secret' }))
      .toBe('provider=[REDACTED]');
  });
});
