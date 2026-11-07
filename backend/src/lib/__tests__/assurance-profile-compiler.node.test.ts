/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import controlsArtifact from '../../ssdlc/catalog/controls.json';
import {
  ASSURANCE_PROFILE_DEFINITION_VERSION,
  ASSURANCE_PROFILE_EXTENSION_VERSION,
  compileAssuranceProfileSelection,
  registerWorkspaceAssuranceExtension,
  WorkspaceAssuranceExtensionError,
  type AssuranceProfileCompilerInput,
  type AssuranceProfileDefinition,
  type AssuranceProfileSelector,
} from '../assurance-profile-compiler';
import {
  assuranceScopeIdentity,
  type AssuranceCandidateIdentity,
  type AssuranceCandidateInput,
  type AssuranceWorkPackageScope,
} from '../assurance-candidate';

const EMPTY_SELECTOR: AssuranceProfileSelector = {
  products: [],
  requirementIds: [],
  requirementTags: [],
  riskLevels: [],
  riskTags: [],
  architectureDecisionIds: [],
  architectureTags: [],
  changeScopes: [],
  changedPathPrefixes: [],
};

function boundCandidate(): AssuranceCandidateInput {
  const scope: AssuranceWorkPackageScope = {
    workPackageId: 'work-package:AFM-005',
    workPackageRevision: 1,
    workPackageHash: `sha256:${'a'.repeat(64)}`,
    changedPaths: [
      'backend/src/lib/assurance-profile-compiler.ts',
      'backend/src/lib/__tests__/assurance-profile-compiler.node.test.ts',
    ],
    requiredPaths: [
      'backend/src/lib/assurance-profile-compiler.ts',
      'backend/src/lib/__tests__/assurance-profile-compiler.node.test.ts',
    ],
    allowedPaths: ['backend/src/lib'],
    forbiddenPaths: ['backend/src/lib/private'],
  };
  const identity: AssuranceCandidateIdentity = {
    specificationRevision: {
      specId: 'rorca-spec-aligned-feature-assurance-ssdlc',
      revision: 'revision:AFM-005:1',
    },
    plan: { planId: 'plan:feature-assurance', planVersion: 5 },
    commit: '0123456789abcdef0123456789abcdef01234567',
    tree: '1123456789abcdef0123456789abcdef01234567',
    diff: `sha256:${'b'.repeat(64)}`,
    scope: assuranceScopeIdentity(scope),
  };
  return { candidateId: 'candidate:AFM-005', identity, scope };
}

function profile(
  profileId: string,
  overrides: Partial<Omit<AssuranceProfileDefinition, 'schemaVersion' | 'profileId'>> = {},
): AssuranceProfileDefinition {
  return {
    schemaVersion: ASSURANCE_PROFILE_DEFINITION_VERSION,
    profileId,
    version: '1.0.0',
    description: `${profileId} assurance profile`,
    priority: 0,
    selector: structuredClone(EMPTY_SELECTOR),
    controlIds: [],
    thresholds: {},
    controlRefinements: [],
    ...overrides,
  };
}

function targetedProfile(): AssuranceProfileDefinition {
  return profile('workspace-sensitive-change', {
    version: '2.1.0',
    priority: 20,
    selector: {
      products: ['api-service'],
      requirementIds: ['REQ-AUTH-1'],
      requirementTags: ['authorization'],
      riskLevels: ['high'],
      riskTags: ['privacy'],
      architectureDecisionIds: ['ADR-BOUNDARY-1'],
      architectureTags: ['external-boundary'],
      changeScopes: ['cross-boundary'],
      changedPathPrefixes: ['backend/src/lib'],
    },
    controlIds: ['CTRL-TESTING-THREAT-AUTHZ-SECRETS'],
    thresholds: {
      minimumEvidenceDepth: 'independent-verification',
      minimumTrust: 'independently-verified',
      minimumEvidenceItems: 2,
      maximumEvidenceAgeSeconds: 3600,
      minimumIndependentReviews: 1,
    },
    controlRefinements: [{
      controlId: 'CTRL-TESTING-THREAT-AUTHZ-SECRETS',
      rationale: 'The changed external authorization boundary needs fresh adversarial evidence.',
      thresholds: { maximumEvidenceAgeSeconds: 600, minimumIndependentReviews: 2 },
    }],
  });
}

