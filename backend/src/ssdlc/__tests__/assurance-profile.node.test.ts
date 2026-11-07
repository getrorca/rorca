/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AssuranceProfileMismatchError,
  assertCurrentAssuranceProfile,
  bindAssuranceProfile,
  compileAssuranceProfile,
  getCanonicalControl,
  resolveAssuranceProfile,
  type BindAssuranceProfileInput,
  type CompileAssuranceProfileInput,
  type CurrentAssuranceContext,
} from '../assurance-profile';
import type { EntityRefV1, RevisionRefV1 } from '../../lib/mission-contracts';
import { deriveSourceBundleHash, SourceBundleV1Schema, type SourceBundleV1 } from '../../lib/source-contracts';

const hash = (character: string): string => `sha256:${character.repeat(64)}`;
const revision = (value: string): RevisionRefV1 => ({ kind: 'spec_version', value });
const specRef = (value = '7'): EntityRefV1 => ({
  schemaVersion: 'rorca.entity-ref.v1', workspaceId: 'workspace-1', kind: 'spec', id: 'payment-api', label: 'Payment API', revision: revision(value),
});
const workspaceRef: EntityRefV1 = {
  schemaVersion: 'rorca.entity-ref.v1', workspaceId: 'workspace-1', kind: 'workspace', id: 'workspace-1', label: 'Workspace 1',
};

function sourceBundle(intent: string): SourceBundleV1 {
  const includedSources = [{
    schemaVersion: 'rorca.source-ref.v1' as const,
    sourceId: 'source-1',
    kind: 'inline' as const,
    locator: 'sources/source-1',
    title: 'Approved brief',
    contentHash: hash(intent === 'original intent' ? '1' : '2'),
    sourceVersion: '1',
    reviewStatus: 'approved' as const,
    sensitivity: 'internal' as const,
    authority: 'user_mandated' as const,
    selectedSections: ['brief'],
  }];
  const citations = [{
    schemaVersion: 'rorca.source-citation.v1' as const,
    citationId: 'citation-1', sourceId: 'source-1', section: 'brief', excerptHash: hash('3'), rationale: 'Defines requested behavior.',
  }];
  return SourceBundleV1Schema.parse({
    schemaVersion: 'rorca.source-bundle.v1', bundleId: `bundle-${intent.replaceAll(' ', '-')}`,
    bundleHash: deriveSourceBundleHash({ userIntent: intent, includedSources, citations }),
    userIntent: intent, workspaceRef, includedSources, excludedSources: [], conflicts: [], assumptions: [], truncations: [], citations,
    compiledAt: '2026-03-16T00:00:00Z',
  });
}

function input(value = '7', bundle = sourceBundle('original intent')): CompileAssuranceProfileInput {
  const control = getCanonicalControl('CTRL-REQUIREMENTS-TRACEABILITY');
  assert.ok(control, 'canonical controls.json fixture must be available');
  return {
    profileId: `profile-payment-api-${value}`,
    specRef: specRef(value),
    specRevision: revision(value),
    repositoryContextHash: hash(value === '7' ? 'a' : 'b'),
    persistedSourceContext: { bundle, specRevision: revision(value) },
    riskProfile: { level: 'high', tags: ['payments'], rationale: 'Payment processing has material integrity risk.' },
    controlInstances: [{
      controlId: control.controlId,
      mechanismBindings: [{ mechanismId: 'tests', kind: 'command', locator: 'npm run test:payments' }],
      criteria: [{ criterionId: 'tests-pass', description: 'Payment tests pass.', evaluator: 'exit-code', expected: '0' }],
      evidenceRequirements: structuredClone(control.requiredEvidence),
    }],
  };
}

function current(value = '7', bundle = sourceBundle('original intent')): CurrentAssuranceContext {
  return { specRef: specRef(value), specRevision: revision(value), repositoryContextHash: hash(value === '7' ? 'a' : 'b'), sourceBundle: bundle };
}

function hasCode(code: AssuranceProfileMismatchError['code']): (error: unknown) => boolean {
  return (error) => error instanceof AssuranceProfileMismatchError && error.code === code;
}

