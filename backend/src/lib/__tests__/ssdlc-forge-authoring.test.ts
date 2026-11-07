/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  adaptCanonicalStoriesToAuthoringDraft,
  authoringConfirmationRequired,
  buildLifecycleAuthoringSection,
  buildPersistedAuthoringMetadata,
  deriveCanonicalStoryMaterialHash,
  refreshAuthoringStateAfterEdit,
  runAuthoringPreflight,
} from '../ssdlc-forge-authoring';
import { planAuthoring } from '../ssdlc-authoring-planner';

const canonicalStories = [
  {
    id: 'AUTH-001',
    title: 'Users authenticate with explicit outcomes',
    description: 'Users receive an authenticated session or an observable denial without ambiguous state.',
    acceptanceCriteria: ['The service reports an authenticated session for valid credentials.'],
    dependsOn: [],
  },
  {
    id: 'AUTH-002',
    title: 'Operators observe authentication recovery',
    description: 'Operators can verify recovery and safe degradation after authentication failures.',
    acceptanceCriteria: ['A recovery check reports restored authentication behavior after a transient failure.'],
    dependsOn: ['AUTH-001'],
  },
];

function fixture(brief = 'Users can authenticate and recover safely') {
  const lifecycleAuthoring = buildLifecycleAuthoringSection({
    workspaceId: 'workspace-test',
    title: 'Safe authentication',
    brief,
    contextUsed: { text: 'context', meta: { project: true } },
    contextSummary: { predictedFiles: ['src/auth/session.ts'] },
    invocationSurface: 'test.authoring',
  });
  const planning = planAuthoring(lifecycleAuthoring.plannerInputSeed);
  if (!planning.acceptedPlan) throw new Error('fixture plan unexpectedly blocked');
  const specs = adaptCanonicalStoriesToAuthoringDraft(planning.acceptedPlan, [{
    specReference: planning.acceptedPlan.specBoundaries[0].specReference,
    stories: canonicalStories,
  }]);
  return { lifecycleAuthoring, plan: planning.acceptedPlan, specs };
}

function preflightInput() {
  const { lifecycleAuthoring, specs } = fixture();
  return {
    schemaVersion: 1 as const,
    workspaceId: 'workspace-test',
    plannerInput: lifecycleAuthoring.plannerInputSeed,
    specs,
    attempt: 1,
    priorAttempts: [],
    callerSurface: 'test.authoring',
    model: 'test-model',
  };
}

