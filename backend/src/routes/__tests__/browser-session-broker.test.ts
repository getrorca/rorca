/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { BrowserProfileProviderBinding } from '../../lib/authority-provider-adapter';
import {
  BrowserAuthenticationResolutionSchema,
  BrowserProfileEnrollmentMetadataSchema,
  BrowserSessionRequestSchema,
  CreateBrowserSessionGrantSchema,
  type BrowserProfileBindingRecord,
  type BrowserAuthenticationRequestRecord,
  type BrowserSessionGrantRecord,
  type BrowserSessionLeaseRecord,
} from '../../lib/browser-session-broker';
import {
  BrowserProfileLifecycleRequestSchema,
  projectBrowserProfileEnrollment,
  projectBrowserAuthenticationRequest,
  projectBrowserSessionGrant,
  projectBrowserSessionLease,
  projectSettledBrowserProfile,
} from '../browser-session-broker';

const VALID_ENROLLMENT = {
  workspaceId: 'workspace-browser-tests',
  externalProvider: 'claude',
  accountAlias: 'claude-conformance',
  allowedOrigins: ['https://claude.ai', 'https://fixture.rorca.test'],
  retentionPolicy: { mode: 'quarantine', retainUntil: null },
  destructionPolicy: 'operator_delete',
} as const;