test('compiles a canonical controlId profile and recursively freezes the exact-revision artifact', () => {
  const profile = compileAssuranceProfile(input());
  assert.equal(profile.schemaVersion, 'rorca.assurance-profile.v1');
  assert.equal(profile.specRef.revision?.value, profile.specRevision.value);
  assert.equal(profile.sourceContext?.bundleHash, sourceBundle('original intent').bundleHash);
  assert.ok(profile.compilationReceiptHash?.startsWith('sha256:'));
  assert.ok(Object.isFrozen(profile));
  assert.ok(Object.isFrozen(profile.controlInstances[0].criteria));
  assert.throws(() => Reflect.apply(Array.prototype.push, profile.controlInstances[0].criteria, [{}]), TypeError);

  const unknown = input();
  unknown.controlInstances[0].controlId = 'CTRL-NOT-IN-CATALOG';
  assert.throws(() => compileAssuranceProfile(unknown), hasCode('UNKNOWN_CONTROL_ID'));

  const nonCanonicalEvidence = input();
  nonCanonicalEvidence.controlInstances[0].evidenceRequirements[0].allowedSourceTypes = ['unregistered:evidence'];
  assert.throws(() => compileAssuranceProfile(nonCanonicalEvidence), hasCode('CONTROL_EVIDENCE_MISMATCH'));
});

test('rejects a source bundle persisted against a different spec revision', () => {
  const mismatched = input();
  mismatched.persistedSourceContext = { bundle: sourceBundle('original intent'), specRevision: revision('6') };
  assert.throws(() => compileAssuranceProfile(mismatched), hasCode('SPEC_REVISION_MISMATCH'));
});

test('source drift invalidates the old profile and recompilation produces a new receipt', () => {
  const original = compileAssuranceProfile(input());
  const driftedBundle = sourceBundle('changed intent');
  assert.throws(() => assertCurrentAssuranceProfile(original, current('7', driftedBundle)), hasCode('SOURCE_BUNDLE_MISMATCH'));

  const sameContentDifferentBundle = { ...sourceBundle('original intent'), bundleId: 'replacement-bundle' };
  assert.throws(
    () => assertCurrentAssuranceProfile(original, current('7', SourceBundleV1Schema.parse(sameContentDifferentBundle))),
    hasCode('SOURCE_BUNDLE_MISMATCH'),
  );

  const recompiled = compileAssuranceProfile(input('7', driftedBundle));
  assert.notEqual(recompiled.sourceContext?.bundleHash, original.sourceContext?.bundleHash);
  assert.notEqual(recompiled.compilationReceiptHash, original.compilationReceiptHash);
});

test('spec content revision invalidates the old profile and cannot reuse its receipt', () => {
  const original = compileAssuranceProfile(input('7'));
  assert.throws(() => assertCurrentAssuranceProfile(original, current('8')), hasCode('SPEC_REVISION_MISMATCH'));
  assert.throws(
    () => assertCurrentAssuranceProfile(original, { ...current('7'), specRef: specRef('6') }),
    hasCode('SPEC_REVISION_MISMATCH'),
  );
  const recompiled = compileAssuranceProfile(input('8'));
  assert.notEqual(recompiled.compilationReceiptHash, original.compilationReceiptHash);
});

test('rejects profile content paired with a stale compilation receipt', () => {
  const original = compileAssuranceProfile(input());
  const tampered = structuredClone(original) as unknown as { riskProfile: { rationale: string } };
  tampered.riskProfile.rationale = 'Changed after compilation without issuing a new receipt.';
  assert.throws(() => assertCurrentAssuranceProfile(tampered, current()), hasCode('COMPILATION_RECEIPT_MISMATCH'));
});

