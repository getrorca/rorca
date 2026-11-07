/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  DisposableCoolifyQualificationFixtureSchema,
  type DisposableCoolifyQualificationFixture,
} from '../../coolify-deployment-qualification';

export const QUALIFICATION_NOW = '2026-08-24T12:00:00.000Z';
export const QUALIFICATION_IDS = Object.freeze({
  run: '10000000-0000-4000-8000-000000000001',
  stagingBinding: '10000000-0000-4000-8000-000000000002',
  productionBinding: '10000000-0000-4000-8000-000000000003',
  project: '10000000-0000-4000-8000-000000000004',
  stagingApplication: '10000000-0000-4000-8000-000000000005',
  stagingEnvironment: '10000000-0000-4000-8000-000000000006',
  stagingSecretReference: '10000000-0000-4000-8000-000000000007',
  productionApplication: '10000000-0000-4000-8000-000000000008',
  productionEnvironment: '10000000-0000-4000-8000-000000000009',
  productionSecretReference: '10000000-0000-4000-8000-000000000010',
  operationIntent: '10000000-0000-4000-8000-000000000011',
  gateConfiguration: '10000000-0000-4000-8000-000000000012',
  gateEvidence: '10000000-0000-4000-8000-000000000013',
  stagingReceipt: '10000000-0000-4000-8000-000000000014',
});

const BASE_URL = 'https://qualification.coolify.rorca.invalid';
const PROFILE_VERIFIED_AT = '2026-08-24T11:30:00.000Z';
const PROFILE_EXPIRES_AT = '2026-08-24T14:00:00.000Z';

function verifiedProfile(input: {
  applicationUuid: string;
  environmentUuid: string;
  action: 'deploy.staging' | 'deploy.production';
}) {
  return {
    schemaVersion: 'rorca.coolify-verified-profile.v1' as const,
    providerVersion: 'fixture-v1',
    target: {
      project: { uuid: QUALIFICATION_IDS.project, numericId: null },
      application: { uuid: input.applicationUuid, numericId: null },
      environment: { uuid: input.environmentUuid, numericId: null },
    },
    principal: {
      subjectId: 'rorca-disposable-qualification',
      teamId: 'rorca-fixture-team',
      scopes: ['deploy'],
    },
    allowedActions: [input.action],
    verifiedAt: PROFILE_VERIFIED_AT,
    expiresAt: PROFILE_EXPIRES_AT,
  };
}

export function createDisposableCoolifyQualificationFixture(): DisposableCoolifyQualificationFixture {
  const intentDigest = `sha256:${'1'.repeat(64)}`;
  const ciEvidenceDigest = `sha256:${'2'.repeat(64)}`;
  const rolloutCohortDigest = `sha256:${'3'.repeat(64)}`;
  return DisposableCoolifyQualificationFixtureSchema.parse({
    schemaVersion: 'rorca.coolify-deployment-qualification-fixture.v1',
    qualificationRunId: QUALIFICATION_IDS.run,
    fixtureNamespace: 'rorca-disposable-coolify/cdp-006-fixture',
    fixtureOwner: 'rorca',
    fixturePurpose: 'disposable_qualification',
    workspaceId: 'qualification:coolify:cdp-006-fixture',
    staging: {
      binding: {
        providerId: 'coolify',
        bindingId: QUALIFICATION_IDS.stagingBinding,
        workspaceId: 'qualification:coolify:cdp-006-fixture',
        bindingStatus: 'active',
        environmentKind: 'staging',
        baseUrl: BASE_URL,
        target: {
          projectUuid: QUALIFICATION_IDS.project,
          applicationUuid: QUALIFICATION_IDS.stagingApplication,
          environmentUuid: QUALIFICATION_IDS.stagingEnvironment,
        },
        capabilityPolicy: {
          allowedActions: ['deploy.staging'],
          preauthorizedStaging: true,
          maxLeaseSeconds: 300,
        },
        bindingGeneration: 4,
        secretReference: {
          store: 'api-key-vault',
          secretId: QUALIFICATION_IDS.stagingSecretReference,
          purpose: 'control-token',
        },
        verifiedProfile: verifiedProfile({
          applicationUuid: QUALIFICATION_IDS.stagingApplication,
          environmentUuid: QUALIFICATION_IDS.stagingEnvironment,
          action: 'deploy.staging',
        }),
        lastValidationError: null,
      },
      revision: {
        sourceRevision: 'a'.repeat(40),
        imageDigest: `sha256:${'a'.repeat(64)}`,
      },
      configurationBindingGeneration: 3,
    },
    production: {
      binding: {
        providerId: 'coolify',
        bindingId: QUALIFICATION_IDS.productionBinding,
        workspaceId: 'qualification:coolify:cdp-006-fixture',
        bindingStatus: 'active',
        environmentKind: 'production',
        baseUrl: BASE_URL,
        target: {
          projectUuid: QUALIFICATION_IDS.project,
          applicationUuid: QUALIFICATION_IDS.productionApplication,
          environmentUuid: QUALIFICATION_IDS.productionEnvironment,
        },
        capabilityPolicy: {
          allowedActions: ['deploy.production'],
          preauthorizedStaging: false,
          productionApprovalMode: 'independent_external',
          maxLeaseSeconds: 300,
        },
        bindingGeneration: 7,
        secretReference: {
          store: 'api-key-vault',
          secretId: QUALIFICATION_IDS.productionSecretReference,
          purpose: 'control-token',
        },
        verifiedProfile: verifiedProfile({
          applicationUuid: QUALIFICATION_IDS.productionApplication,
          environmentUuid: QUALIFICATION_IDS.productionEnvironment,
          action: 'deploy.production',
        }),
        lastValidationError: null,
      },
      release: {
        operationIntentId: QUALIFICATION_IDS.operationIntent,
        intentDigest,
        ciEvidenceDigest,
        sourceRevision: 'b'.repeat(40),
        imageDigest: `sha256:${'b'.repeat(64)}`,
        migrationSetDigest: `sha256:${'4'.repeat(64)}`,
        configurationBindingGeneration: 9,
        rolloutCohortDigest,
        changeWindow: {
          startsAt: '2026-08-24T11:00:00.000Z',
          endsAt: '2026-08-24T13:00:00.000Z',
        },
        priorRevision: {
          sourceRevision: 'c'.repeat(40),
          imageDigest: `sha256:${'c'.repeat(64)}`,
          configurationBindingGeneration: 8,
        },
      },
      externalGate: {
        provider: 'github-protected-environment-fixture',
        configurationId: QUALIFICATION_IDS.gateConfiguration,
        evidenceId: QUALIFICATION_IDS.gateEvidence,
        evidenceDigest: `sha256:${'5'.repeat(64)}`,
        approvalReference: 'github:environment:approval:fixture-001',
        decision: 'approved',
        reviewed: true,
        intentDigest,
        ciEvidenceDigest,
        rolloutCohortDigest,
        verifiedAt: '2026-08-24T11:55:00.000Z',
        expiresAt: '2026-08-24T12:45:00.000Z',
      },
    },
  });
}