function extensionDeclaration(): unknown {
  return {
    schemaVersion: ASSURANCE_PROFILE_EXTENSION_VERSION,
    workspaceId: 'workspace-1',
    namespace: 'workspace:workspace-1:payments',
    version: '1.2.0',
    controls: [
      {
        controlId: 'workspace:workspace-1:payments/merchant-authorization',
        rationale: 'Verify merchant authorization at the workspace-owned payment boundary.',
        profileIds: ['workspace-sensitive-change'],
        selector: { requirementTags: ['authorization'] },
        thresholds: { minimumEvidenceItems: 3, maximumEvidenceAgeSeconds: 300 },
      },
      {
        controlId: 'workspace:workspace-1:payments/static-copy-review',
        rationale: 'Review static copy for documentation-only work.',
        profileIds: ['documentation-change'],
        selector: { changeScopes: ['documentation'] },
      },
    ],
  };
}

function compilerInput(): AssuranceProfileCompilerInput {
  return {
    workspaceId: 'workspace-1',
    candidate: boundCandidate(),
    product: { productId: 'payments-api', productType: 'api-service', tags: ['payments'] },
    requirements: [
      { requirementId: 'REQ-AUTH-1', tags: ['authorization', 'security'] },
      { requirementId: 'REQ-AUDIT-2', tags: ['audit'] },
    ],
    risks: [{ riskId: 'RISK-PRIVACY-1', level: 'high', tags: ['privacy', 'security'] }],
    architectureDecisions: [{ decisionId: 'ADR-BOUNDARY-1', tags: ['external-boundary', 'api'] }],
    changeScope: { kind: 'cross-boundary', tags: ['backend'] },
    profiles: [profile('general-change'), targetedProfile()],
    extensions: [registerWorkspaceAssuranceExtension({
      workspaceId: 'workspace-1',
      extension: extensionDeclaration(),
    })],
  };
}

function hasExtensionCode(code: WorkspaceAssuranceExtensionError['code']): (error: unknown) => boolean {
  return (error) => error instanceof WorkspaceAssuranceExtensionError && error.code === code;
}

