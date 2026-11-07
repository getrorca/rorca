/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const runtimeUrl = process.env.DATABASE_URL;
const writerUrl = process.env.RORCA_CANONICAL_WRITER_DATABASE_URL;
if (!runtimeUrl || !writerUrl) {
  throw new Error('Split isolated runtime and canonical-writer database URLs are required');
}

const runtime = new Pool({ connectionString: runtimeUrl, max: 1, options: '--search_path=rorca,public' });
const writer = new Pool({ connectionString: writerUrl, max: 1, options: '--search_path=rorca_canonical_api,rorca,public' });

interface BindingFixture {
  id: string;
  providerAccountId: string;
  mode: 'test' | 'live';
  credentialClass: 'restricted_api_key' | 'unrestricted_api_key' | 'webhook_signing_secret';
  keyKind: 'restricted' | 'unrestricted' | 'signing_secret';
  fingerprint: string;
  secretStoreReference: string;
  targetBindingReference: string;
}

function bindingFixture(overrides: Partial<BindingFixture> = {}): BindingFixture {
  const id = randomUUID();
  return {
    providerAccountId: `acct_${id}`,
    id,
    mode: 'test',
    credentialClass: 'restricted_api_key',
    keyKind: 'restricted',
    fingerprint: `sha256:${createHash('sha256').update(id).digest('hex')}`,
    secretStoreReference: `secret-store://rorca/${id}`,
    targetBindingReference: `runtime-binding://rorca/${id}`,
    ...overrides,
  };
}

async function insertBinding(pool: Pool, fixture: BindingFixture): Promise<void> {
  await pool.query(
    `INSERT INTO rorca.provider_credential_bindings (
       id, workspace_id, provider, provider_account_id, mode, application_id,
       resource_type, resource_id, credential_class, key_kind,
       permission_manifest, owner, fingerprint, secret_store_reference,
       target_binding_reference, status, binding_generation, last_verified_at
     ) VALUES (
       $1, 'workspace:wave-two', 'stripe', $8, $2,
       'rorca-disposable-payments', 'payment_intents', 'fixture-target', $3, $4,
       '["payment_intents.read"]'::jsonb, 'rorca-test-operator', $5, $6, $7,
       'active', 1, '2026-08-21T09:30:00.000Z'
     )`,
    [
      fixture.id,
      fixture.mode,
      fixture.credentialClass,
      fixture.keyKind,
      fixture.fingerprint,
      fixture.secretStoreReference,
      fixture.targetBindingReference,
      fixture.providerAccountId,
    ],
  );
}

afterAll(async () => {
  await Promise.all([runtime.end(), writer.end()]);
});

describe('provider credential binding persistence', () => {
  test('stores only secret-free inventory metadata and gives runtime read-only access', async () => {
    const fixture = bindingFixture();
    await insertBinding(writer, fixture);

    const result = await runtime.query(
      `SELECT provider_account_id, mode, application_id, resource_type, resource_id,
              credential_class, key_kind, permission_manifest, owner, fingerprint,
              secret_store_reference, target_binding_reference, status,
              binding_generation::integer, last_verified_at
         FROM rorca.provider_credential_bindings
        WHERE id = $1`,
      [fixture.id],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      provider_account_id: fixture.providerAccountId,
      mode: 'test',
      application_id: 'rorca-disposable-payments',
      resource_type: 'payment_intents',
      resource_id: 'fixture-target',
      credential_class: 'restricted_api_key',
      key_kind: 'restricted',
      permission_manifest: ['payment_intents.read'],
      owner: 'rorca-test-operator',
      fingerprint: fixture.fingerprint,
      secret_store_reference: fixture.secretStoreReference,
      target_binding_reference: fixture.targetBindingReference,
      status: 'active',
      binding_generation: 1,
    });
    expect(result.rows[0].last_verified_at).toBeInstanceOf(Date);
    expect(JSON.stringify(result.rows)).not.toMatch(/(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/);

    await expect(insertBinding(runtime, bindingFixture())).rejects.toMatchObject({ code: '42501' });
  });

  test.each([
    ['SecretStore reference', 'secretStoreReference'] as const,
    ['fingerprint', 'fingerprint'] as const,
    ['target-binding reference', 'targetBindingReference'] as const,
  ])('rejects cross-mode reuse of a %s', async (_label, reusedField) => {
    const testBinding = bindingFixture();
    await insertBinding(writer, testBinding);
    const liveBinding = bindingFixture({ mode: 'live', [reusedField]: testBinding[reusedField] });

    await expect(insertBinding(writer, liveBinding)).rejects.toMatchObject({ code: '23505' });
  });

  test('rejects credential-shaped values without persisting or echoing them', async () => {
    const credentialValue = ['sk', 'test', 'notarealcredential'].join('_');
    const fixture = bindingFixture({ secretStoreReference: `secret-store://rorca/${credentialValue}` });

    await expect(insertBinding(writer, fixture)).rejects.toMatchObject({
      message: 'credential-shaped values are forbidden in provider credential bindings',
    });
    const persisted = await runtime.query(
      'SELECT COUNT(*)::integer AS count FROM rorca.provider_credential_bindings WHERE id = $1',
      [fixture.id],
    );
    expect(persisted.rows).toEqual([{ count: 0 }]);
  });

  test('allows status and verification updates but keeps binding identity immutable', async () => {
    const fixture = bindingFixture();
    await insertBinding(writer, fixture);

    await writer.query(
      `UPDATE rorca.provider_credential_bindings
          SET status = 'quarantined', last_verified_at = '2026-08-21T10:00:00.000Z'
        WHERE id = $1`,
      [fixture.id],
    );
    await expect(writer.query(
      `UPDATE rorca.provider_credential_bindings
          SET mode = 'live'
        WHERE id = $1`,
      [fixture.id],
    )).rejects.toMatchObject({
      message: 'provider credential binding identity and generation are immutable',
    });

    const result = await runtime.query(
      'SELECT mode, status, last_verified_at FROM rorca.provider_credential_bindings WHERE id = $1',
      [fixture.id],
    );
    expect(result.rows[0]).toMatchObject({ mode: 'test', status: 'quarantined' });
    expect(result.rows[0].last_verified_at).toEqual(new Date('2026-08-21T10:00:00.000Z'));
  });
});