describe('SSDLC forge authoring integration', () => {
  test('returns a bounded versioned lifecycle-authoring checklist with no execution authority', () => {
    const { lifecycleAuthoring } = fixture();

    expect(lifecycleAuthoring).toMatchObject({
      schemaVersion: 1,
      profileVersion: 'ssdlc-lifecycle-authoring-1',
      status: 'ready',
      decompositionPolicy: {
        defaultDecision: 'one_spec_unless_independent_boundary_is_proven',
        maximumSpecs: 12,
        exactRequirementOwnership: true,
        acyclicDependenciesRequired: true,
      },
      wordingRules: {
        modelOwnsReadableProse: true,
        requireObservableAcceptanceCriteria: true,
        prohibitCannedProse: true,
      },
      authorityBoundary: {
        evaluatedLifecycleStatus: 'forbidden',
        completionEvidence: 'forbidden',
        gateWaiver: 'forbidden',
        retryMergeDeployAuthorization: 'forbidden',
        productionMutation: 'forbidden',
        executionDispatch: 'forbidden',
      },
    });
    expect(lifecycleAuthoring.normalizedIntentIdentity.requirements).toHaveLength(1);
    expect(lifecycleAuthoring.requiredStoryCapabilities.length).toBeGreaterThan(0);
    expect(lifecycleAuthoring.requiredPhaseObligations).toHaveLength(7);
    expect(lifecycleAuthoring.preflightContract.maximumRevisionAttempts).toBe(3);
  });

  test('accepts a complete one-spec draft and returns deterministic plan/preflight identities', () => {
    const first = runAuthoringPreflight(preflightInput());
    const second = runAuthoringPreflight(preflightInput());

    expect(first.state).toBe('accepted');
    expect(first.acceptedPlan?.recommendedSpecCount).toBe(1);
    expect(first.acceptedPlanHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.acceptedPreflightHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second.acceptedPlanHash).toBe(first.acceptedPlanHash);
    expect(second.acceptedPreflightHash).toBe(first.acceptedPreflightHash);
    expect(first.preflight?.draftMutationCount).toBe(0);
    expect(first.executionAuthority).toBe('none');
  });

  test('requires revision for missing story capability and exits blocked on attempt three', () => {
    const input = preflightInput();
    for (const spec of input.specs) {
      for (const story of spec.stories) story.capabilities = story.capabilities.filter((capability) => capability !== 'recovery');
    }

    const first = runAuthoringPreflight(input);
    expect(first.state).toBe('revision_required');
    expect(first.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MISSING_CAPABILITY_COVERAGE', severity: 'blocker' }),
    ]));
    expect(first.amendments.length).toBeGreaterThan(0);

    const final = runAuthoringPreflight({
      ...input,
      attempt: 3,
      priorAttempts: [
        { attempt: 1, accepted: false, diagnosticCategories: ['MISSING_CAPABILITY_COVERAGE'], materialRevisions: [] },
        { attempt: 2, accepted: false, diagnosticCategories: ['MISSING_CAPABILITY_COVERAGE'], materialRevisions: ['Rechecked capability ownership.'] },
      ],
    });
    expect(final.state).toBe('blocked');
    expect(final.authoritativePersistenceAllowed).toBe(false);
  });

  test('rejects model-authored authority fields and unknown gate contributions without waiving them', () => {
    const authorityInput = preflightInput() as any;
    authorityInput.specs[0].stories[0].evaluatedStatus = 'passed';
    const authority = runAuthoringPreflight(authorityInput);
    expect(authority.state).toBe('revision_required');
    expect(authority.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'NON_AUTHORITATIVE_FIELD' }),
    ]));

    const gateInput = preflightInput();
    gateInput.specs[0].stories[0].expectedContributions.gateIds.push('gate-waived-by-model');
    const gate = runAuthoringPreflight(gateInput);
    expect(gate.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNKNOWN_GATE_CONTRIBUTION' }),
    ]));
    expect(gate.authoritativePersistenceAllowed).toBe(false);
  });

  test('does not stale semantic identity for criterion reorder/formatting but does for material edits', () => {
    const base = [
      { ...canonicalStories[0], acceptanceCriteria: ['The service reports A.', 'The service reports B.'] },
      canonicalStories[1],
    ];
    const cosmetic = [
      { ...canonicalStories[0], acceptanceCriteria: ['  THE service reports B. ', 'The service reports A.'] },
      canonicalStories[1],
    ];
    const changed = [
      { ...canonicalStories[0], acceptanceCriteria: ['The service reports A with a new semantic condition.', 'The service reports B.'] },
      canonicalStories[1],
    ];

    expect(deriveCanonicalStoryMaterialHash(cosmetic)).toBe(deriveCanonicalStoryMaterialHash(base));
    expect(deriveCanonicalStoryMaterialHash(changed)).not.toBe(deriveCanonicalStoryMaterialHash(base));
  });

  test('stales persisted authoring annotations when boundary/risk metadata drifts', () => {
    const { lifecycleAuthoring, plan, specs } = fixture();
    const accepted = runAuthoringPreflight(preflightInput());
    const authoring = buildPersistedAuthoringMetadata({
      binding: {
        schemaVersion: 1,
        profileVersion: lifecycleAuthoring.profileVersion,
        acceptedPlan: plan,
        planHash: plan.acceptedPlanHash,
        specs,
        acceptedPreflightHash: accepted.acceptedPreflightHash!,
        preflightAttemptCount: 1,
        priorAttempts: [],
        materialRevisions: [],
        callerSurface: 'test.authoring',
        model: 'test-model',
        preflightReceiptId: 1,
      },
      spec: specs[0],
      stories: canonicalStories,
    });
    const content: Record<string, any> = { userStories: canonicalStories, authoring };
    expect(refreshAuthoringStateAfterEdit(content)).toBe(false);
    content.authoring.boundary.riskHints.push('critical');
    expect(refreshAuthoringStateAfterEdit(content)).toBe(true);
    expect(content.authoring).toMatchObject({ state: 'stale_authoring_preflight', approvalReady: false });
  });

  test('marks security-sensitive and release plans as confirmation-required without granting approval', () => {
    const security = fixture('Require security review, authorization denial paths, and secret redaction');
    expect(security.plan.lifecycleProfile.profileId).toBe('security-sensitive');
    expect(authoringConfirmationRequired(security.plan)).toBe(true);
    expect(security.plan.acceptedOverrides.every((override) => override.grantsDownstreamApproval === false)).toBe(true);
  });
});
