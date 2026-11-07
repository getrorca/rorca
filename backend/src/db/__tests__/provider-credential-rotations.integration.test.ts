/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  createStripeRotationIntent,
  stripeRotationIntentAuthorityInput,
  stripeRotationIntentPayload,
  stripeRotationIntentDigest,
  type StripeRotationIntent,
  type StripeRotationIntentInput,
} from '../../lib/stripe-credential-rotation';
import type { StripeProviderBinding } from '../../lib/stripe-authority-provider-adapter';
import { stableWalJson } from '../../lib/trusted-wal';

const runtimeUrl = process.env.DATABASE_URL;
const writerUrl = process.env.RORCA_CANONICAL_WRITER_DATABASE_URL;
if (!runtimeUrl || !writerUrl) {
  throw new Error('Split isolated runtime and canonical-writer database URLs are required');
}

const runtime = new Pool({ connectionString: runtimeUrl, max: 1, options: '--search_path=rorca,public' });
const writer = new Pool({ connectionString: writerUrl, max: 1, options: '--search_path=rorca_canonical_api,rorca,public' });
const WORKSPACE_ID = 'workspace:wave-two';

function fixture(): { binding: StripeProviderBinding; intent: StripeRotationIntent } {
  const bindingId = randomUUID();
  const binding: StripeProviderBinding = {
    providerId: 'stripe',
    bindingId,
    workspaceId: WORKSPACE_ID,
    accountId: `acct_rorca_rotation_${bindingId}`,
    mode: 'test',
    scope: {
      applicationId: 'rorca-disposable-payments',
      resourceType: 'payment_intents',
      resourceId: `fixture-${bindingId}`,
    },
    credentialClass: 'restricted_api_key',
    keyKind: 'restricted',
    permissionManifest: ['payment_intents.read'],
    owner: 'rorca-test-operator',
    fingerprint: `sha256:${createHash('sha256').update(`current:${bindingId}`).digest('hex')}`,
    secretStoreReference: `secret-store://rorca/${bindingId}`,
    targetBindingReference: `runtime-binding://rorca/${bindingId}`,
    status: 'active',
    generation: 1,
    lastVerifiedAt: '2026-08-23T09:30:00.000Z',
  };
  const input: StripeRotationIntentInput = {
    workspaceId: WORKSPACE_ID,
    bindingId,
    accountId: binding.accountId,
    currentFingerprint: binding.fingerprint,
    permissionManifest: [...binding.permissionManifest],
    mode: 'test',
    targetBindingReference: binding.targetBindingReference,
    replacementCredentialClass: 'restricted_api_key',
    canary: {
      operation: 'payment_intents.read',
      resourceType: 'payment_intents',
      resourceId: 'disposable-canary',
      timeoutMs: 10_000,
    },
    gracePeriodSeconds: 300,
    rollback: {
      strategy: 'restore_previous_binding',
      keepPriorCredentialActive: true,
      quarantineReplacement: true,
      verificationTimeoutMs: 10_000,
    },
    humanSteps: {
      dashboardReauthentication: 'required',
      restrictedKeyCreation: 'required',
      mfaAutomation: 'forbidden',
      providerControlBypass: 'forbidden',
    },
  };
  const intent = createStripeRotationIntent({
    intentId: randomUUID(),
    intent: input,
    binding,
    approval: {
      schemaVersion: 'rorca.stripe-rotation-approval.v1',
      intentDigest: stripeRotationIntentDigest(input),
      authorityReceiptId: randomUUID(),
      approvedBy: 'operator:rorca-owner',
      approvedAt: '2026-08-23T09:59:00.000Z',
      expiresAt: '2026-08-23T10:30:00.000Z',
    },
    now: new Date('2026-08-23T10:00:00.000Z'),
  });
  return { binding, intent };
}

async function insertBinding(binding: StripeProviderBinding): Promise<void> {
  await writer.query(
    `INSERT INTO rorca.provider_credential_bindings (
       id, workspace_id, provider, provider_account_id, mode, application_id,
       resource_type, resource_id, credential_class, key_kind,
       permission_manifest, owner, fingerprint, secret_store_reference,
       target_binding_reference, status, binding_generation, last_verified_at
     ) VALUES ($1,$2,'stripe',$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,'active',$15,$16)`,
    [binding.bindingId, binding.workspaceId, binding.accountId, binding.mode,
      binding.scope.applicationId, binding.scope.resourceType, binding.scope.resourceId,
      binding.credentialClass, binding.keyKind, JSON.stringify(binding.permissionManifest),
      binding.owner, binding.fingerprint, binding.secretStoreReference,
      binding.targetBindingReference, binding.generation, binding.lastVerifiedAt],
  );
}