describe('versioned assurance profile compiler', () => {
  it('selects one active profile from every bound context dimension and returns inspectable controls and thresholds', () => {
    const compilation = compileAssuranceProfileSelection(compilerInput());

    assert.equal(compilation.resolution, 'resolved');
    assert.equal(compilation.activeProfile?.profileIdentity, 'workspace-sensitive-change@2.1.0');
    assert.deepEqual(
      compilation.applicabilityRationale.map((entry) => entry.dimension),
      ['product', 'requirements', 'risks', 'architecture', 'change-scope'],
    );
    assert.ok(compilation.applicabilityRationale.every((entry) => entry.matchedValues.length > 0));
    assert.ok(compilation.selectedControls.every((control) => control.disposition === 'required'));
    assert.ok(compilation.selectedControls.some((control) => (
      control.controlId === 'workspace:workspace-1:payments/merchant-authorization'
      && control.namespace === 'workspace:workspace-1:payments'
      && control.effectiveThresholds.minimumEvidenceItems === 3
      && control.effectiveThresholds.maximumEvidenceAgeSeconds === 300
    )));
    assert.ok(compilation.unselectedControls.some((control) => (
      control.controlId === 'workspace:workspace-1:payments/static-copy-review'
      && control.disposition === 'not_selected'
    )));
    assert.deepEqual(compilation.effectiveThresholds, {
      minimumEvidenceDepth: 'independent-verification',
      minimumTrust: 'independently-verified',
      minimumEvidenceItems: 3,
      maximumEvidenceAgeSeconds: 300,
      minimumIndependentReviews: 2,
    });
    assert.deepEqual(compilation.correctiveActions, []);
    assert.ok(Object.isFrozen(compilation));
    assert.ok(Object.isFrozen(compilation.selectedControls));
  });

  it('matches the bound product identity and reports only the changed path prefixes that actually apply', () => {
    const productAndPathProfile = profile('product-identity-change', {
      priority: 30,
      selector: {
        ...structuredClone(EMPTY_SELECTOR),
        products: ['payments-api'],
        changedPathPrefixes: ['backend/src/lib', 'frontend/src'],
      },
      controlIds: ['CTRL-PLANNING-NEED-SCOPE'],
    });
    const input = compilerInput();
    input.profiles = [productAndPathProfile];

    const compilation = compileAssuranceProfileSelection(input);

    assert.equal(compilation.resolution, 'resolved');
    assert.equal(compilation.activeProfile?.profileIdentity, 'product-identity-change@1.0.0');
    assert.deepEqual(
      compilation.applicabilityRationale.find((entry) => entry.dimension === 'product')?.matchedValues,
      ['payments-api'],
    );
    assert.deepEqual(
      compilation.applicabilityRationale.find((entry) => entry.dimension === 'change-scope')?.matchedValues,
      ['path-prefix:backend/src/lib'],
    );
  });

  it('rejects conflicting namespace registrations consistently regardless of input order', () => {
    const extension = registerWorkspaceAssuranceExtension({
      workspaceId: 'workspace-1',
      extension: extensionDeclaration(),
    });
    const competingExtension = registerWorkspaceAssuranceExtension({
      workspaceId: 'workspace-1',
      extension: {
        ...(extensionDeclaration() as Record<string, unknown>),
        version: '1.3.0',
        controls: [{
          controlId: 'workspace:workspace-1:payments/competing-control',
          rationale: 'Conflicting content must not replace the registered namespace.',
        }],
      },
    });
    const firstInput = compilerInput();
    firstInput.extensions = [extension, competingExtension];
    const secondInput = structuredClone(firstInput);
    secondInput.extensions = [...(secondInput.extensions ?? [])].reverse();

    const first = compileAssuranceProfileSelection(firstInput);
    const second = compileAssuranceProfileSelection(secondInput);

    assert.equal(first.resolution, 'blocked');
    assert.equal(first.extensions.length, 0);
    assert.ok(first.conflicts.some((conflict) => (
      conflict.kind === 'extension-conflict'
      && conflict.identities.includes('workspace:workspace-1:payments')
    )));
    assert.deepEqual(second, first);
  });

  it('registers immutable namespaced additive controls and rejects shared-core or cross-workspace mutation', () => {
    const registration = registerWorkspaceAssuranceExtension({
      workspaceId: 'workspace-1',
      extension: extensionDeclaration(),
    });

    assert.equal(registration.namespace, 'workspace:workspace-1:payments');
    assert.deepEqual(registration.additiveControls.map((control) => control.controlId), [
      'workspace:workspace-1:payments/merchant-authorization',
      'workspace:workspace-1:payments/static-copy-review',
    ]);
    assert.match(registration.registrationHash, /^sha256:[0-9a-f]{64}$/);
    assert.ok(Object.isFrozen(registration.additiveControls[0]));

    assert.throws(() => registerWorkspaceAssuranceExtension({
      workspaceId: 'workspace-1',
      extension: {
        schemaVersion: ASSURANCE_PROFILE_EXTENSION_VERSION,
        workspaceId: 'workspace-1',
        namespace: 'workspace:workspace-1:payments',
        version: '1.0.0',
        controls: [{
          controlId: 'CTRL-PLANNING-NEED-SCOPE',
          rationale: 'Attempt to replace a shared core identity.',
        }],
      },
    }), hasExtensionCode('CONTROL_NAMESPACE_MISMATCH'));
    assert.throws(() => registerWorkspaceAssuranceExtension({
      workspaceId: 'workspace-1',
      extension: {
        schemaVersion: ASSURANCE_PROFILE_EXTENSION_VERSION,
        workspaceId: 'workspace-2',
        namespace: 'workspace:workspace-2:payments',
        version: '1.0.0',
        controls: [{
          controlId: 'workspace:workspace-2:payments/foreign-control',
          rationale: 'Attempt to register into another workspace.',
        }],
      },
    }), hasExtensionCode('WORKSPACE_NAMESPACE_MISMATCH'));
    assert.throws(() => registerWorkspaceAssuranceExtension({
      workspaceId: 'workspace-1',
      extension: {
        ...(extensionDeclaration() as Record<string, unknown>),
        removeControlIds: ['CTRL-PLANNING-NEED-SCOPE'],
      },
    }), hasExtensionCode('CORE_MUTATION_FORBIDDEN'));
  });

  it('returns unresolved or blocked baseline controls and corrective action for absent, invalid, and conflicting profiles', () => {
    const absentInput = compilerInput();
    absentInput.profiles = [];
    const absent = compileAssuranceProfileSelection(absentInput);
    assert.equal(absent.resolution, 'unresolved');
    assert.equal(absent.activeProfile, null);
    assert.ok(absent.selectedControls.length > 0);
    assert.ok(absent.selectedControls.every((control) => control.disposition === 'unresolved'));
    assert.ok(absent.correctiveActions.some((action) => action.code === 'declare-matching-profile'));

    const invalidInput = compilerInput();
    invalidInput.profiles = [{
      ...profile('invalid-profile'),
      removeControlIds: ['CTRL-PLANNING-NEED-SCOPE'],
    }];
    const invalid = compileAssuranceProfileSelection(invalidInput);
    assert.equal(invalid.resolution, 'blocked');
    assert.equal(invalid.activeProfile, null);
    assert.ok(invalid.selectedControls.every((control) => control.disposition === 'blocked'));
    assert.ok(invalid.conflicts.some((conflict) => conflict.kind === 'invalid-profile'));
    assert.ok(invalid.correctiveActions.some((action) => action.code === 'repair-profile-fixtures'));

    const conflictingInput = compilerInput();
    conflictingInput.profiles = [profile('general-a'), profile('general-b')];
    const conflicting = compileAssuranceProfileSelection(conflictingInput);
    assert.equal(conflicting.resolution, 'blocked');
    assert.equal(conflicting.activeProfile, null);
    assert.deepEqual(conflicting.conflicts.find((conflict) => conflict.kind === 'profile-selection-conflict')?.identities, [
      'general-a@1.0.0',
      'general-b@1.0.0',
    ]);
    assert.ok(conflicting.selectedControls.every((control) => control.disposition === 'blocked'));
    assert.ok(conflicting.correctiveActions.some((action) => action.code === 'resolve-profile-conflict'));
  });

  it('preserves every universal core baseline and is exactly repeatable across semantically reordered input', () => {
    const firstInput = compilerInput();
    const secondInput = structuredClone(firstInput);
    secondInput.profiles = [...(secondInput.profiles ?? [])].reverse();
    secondInput.requirements = [...(secondInput.requirements ?? [])].reverse().map((requirement) => ({
      ...requirement,
      tags: [...(requirement.tags ?? [])].reverse(),
    }));
    secondInput.risks = [...(secondInput.risks ?? [])].map((risk) => ({ ...risk, tags: [...(risk.tags ?? [])].reverse() }));
    secondInput.architectureDecisions = [...(secondInput.architectureDecisions ?? [])].map((decision) => ({
      ...decision,
      tags: [...(decision.tags ?? [])].reverse(),
    }));
    if (secondInput.candidate) {
      secondInput.candidate.scope.changedPaths = [...secondInput.candidate.scope.changedPaths].reverse();
      secondInput.candidate.scope.requiredPaths = [...secondInput.candidate.scope.requiredPaths].reverse();
    }

    const first = compileAssuranceProfileSelection(firstInput);
    const second = compileAssuranceProfileSelection(secondInput);
    const selectedIds = new Set(first.selectedControls.map((control) => control.controlId));
    assert.ok(controlsArtifact.every((control) => selectedIds.has(control.controlId)));
    assert.equal(
      first.selectedControls.find((control) => control.controlId === 'CTRL-PLANNING-NEED-SCOPE')
        ?.effectiveThresholds.minimumEvidenceDepth,
      'independent-verification',
      'profile floors cannot weaken canonical baseline evidence',
    );
    assert.deepEqual(second, first);
    assert.equal(second.compilationHash, first.compilationHash);
    assert.equal(second.compilationId, first.compilationId);
  });
});
