/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

let storedCiphertext = '';
jest.mock('../../db/index', () => ({
  query: jest.fn(), execute: jest.fn(),
  queryOne: jest.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('INSERT INTO integration_vault_secrets')) {
      storedCiphertext = String(params[2]);
      return {
        id: params[0], provider: 'github_app', secret_kind: params[1], encrypted_value: params[2], fingerprint: params[3],
        created_at: '2026-07-17T12:00:00.000Z', rotated_at: null, revoked_at: null,
      };
    }
    return {
      id: params[0], provider: 'github_app', secret_kind: params[1], encrypted_value: storedCiphertext,
      fingerprint: `sha256:${'a'.repeat(64)}`, created_at: '2026-07-17T12:00:00.000Z', rotated_at: null, revoked_at: null,
    };
  }),
}));

process.env.JWT_SECRET = 'github-app-vault-test-secret';

import { getIntegrationSecret, storeIntegrationSecret } from '../integration-vault';
import { queryOne } from '../../db/index';

beforeEach(() => { storedCiphertext = ''; jest.clearAllMocks(); });

test('vaults App secrets without returning or persisting plaintext metadata', async () => {
  const plaintext = '-----BEGIN PRIVATE KEY-----\nopaque-value\n-----END PRIVATE KEY-----';
  const metadata = await storeIntegrationSecret('private_key', plaintext, 'operator@example.test');
  expect(storedCiphertext).not.toContain('opaque-value');
  expect(JSON.stringify(metadata)).not.toContain('opaque-value');
  expect(metadata.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  await expect(getIntegrationSecret(metadata.id, 'private_key')).resolves.toBe(plaintext);
  expect(JSON.stringify((queryOne as jest.Mock).mock.calls)).not.toContain(plaintext);
});