function binderInput(controlId = 'CTRL-REQUIREMENTS-TRACEABILITY'): BindAssuranceProfileInput {
  const control = getCanonicalControl(controlId);
  assert.ok(control);
  const persisted = sourceBundle('original intent');
  const mechanism = { mechanismId: 'repo-tests', kind: 'command' as const, locator: 'npm run test:payments' };
  const evidenceRequirements = structuredClone(control.requiredEvidence);
  const stage = control.phase === 'testing' ? 'testing' as const : 'requirements' as const;
  return {
    profileId: 'bound-payment-profile', specRef: specRef(), specRevision: revision('7'),
    persistedSourceContext: { bundle: persisted, specRevision: revision('7') },
    repositoryContext: { contextHash: hash('a'), mechanisms: [mechanism] },
    riskProfile: { level: 'high', tags: ['payments'], rationale: 'Payment processing has material integrity risk.' },
    applicability: { activeControlIds: [control.controlId] },
    gateCompilation: {
      phaseGroups: [{
        phase: control.phase, controlIds: [control.controlId], families: {}, missingFamilies: [],
        evidenceRequirements: evidenceRequirements.map((requirement) => ({
          ...requirement, controlId: control.controlId, sourceReferences: structuredClone(control.sourceReferences),
        })),
      }],
      readiness: [{
        stage, phases: [control.phase], controlIds: [control.controlId], unresolvedControlIds: [],
        approvalControlIds: [], blocking: false, status: 'ready',
      }],
    },
    modelProposal: {
      specRevision: revision('7'), sourceBundleHash: persisted.bundleHash,
      controlBindings: [{
        controlId: control.controlId, enforcement: 'required', mechanismBindings: [mechanism],
        criteria: [{ criterionId: 'tests-pass', description: 'Repository tests pass.', evaluator: 'exit-code', expected: '0' }],
        evidenceRequirements,
      }],
    },
  };
}

test('binds a complete model proposal only to US-003/US-004 controls and is idempotent', () => {
  const candidate = binderInput();
  const first = bindAssuranceProfile(candidate);
  const second = bindAssuranceProfile(structuredClone(candidate));
  assert.deepEqual(first, second);
  assert.deepEqual(first.selectionContext?.applicabilityControlIds, ['CTRL-REQUIREMENTS-TRACEABILITY']);
  assert.deepEqual(first.controlInstances.map(({ controlId }) => controlId), candidate.applicability.activeControlIds);
  assert.equal(first.sourceContext?.bundleHash, candidate.persistedSourceContext?.bundle.bundleHash);
});

test('blocks missing mechanism, criteria, and evidence with actionable control gaps', () => {
  const missingMechanism = binderInput();
  missingMechanism.modelProposal.controlBindings[0].mechanismBindings = [];
  assert.throws(() => bindAssuranceProfile(missingMechanism), (error: unknown) => (
    error instanceof AssuranceProfileMismatchError
    && error.code === 'MISSING_CONTROL_BINDING'
    && /CTRL-REQUIREMENTS-TRACEABILITY.*mechanism/.test(error.message)
  ));

  const missingCriteria = binderInput();
  missingCriteria.modelProposal.controlBindings[0].criteria = [];
  assert.throws(() => bindAssuranceProfile(missingCriteria), (error: unknown) => (
    error instanceof AssuranceProfileMismatchError
    && error.code === 'MISSING_CONTROL_BINDING'
    && /CTRL-REQUIREMENTS-TRACEABILITY.*criteria/.test(error.message)
  ));

  const missingEvidence = binderInput();
  missingEvidence.modelProposal.controlBindings[0].evidenceRequirements = [];
  assert.throws(() => bindAssuranceProfile(missingEvidence), (error: unknown) => (
    error instanceof AssuranceProfileMismatchError
    && error.code === 'MISSING_CONTROL_BINDING'
    && /CTRL-REQUIREMENTS-TRACEABILITY.*evidence/.test(error.message)
  ));
});

test('rejects unknown or unselected controls and mechanisms outside repository context', () => {
  const extraControl = binderInput();
  extraControl.modelProposal.controlBindings[0].controlId = 'CTRL-NOT-SELECTED';
  assert.throws(() => bindAssuranceProfile(extraControl), hasCode('MISSING_CONTROL_BINDING'));

  const unknownControl = binderInput();
  unknownControl.applicability.activeControlIds = ['CTRL-NOT-IN-CATALOG'];
  unknownControl.gateCompilation.phaseGroups[0].controlIds = ['CTRL-NOT-IN-CATALOG'];
  unknownControl.gateCompilation.readiness[0].controlIds = ['CTRL-NOT-IN-CATALOG'];
  unknownControl.modelProposal.controlBindings[0].controlId = 'CTRL-NOT-IN-CATALOG';
  assert.throws(() => bindAssuranceProfile(unknownControl), hasCode('UNKNOWN_CONTROL_ID'));

  const invalidMechanism = binderInput();
  invalidMechanism.modelProposal.controlBindings[0].mechanismBindings[0] = {
    ...invalidMechanism.modelProposal.controlBindings[0].mechanismBindings[0],
    locator: 'curl unreviewed.example',
  };
  assert.throws(() => bindAssuranceProfile(invalidMechanism), hasCode('INVALID_MECHANISM'));

  const malformedInventory = binderInput();
  malformedInventory.repositoryContext.mechanisms[0].locator = '';
  assert.throws(() => bindAssuranceProfile(malformedInventory), (error: unknown) => (
    error instanceof AssuranceProfileMismatchError
    && error.code === 'INVALID_MECHANISM'
    && /repo-tests.*locator/.test(error.message)
  ));
});