async function insertIntent(intent: StripeRotationIntent): Promise<void> {
  const authority = stripeRotationIntentPayload(stripeRotationIntentAuthorityInput(intent));
  await writer.query(
    `INSERT INTO rorca.provider_credential_rotation_intents (
       id, workspace_id, provider, binding_id, provider_account_id, mode,
       current_fingerprint, permission_manifest, target_binding_reference,
       intent_digest, intent_canonical_bytes, intent_authority_payload,
       intent_payload, approval_digest, approval_receipt_id, state,
       active_timeout_elapsed_ms, waiting_started_at, resume_count
     ) VALUES ($1,$2,'stripe',$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12::jsonb,
               $9,$13,'WAITING_FOR_AUTHENTICATION',0,$14,0)`,
    [intent.intentId, intent.workspaceId, intent.bindingId, intent.accountId,
      intent.mode, intent.currentFingerprint, JSON.stringify(intent.permissionManifest),
      intent.targetBindingReference, intent.intentDigest,
      Buffer.from(stableWalJson(authority), 'utf8'), JSON.stringify(authority),
      JSON.stringify(intent), intent.approval.authorityReceiptId, intent.createdAt],
  );
}

afterAll(async () => {
  await Promise.all([runtime.end(), writer.end()]);
});

describe('provider credential rotation persistence', () => {
  test('persists immutable approved authority and exposes only paused secret-free state to runtime', async () => {
    const { binding, intent } = fixture();
    await insertBinding(binding);
    await insertIntent(intent);

    const result = await runtime.query(
      `SELECT intent_digest, state, timeout_disposition,
              active_timeout_elapsed_ms::integer, resume_count, intent_payload
         FROM rorca.provider_credential_rotation_intents
        WHERE id = $1`,
      [intent.intentId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      intent_digest: intent.intentDigest,
      state: 'WAITING_FOR_AUTHENTICATION',
      timeout_disposition: 'paused',
      active_timeout_elapsed_ms: 0,
      resume_count: 0,
    });
    expect(JSON.stringify(result.rows[0])).not.toMatch(/(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/);
    await expect(runtime.query(
      'UPDATE rorca.provider_credential_rotation_intents SET mode = $2 WHERE id = $1',
      [intent.intentId, 'live'],
    )).rejects.toMatchObject({ code: '42501' });
    await expect(writer.query(
      'UPDATE rorca.provider_credential_rotation_intents SET mode = $2 WHERE id = $1',
      [intent.intentId, 'live'],
    )).rejects.toMatchObject({ message: 'provider credential rotation intent authority is immutable' });
  });

  test('stores ciphertext behind writer-only isolation and permits one exact timeout-preserving resume', async () => {
    const { binding, intent } = fixture();
    await insertBinding(binding);
    await insertIntent(intent);
    const secretObjectId = randomUUID();
    const replacementFingerprint = `sha256:${createHash('sha256').update(`replacement:${secretObjectId}`).digest('hex')}`;
    const evidence = {
      schemaVersion: 'rorca.stripe-dashboard-evidence.v1',
      evidenceId: randomUUID(),
      intentDigest: intent.intentDigest,
      workspaceId: intent.workspaceId,
      accountId: intent.accountId,
      mode: intent.mode,
      targetBindingReference: intent.targetBindingReference,
      permissionManifest: intent.permissionManifest,
      keyKind: 'restricted',
      replacementFingerprint,
      dashboardSessionReference: 'stripe-dashboard-session://rorca/integration-evidence',
      dashboardReauthenticatedAt: '2026-08-23T10:01:00.000Z',
      restrictedKeyCreatedAt: '2026-08-23T10:02:00.000Z',
      operatorId: 'operator:stripe-owner',
      attestationKeyId: 'integration-attestation-key',
      signature: 'a'.repeat(86),
    };
    const canonicalEvidence = Buffer.from(stableWalJson(evidence), 'utf8');
    const evidenceDigest = `sha256:${createHash('sha256').update(canonicalEvidence).digest('hex')}`;
    const captureReference = `credential-capture://rorca/${secretObjectId}`;
    const provenance = {
      schemaVersion: 'rorca.stripe-capture-provenance.v1',
      captureReceiptReference: captureReference,
      provider: 'stripe',
      channel: 'trusted_local_operator',
      providerEvidenceId: evidence.evidenceId,
      operatorId: evidence.operatorId,
      capturedAt: '2026-08-23T10:03:00.000Z',
      targetBindingReference: intent.targetBindingReference,
    };
    const captureResult = {
      reference: `secret-store://rorca/provider-credentials/${secretObjectId}`,
      fingerprint: replacementFingerprint,
      provenance,
    };

    await writer.query(
      `INSERT INTO rorca.provider_credential_secret_objects (
         id, rotation_intent_id, intent_digest, workspace_id, provider,
         provider_account_id, mode, credential_class, permission_manifest,
         target_binding_reference, encrypted_value, encryption_iv,
         encryption_auth_tag, fingerprint, provider_evidence,
         provider_evidence_canonical_bytes, provider_evidence_digest,
         provenance, status
       ) VALUES ($1,$2,$3,$4,'stripe',$5,$6,'restricted_api_key',$7::jsonb,$8,
                 $9,$10,$11,$12,$13::jsonb,$14,$15,$16::jsonb,'captured')`,
      [secretObjectId, intent.intentId, intent.intentDigest, intent.workspaceId,
        intent.accountId, intent.mode, JSON.stringify(intent.permissionManifest),
        intent.targetBindingReference, Buffer.from('encrypted-fixture'), Buffer.alloc(12, 1),
        Buffer.alloc(16, 2), replacementFingerprint, JSON.stringify(evidence),
        canonicalEvidence, evidenceDigest, JSON.stringify(provenance)],
    );
    await expect(runtime.query(
      'SELECT id FROM rorca.provider_credential_secret_objects WHERE id = $1',
      [secretObjectId],
    )).rejects.toMatchObject({ code: '42501' });

    await writer.query(
      `UPDATE rorca.provider_credential_rotation_intents
          SET state = 'READY_FOR_STAGING', timeout_disposition = 'running',
              resumed_at = '2026-08-23T15:00:00.000Z', resume_count = 1,
              provider_evidence_digest = $2, capture_receipt_reference = $3,
              capture_result = $4::jsonb
        WHERE id = $1`,
      [intent.intentId, evidenceDigest, captureReference, JSON.stringify(captureResult)],
    );
    const resumed = await runtime.query(
      `SELECT state, timeout_disposition, active_timeout_elapsed_ms::integer,
              resume_count, capture_result
         FROM rorca.provider_credential_rotation_intents WHERE id = $1`,
      [intent.intentId],
    );
    expect(resumed.rows[0]).toMatchObject({
      state: 'READY_FOR_STAGING',
      timeout_disposition: 'running',
      active_timeout_elapsed_ms: 0,
      resume_count: 1,
      capture_result: captureResult,
    });
    await expect(writer.query(
      `UPDATE rorca.provider_credential_rotation_intents
          SET resumed_at = '2026-08-23T16:00:00.000Z'
        WHERE id = $1`,
      [intent.intentId],
    )).rejects.toMatchObject({ message: 'provider credential rotation intent resume transition is invalid' });
  });

  test('rejects broader capture metadata and credential values before persistence', async () => {
    const { binding, intent } = fixture();
    await insertBinding(binding);
    await insertIntent(intent);
    const objectId = randomUUID();
    const credential = ['rk', 'test', 'notarealcredential'].join('_');
    const evidence = {
      intentDigest: intent.intentDigest,
      workspaceId: intent.workspaceId,
      accountId: intent.accountId,
      mode: intent.mode,
      targetBindingReference: intent.targetBindingReference,
      permissionManifest: ['payment_intents.read', 'customers.write'],
      keyKind: 'restricted',
      replacementFingerprint: `sha256:${'f'.repeat(64)}`,
      evidenceId: randomUUID(),
      signature: 'a'.repeat(86),
    };
    const canonicalEvidence = Buffer.from(stableWalJson(evidence), 'utf8');
    const provenance = {
      captureReceiptReference: `credential-capture://rorca/${objectId}`,
      providerEvidenceId: evidence.evidenceId,
      targetBindingReference: `runtime-binding://rorca/${credential}`,
    };

    await expect(writer.query(
      `INSERT INTO rorca.provider_credential_secret_objects (
         id, rotation_intent_id, intent_digest, workspace_id, provider,
         provider_account_id, mode, credential_class, permission_manifest,
         target_binding_reference, encrypted_value, encryption_iv,
         encryption_auth_tag, fingerprint, provider_evidence,
         provider_evidence_canonical_bytes, provider_evidence_digest,
         provenance, status
       ) VALUES ($1,$2,$3,$4,'stripe',$5,$6,'restricted_api_key',$7::jsonb,$8,
                 $9,$10,$11,$12,$13::jsonb,$14,$15,$16::jsonb,'captured')`,
      [objectId, intent.intentId, intent.intentDigest, intent.workspaceId,
        intent.accountId, intent.mode, JSON.stringify(evidence.permissionManifest),
        intent.targetBindingReference, Buffer.from('encrypted-fixture'), Buffer.alloc(12, 1),
        Buffer.alloc(16, 2), evidence.replacementFingerprint, JSON.stringify(evidence),
        canonicalEvidence, `sha256:${createHash('sha256').update(canonicalEvidence).digest('hex')}`,
        JSON.stringify(provenance)],
    )).rejects.toMatchObject({
      message: expect.stringMatching(/does not match its waiting intent|credential-shaped values are forbidden/),
    });
  });
});