describe('browser session broker route boundary', () => {
  it('accepts only metadata needed for operator-controlled enrollment', () => {
    expect(BrowserProfileEnrollmentMetadataSchema.parse(VALID_ENROLLMENT)).toEqual(VALID_ENROLLMENT);
  });

  it.each([
    'password',
    'cookie',
    'cookies',
    'totpSeed',
    'passkeyPrivateMaterial',
    'recoveryCode',
    'profile',
    'profileBytes',
  ])('rejects secret or profile field %s instead of admitting it to an API body', (field) => {
    expect(BrowserProfileEnrollmentMetadataSchema.safeParse({
      ...VALID_ENROLLMENT,
      [field]: 'must-never-cross-http',
    }).success).toBe(false);
  });

  it('rejects credential-bearing, navigation-shaped, and duplicate origins', () => {
    for (const origin of [
      'https://operator:secret@claude.ai',
      'https://claude.ai/login',
      'https://claude.ai/?token=secret',
      'http://claude.ai',
    ]) {
      expect(BrowserProfileEnrollmentMetadataSchema.safeParse({
        ...VALID_ENROLLMENT,
        allowedOrigins: [origin],
      }).success).toBe(false);
    }
    expect(BrowserProfileEnrollmentMetadataSchema.safeParse({
      ...VALID_ENROLLMENT,
      allowedOrigins: ['http://127.0.0.1:4317'],
    }).success).toBe(true);
    expect(BrowserProfileEnrollmentMetadataSchema.safeParse({
      ...VALID_ENROLLMENT,
      allowedOrigins: ['https://claude.ai', 'https://CLAUDE.AI'],
    }).success).toBe(false);
  });

  it('keeps quarantine and deletion reasons disjoint at the route contract', () => {
    expect(BrowserProfileLifecycleRequestSchema.safeParse({
      workspaceId: 'workspace-browser-tests',
      reason: 'operator_quarantine',
      profileBytes: 'forbidden',
    }).success).toBe(false);
    expect(BrowserProfileLifecycleRequestSchema.safeParse({
      workspaceId: 'workspace-browser-tests',
      reason: 'operator_delete',
    }).success).toBe(true);
  });

  it('returns metadata-only enrollment and lifecycle projections', () => {
    const secretRef = '11111111-1111-4111-8111-111111111111';
    const pending: BrowserProfileBindingRecord = {
      id: '22222222-2222-4222-8222-222222222222',
      workspaceId: VALID_ENROLLMENT.workspaceId,
      externalProvider: 'claude',
      accountAlias: VALID_ENROLLMENT.accountAlias,
      allowedOrigins: [...VALID_ENROLLMENT.allowedOrigins],
      profileGeneration: 1,
      profileSecretRef: secretRef,
      lifecycleState: 'pending',
      bindingStatus: 'disabled',
      providerHealth: 'degraded',
      sessionHealth: 'unknown',
      healthObservedAt: '2026-08-21T12:00:00.000Z',
      retentionMode: 'quarantine',
      retainUntil: null,
      destructionPolicy: 'operator_delete',
      enrollmentProvenance: {
        kind: 'human_operator',
        operatorId: 'operator-7',
        surface: 'operator_takeover',
        enrolledAt: '2026-08-21T12:00:00.000Z',
      },
    };
    const quarantined: BrowserProfileProviderBinding = {
      providerId: 'browser-session',
      bindingId: pending.id,
      workspaceId: pending.workspaceId,
      bindingStatus: 'disabled',
      externalProvider: pending.externalProvider,
      accountAlias: pending.accountAlias,
      allowedOrigins: pending.allowedOrigins,
      profileGeneration: pending.profileGeneration,
      profileStatus: 'quarantined',
      retentionPolicy: { mode: pending.retentionMode, retainUntil: pending.retainUntil },
      destructionPolicy: pending.destructionPolicy,
      enrollmentProvenance: pending.enrollmentProvenance,
      health: {
        provider: pending.providerHealth,
        session: pending.sessionHealth,
        observedAt: pending.healthObservedAt,
      },
      secretReferences: [{ purpose: 'browser-profile-artifact', secretId: secretRef }],
      providerProfileVerified: false,
    };

    const enrollmentProjection = projectBrowserProfileEnrollment(pending);
    expect(enrollmentProjection.profileSecretRef).toBeUndefined();
    expect(JSON.stringify(enrollmentProjection)).not.toContain(secretRef);

    const lifecycleProjection = projectSettledBrowserProfile(quarantined);
    expect(lifecycleProjection.secretReferences).toBeUndefined();
    expect(JSON.stringify(lifecycleProjection)).not.toContain(secretRef);
  });

  it('accepts metadata-only bounded grants and projects leases without profile references or paths', () => {
    const grantInput = {
      bindingId: '22222222-2222-4222-8222-222222222222',
      workspaceId: VALID_ENROLLMENT.workspaceId,
      externalProvider: 'claude' as const,
      runId: 'run-browser-42',
      storyId: 'BSB-002',
      purpose: 'provider-mcp-conformance',
      profileGeneration: 1,
      allowedOrigins: [...VALID_ENROLLMENT.allowedOrigins],
      allowedActions: ['navigate', 'readText'] as const,
      maximumConcurrentRunners: 1,
      expiresAt: '2026-08-21T12:10:00.000Z',
      evidenceContract: {
        schemaVersion: 'rorca.browser-session-evidence.v1',
        requiredEvidence: ['network_metadata', 'security_event'] as const,
        redaction: 'required' as const,
      },
    };
    expect(CreateBrowserSessionGrantSchema.safeParse({
      ...grantInput,
      profilePath: '/secret/browser-profile',
    }).success).toBe(false);
    const parsedGrant = CreateBrowserSessionGrantSchema.parse(grantInput);
    const grant: BrowserSessionGrantRecord = {
      ...parsedGrant,
      id: '33333333-3333-4333-8333-333333333333',
      state: 'active',
      issuedAt: '2026-08-21T12:00:00.000Z',
      revokedAt: null,
      revocationReason: null,
      retentionMode: 'preserve',
      retainUntil: null,
      destructionPolicy: 'operator_delete',
    };
    const request = BrowserSessionRequestSchema.parse({
      grantId: grant.id,
      bindingId: grant.bindingId,
      workspaceId: grant.workspaceId,
      externalProvider: grant.externalProvider,
      runId: grant.runId,
      storyId: grant.storyId,
      purpose: grant.purpose,
      profileGeneration: grant.profileGeneration,
      allowedOrigins: grant.allowedOrigins,
      allowedActions: grant.allowedActions,
      expiresAt: '2026-08-21T12:05:00.000Z',
    });
    const lease: BrowserSessionLeaseRecord = {
      ...request,
      id: '44444444-4444-4444-8444-444444444444',
      state: 'active',
      runnerId: '55555555-5555-4555-8555-555555555555',
      issuedAt: '2026-08-21T12:00:00.000Z',
      lastHeartbeatAt: '2026-08-21T12:00:00.000Z',
      revokedAt: null,
      revocationReason: null,
      maximumConcurrentRunners: grant.maximumConcurrentRunners,
      evidenceContract: grant.evidenceContract,
      retentionMode: grant.retentionMode,
      retainUntil: grant.retainUntil,
      destructionPolicy: grant.destructionPolicy,
    };

    const projection = JSON.stringify([
      projectBrowserSessionGrant(grant),
      projectBrowserSessionLease(lease),
    ]);
    expect(projection).not.toMatch(/secretReferences|profileSecretRef|profilePath|profileBytes|cookie/i);
    expect(projection).toContain('fresh-non-persistent-context');
    expect(projection).toContain('exact-origin');
  });

  it('projects a metadata-only takeover and accepts no client-supplied completion evidence', () => {
    expect(BrowserAuthenticationResolutionSchema.safeParse({
      workspaceId: VALID_ENROLLMENT.workspaceId,
      runId: 'run-browser-42',
      decision: 'complete',
      health: { provider: 'healthy', session: 'healthy' },
    }).success).toBe(false);
    expect(BrowserAuthenticationResolutionSchema.safeParse({
      workspaceId: VALID_ENROLLMENT.workspaceId,
      runId: 'run-browser-42',
      decision: 'complete',
      password: 'must-not-cross-http',
    }).success).toBe(false);

    const request: BrowserAuthenticationRequestRecord = {
      requestId: '66666666-6666-4666-8666-666666666666',
      leaseId: '44444444-4444-4444-8444-444444444444',
      bindingId: '22222222-2222-4222-8222-222222222222',
      workspaceId: VALID_ENROLLMENT.workspaceId,
      externalProvider: 'claude',
      runId: 'run-browser-42',
      storyId: 'BSB-003',
      purpose: 'provider-mcp-conformance',
      profileGeneration: 1,
      step: 'passkey',
      evidence: {
        schemaVersion: 'rorca.browser-authentication-observation.v1',
        step: 'passkey',
        observedAt: '2026-08-21T12:00:00.000Z',
        currentOrigin: 'https://claude.ai',
        signal: 'passkey_prompt',
        providerStateDigest: `sha256:${'1'.repeat(64)}`,
        accessibilityDigest: `sha256:${'2'.repeat(64)}`,
        screenshotDigest: `sha256:${'3'.repeat(64)}`,
        automationPolicy: 'human_only',
        redaction: 'required',
      },
      checkpointDigest: `sha256:${'4'.repeat(64)}`,
      detectedAt: '2026-08-21T12:00:00.000Z',
      authenticationExpiresAt: '2026-08-21T12:05:00.000Z',
      state: 'WAITING_FOR_AUTHENTICATION',
      disposition: null,
      outcomeCode: null,
      runPauseOwned: true,
      resumeCount: 0,
      resolutionObservation: null,
      resolvedBy: null,
      resolvedAt: null,
      resumedAt: null,
    };
    const projection = projectBrowserAuthenticationRequest(request);
    expect(projection).toMatchObject({
      requestId: request.requestId,
      externalProvider: 'claude',
      storyId: 'BSB-003',
      purpose: request.purpose,
      step: 'passkey',
      state: 'WAITING_FOR_AUTHENTICATION',
      operatorTakeover: {
        modelControl: 'suspended',
        automationControl: 'suspended',
        completionVerification: 'trusted-provider-state-required',
        allowedActions: ['complete', 'cancel'],
      },
    });
    expect(JSON.stringify(projection)).not.toMatch(/checkpointDigest|runnerId|recoveryEndpoint|password|cookie|totpSeed/i);
  });
});