test('rejects weakened preference for a canonical non-overridable control', () => {
  const weakened = binderInput('CTRL-TESTING-THREAT-AUTHZ-SECRETS');
  weakened.modelProposal.controlBindings[0].enforcement = 'preferred';
  assert.throws(() => bindAssuranceProfile(weakened), hasCode('WEAKENED_CONTROL'));

  const directCompilation = input();
  const nonOverridable = getCanonicalControl('CTRL-TESTING-THREAT-AUTHZ-SECRETS');
  assert.ok(nonOverridable);
  directCompilation.controlInstances = [{
    ...directCompilation.controlInstances[0],
    controlId: nonOverridable.controlId,
    enforcement: 'preferred',
    evidenceRequirements: structuredClone(nonOverridable.requiredEvidence),
  }];
  assert.throws(() => compileAssuranceProfile(directCompilation), hasCode('WEAKENED_CONTROL'));
});

test('rejects model proposal and HMG-persisted revision/source-bundle mismatches', () => {
  const wrongRevision = binderInput();
  wrongRevision.modelProposal.specRevision = revision('6');
  assert.throws(() => bindAssuranceProfile(wrongRevision), hasCode('MODEL_CONTEXT_MISMATCH'));

  const wrongBundle = binderInput();
  wrongBundle.modelProposal.sourceBundleHash = hash('f');
  assert.throws(() => bindAssuranceProfile(wrongBundle), hasCode('MODEL_CONTEXT_MISMATCH'));

  const persistedAtWrongRevision = binderInput();
  assert.ok(persistedAtWrongRevision.persistedSourceContext);
  persistedAtWrongRevision.persistedSourceContext.specRevision = revision('6');
  assert.throws(() => bindAssuranceProfile(persistedAtWrongRevision), hasCode('SPEC_REVISION_MISMATCH'));

  const invalidPersistedBundle = binderInput();
  assert.ok(invalidPersistedBundle.persistedSourceContext);
  invalidPersistedBundle.persistedSourceContext.bundle = {
    ...invalidPersistedBundle.persistedSourceContext.bundle,
    bundleHash: hash('f'),
  };
  invalidPersistedBundle.modelProposal.sourceBundleHash = hash('f');
  assert.throws(() => bindAssuranceProfile(invalidPersistedBundle), hasCode('SOURCE_BUNDLE_MISMATCH'));
});

test('rejects disagreement or malformed projections between authoritative US-003 and US-004 selections', () => {
  const inconsistent = binderInput();
  inconsistent.gateCompilation.phaseGroups[0].controlIds = [];
  assert.throws(() => bindAssuranceProfile(inconsistent), hasCode('ACTIVE_CONTROL_MISMATCH'));

  const wrongPhase = binderInput();
  wrongPhase.gateCompilation.phaseGroups[0].phase = 'implementation';
  assert.throws(() => bindAssuranceProfile(wrongPhase), (error: unknown) => (
    error instanceof AssuranceProfileMismatchError
    && error.code === 'ACTIVE_CONTROL_MISMATCH'
    && /CTRL-REQUIREMENTS-TRACEABILITY.*implementation.*requirements/.test(error.message)
  ));

  const wrongStage = binderInput();
  wrongStage.gateCompilation.readiness[0].stage = 'planning';
  assert.throws(() => bindAssuranceProfile(wrongStage), hasCode('ACTIVE_CONTROL_MISMATCH'));
});

test('resolves a missing legacy profile through an explicit empty default without changing stories', () => {
  const profile = resolveAssuranceProfile(undefined, { ...current(), sourceBundle: undefined });
  assert.equal(profile.profileKind, 'default');
  assert.deepEqual(profile.controlInstances, []);
  assert.equal(profile.sourceContext, null);
  assert.equal(profile.compilationReceiptHash, null);
  assert.equal(profile.specRef.revision?.value, '7');
});
