/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

const mockCanonicalTransaction = jest.fn();

jest.mock('../../db', () => ({
  canonicalTransaction: (callback: unknown) => mockCanonicalTransaction(callback),
}));

import { PostgresManagedExecutorStore } from '../rorca-managed-executor-store';
import {
  WAVE3A_COMPLETION_MIGRATION,
  WAVE3A_SPEC_SHA,
  WAVE3A_WAVE2_IMPLEMENTATION_SHA,
  WAVE3A_WAVE2_MIGRATION_HEAD,
  loadCanonicalWave3AImplementationGate,
} from '../wave3a-managed-executor-gate';

type QueryClient = { query: jest.Mock };

function configureCanonicalClient(rows: unknown[]): QueryClient {
  const client: QueryClient = { query: jest.fn().mockResolvedValue({ rows }) };
  mockCanonicalTransaction.mockImplementation(async (callback: (value: QueryClient) => Promise<unknown>) => callback(client));
  return client;
}

describe('managed executor principal boundary', () => {
  beforeEach(() => {
    mockCanonicalTransaction.mockReset();
  });

  it('loads the immutable readiness receipt through the canonical connection', async () => {
    const client = configureCanonicalClient([{
      readiness: {
        contract_version: 'rorca.managed-executor.v1',
        wave2_implementation_git_sha: WAVE3A_WAVE2_IMPLEMENTATION_SHA,
        wave2_migration_head: WAVE3A_WAVE2_MIGRATION_HEAD,
        wave2_completion_migration: WAVE3A_COMPLETION_MIGRATION,
        wave3a_spec_sha256: WAVE3A_SPEC_SHA,
        migration_version: 20260804182000,
        state: 'ready',
      },
    }]);

    await expect(loadCanonicalWave3AImplementationGate()).resolves.toMatchObject({ accepted: true });
    expect(mockCanonicalTransaction).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('SELECT rorca.load_wave3a_readiness_v1() readiness');
  });

  it('uses the canonical connection for workspace-scoped recovery', async () => {
    const client = configureCanonicalClient([]);
    const store = new PostgresManagedExecutorStore('workspace:managed-test');

    await expect(store.listRecoverable(3)).resolves.toEqual([]);
    expect(mockCanonicalTransaction).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenNthCalledWith(1, "SELECT set_config('rorca.workspace_id',$1,TRUE)", ['workspace:managed-test']);
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      'SELECT value FROM rorca.list_recoverable_managed_executor_generations_v1($1,$2) value',
      ['workspace:managed-test', 3],
    );
  });
});
