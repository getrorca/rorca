// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const registryPath = new URL('../docs/qualification/wave-parallel-invariants.json', import.meta.url);
const crossReferencePath = new URL('../docs/qualification/wave-parallel-v1/cross-reference.json', import.meta.url);
const requirementsPath = new URL('../docs/qualification/wave-parallel-v1/requirements.json', import.meta.url);
const compiledAssertionRegistryPath = new URL('../backend/src/lib/wave-canonical-assertions.ts', import.meta.url);

export const CANONICAL_SPEC_SHA256 = '3e47570b7b654613e2d71d496baeb6fa0e311e5a521459aba700272f98fb69d6';
export const CANONICAL_SPEC_BYTE_LENGTH = 149_963;
export const REQUIREMENTS_ARTIFACT_SHA256 = 'f45fc506d4ab71416bcac954941dd18620ee6c2388f1c847e5ba5efcbfa82d1b';
export const REQUIREMENTS_CONTENT_SHA256 = '5f9ddeab24fb892045d619bd0261d0e0324beaa4ad5b52c15e284d2a61f2f9f1';

const REQUIRED_INVARIANTS = new Map([
  ['WPE-INV-001', 'no-pass-before-integration'],
  ['WPE-INV-002', 'rejection-is-semantic-failure'],
  ['WPE-INV-003', 'failed-dependencies-never-start'],
  ['WPE-INV-004', 'only-owned-resources-are-cleaned'],
  ['WPE-INV-005', 'accepted-integration-exactly-once'],
  ['WPE-INV-006', 'historical-evidence-is-immutable'],
  ['WPE-INV-007', 'production-is-never-a-target'],
]);

const STORY_REQUIREMENT_COUNTS = new Map([
  ['WPE-001', 10],
  ['WPE-002', 9],
  ['WPE-003', 11],
  ['WPE-004', 11],
  ['WPE-005', 10],
  ['WPE-006', 10],
  ['WPE-007', 10],
  ['WPE-008', 10],
  ['WPE-009', 11],
  ['WPE-010', 10],
  ['WPE-011', 11],
  ['WPE-012', 12],
]);

const RECOGNIZED_EVIDENCE_CLASSES = [
  'automated_test_output',
  'durable_database_wal',
  'git_integration',
  'independent_checker',
  'canary_soak',
  'rollback_rehearsal',
  'operator_observation',
  'skipped_check',
  'environmental_blocker',
];
const MEASURED_EVIDENCE_CLASSES = [
  'durable_database_wal',
  'git_integration',
  'independent_checker',
  'canary_soak',
  'rollback_rehearsal',
];
const SUPPORTING_EVIDENCE_CLASSES = ['automated_test_output', 'operator_observation'];
const GATE_UNAVAILABLE_EVIDENCE_CLASSES = ['skipped_check', 'environmental_blocker'];

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertUniqueStringArray(value, label, { pattern, allowEmpty = false } = {}) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  if (!allowEmpty) assert.ok(value.length > 0, `${label} must not be empty`);
  const observed = new Set();
  for (const item of value) {
    assert.equal(typeof item, 'string', `${label} values must be strings`);
    if (pattern) assert.match(item, pattern, `${label} contains malformed value ${item}`);
    assert.ok(!observed.has(item), `${label} contains duplicate ${item}`);
    observed.add(item);
  }
  return observed;
}

function expectedRequirementIds() {
  return [...STORY_REQUIREMENT_COUNTS].flatMap(([storyId, count]) =>
    Array.from({ length: count }, (_, index) => `${storyId}-R${String(index + 1).padStart(2, '0')}`),
  );
}

export function loadWaveQualificationTraceability() {
  const requirementsBytes = fs.readFileSync(requirementsPath);
  return {
    registry: JSON.parse(fs.readFileSync(registryPath, 'utf8')),
    crossReference: JSON.parse(fs.readFileSync(crossReferencePath, 'utf8')),
    requirementsArtifact: JSON.parse(requirementsBytes.toString('utf8')),
    requirementsBytes,
  };
}

export function validateWaveQualificationTraceability({
  registry,
  crossReference,
  requirementsArtifact,
  requirementsBytes,
}) {
  assert.ok(Buffer.isBuffer(requirementsBytes), 'requirements artifact bytes must be provided');
  assert.deepEqual(
    JSON.parse(requirementsBytes.toString('utf8')),
    requirementsArtifact,
    'requirements object must be parsed from the checked-in artifact bytes',
  );
  assert.equal(sha256(requirementsBytes), REQUIREMENTS_ARTIFACT_SHA256, 'immutable requirements artifact hash changed');

  assert.equal(registry.schemaVersion, 1, 'unsupported invariant registry schema');
  assert.equal(registry.registryId, 'rorca-wave-parallel-qualification-v1', 'unexpected invariant registry ID');
  assert.ok(Array.isArray(registry.invariants), 'invariants must be an array');
  assert.ok(Array.isArray(registry.scenarios), 'scenarios must be an array');

  const invariantIds = new Set();
  for (const invariant of registry.invariants) {
    assert.equal(REQUIRED_INVARIANTS.get(invariant.id), invariant.name, `unexpected invariant ${invariant.id}`);
    assert.ok(
      typeof invariant.statement === 'string' && invariant.statement.length > 20,
      `${invariant.id} needs an executable statement`,
    );
    assert.ok(!invariantIds.has(invariant.id), `duplicate invariant ${invariant.id}`);
    invariantIds.add(invariant.id);
  }
  assert.deepEqual(invariantIds, new Set(REQUIRED_INVARIANTS.keys()), 'required invariant set changed');

  const scenarioIds = new Set();
  const scenariosById = new Map();
  const registryMappedInvariantIds = new Set();
  for (const scenario of registry.scenarios) {
    assert.match(scenario.id, /^WPE-Q-\d{3}$/, 'scenario ID must be stable and machine-readable');
    assert.ok(!scenarioIds.has(scenario.id), `duplicate scenario ${scenario.id}`);
    assert.ok(typeof scenario.name === 'string' && scenario.name.length > 5, `${scenario.id} needs a stable name`);
    const mappings = assertUniqueStringArray(scenario.invariantIds, `${scenario.id}.invariantIds`);
    for (const invariantId of mappings) {
      assert.ok(invariantIds.has(invariantId), `${scenario.id} maps unknown invariant ${invariantId}`);
      registryMappedInvariantIds.add(invariantId);
    }
    scenarioIds.add(scenario.id);
    scenariosById.set(scenario.id, scenario);
  }
  assert.deepEqual(registryMappedInvariantIds, invariantIds, 'every invariant must have qualification coverage');
  assert.equal(scenarioIds.size, 10, 'the v1 scenario catalog must contain exactly 10 scenarios');
  assert.deepEqual(
    new Set(scenariosById.get('WPE-Q-005')?.invariantIds),
    invariantIds,
    'production negative must exercise every invariant',
  );
  assert.ok(scenarioIds.has('WPE-Q-010'), 'auditable evidence scenario is required');

  assert.equal(requirementsArtifact.schemaVersion, 1, 'unsupported requirements artifact schema');
  assert.equal(
    requirementsArtifact.artifactId,
    'rorca-wave-parallel-canonical-requirements-v1',
    'unexpected requirements artifact ID',
  );
  assert.equal(requirementsArtifact.status, 'immutable', 'requirements artifact must be immutable');
  assert.equal(requirementsArtifact.sourceSpec?.id, 'state-of-the-art-safe-wave-parallel-execution-qualification-and-production-enabl');
  assert.equal(requirementsArtifact.sourceSpec?.slug, requirementsArtifact.sourceSpec?.id, 'source spec slug must match its ID');
  assert.equal(requirementsArtifact.sourceSpec?.hashAlgorithm, 'sha256', 'source spec hash algorithm changed');
  assert.equal(requirementsArtifact.sourceSpec?.sha256, CANONICAL_SPEC_SHA256, 'canonical source spec hash changed');
  assert.equal(requirementsArtifact.sourceSpec?.byteLength, CANONICAL_SPEC_BYTE_LENGTH, 'canonical source spec byte length changed');
  assert.equal(requirementsArtifact.storyCount, STORY_REQUIREMENT_COUNTS.size, 'source story count changed');
  assert.equal(requirementsArtifact.acceptanceCriteriaCount, 125, 'source acceptance-criteria count changed');
  assert.equal(
    requirementsArtifact.requirementIdScheme,
    '<story-id>-R<one-based two-digit acceptance-criterion ordinal>',
    'requirement ID scheme changed',
  );
  assert.ok(Array.isArray(requirementsArtifact.stories), 'requirements stories must be an array');
  assert.equal(requirementsArtifact.stories.length, STORY_REQUIREMENT_COUNTS.size, 'requirements story list is incomplete');

  const expectedIds = expectedRequirementIds();
  const expectedIdSet = new Set(expectedIds);
  const artifactRequirementIds = new Set();
  const artifactRequirementTexts = new Set();
  const artifactRequirementsById = new Map();
  const flattenedRequirements = [];

  requirementsArtifact.stories.forEach((story, storyIndex) => {
    const [expectedStoryId, expectedCount] = [...STORY_REQUIREMENT_COUNTS][storyIndex];
    assert.equal(story.storyId, expectedStoryId, `story order or identity changed at position ${storyIndex + 1}`);
    assert.ok(typeof story.title === 'string' && story.title.length > 10, `${story.storyId} needs its canonical title`);
    assert.ok(Array.isArray(story.acceptanceCriteria), `${story.storyId}.acceptanceCriteria must be an array`);
    assert.equal(story.acceptanceCriteria.length, expectedCount, `${story.storyId} acceptance-criteria count changed`);

    story.acceptanceCriteria.forEach((requirement, requirementIndex) => {
      const ordinal = requirementIndex + 1;
      const requirementId = `${story.storyId}-R${String(ordinal).padStart(2, '0')}`;
      assert.equal(requirement.requirementId, requirementId, `${story.storyId} requirement order or ID changed`);
      assert.equal(requirement.ordinal, ordinal, `${requirementId} ordinal changed`);
      assert.ok(
        typeof requirement.text === 'string' && requirement.text.length > 40,
        `${requirementId} must preserve its complete acceptance criterion`,
      );
      assert.ok(!artifactRequirementIds.has(requirementId), `duplicate artifact requirement ${requirementId}`);
      assert.ok(!artifactRequirementTexts.has(requirement.text), `${requirementId} duplicates another acceptance criterion`);
      artifactRequirementIds.add(requirementId);
      artifactRequirementTexts.add(requirement.text);
      artifactRequirementsById.set(requirementId, { storyId: story.storyId, ...requirement });
      flattenedRequirements.push({
        requirementId,
        storyId: story.storyId,
        ordinal,
        text: requirement.text,
      });
    });
  });

  assert.equal(artifactRequirementIds.size, 125, 'requirements artifact must contain exactly 125 unique IDs');
  assert.deepEqual(artifactRequirementIds, expectedIdSet, 'requirements artifact ID set changed');
  assert.equal(
    requirementsArtifact.integrity?.canonicalization,
    'UTF-8 JSON.stringify of flattened [{requirementId,storyId,ordinal,text}] in story and ordinal order',
    'requirements canonicalization changed',
  );
  const requirementsContentHash = sha256(Buffer.from(JSON.stringify(flattenedRequirements), 'utf8'));
  assert.equal(requirementsContentHash, REQUIREMENTS_CONTENT_SHA256, 'canonical acceptance-criteria content changed');
  assert.equal(
    requirementsArtifact.integrity?.requirementsSha256,
    requirementsContentHash,
    'requirements content digest does not match the artifact',
  );

  assert.equal(crossReference.schemaVersion, 1, 'unsupported cross-reference schema');
  assert.equal(
    crossReference.indexId,
    'rorca-wave-parallel-production-cross-reference-v1',
    'unexpected cross-reference index ID',
  );
  assert.equal(crossReference.requirementsArtifact?.path, 'requirements.json', 'cross-reference must use the local artifact');
  assert.equal(crossReference.requirementsArtifact?.hashAlgorithm, 'sha256', 'artifact hash algorithm changed');
  assert.equal(
    crossReference.requirementsArtifact?.sha256,
    REQUIREMENTS_ARTIFACT_SHA256,
    'cross-reference points at a different requirements artifact',
  );
  assert.equal(
    crossReference.requirementsArtifact?.sourceSpecSha256,
    CANONICAL_SPEC_SHA256,
    'cross-reference source spec hash changed',
  );
  assert.equal(crossReference.requirementsArtifact?.acceptanceCriteriaCount, 125, 'cross-reference count changed');

  const taxonomy = crossReference.evidenceClassTaxonomy;
  assert.ok(taxonomy && typeof taxonomy === 'object', 'evidence class taxonomy is required');
  assertUniqueStringArray(taxonomy.recognized, 'evidenceClassTaxonomy.recognized');
  assertUniqueStringArray(taxonomy.measured, 'evidenceClassTaxonomy.measured');
  assertUniqueStringArray(taxonomy.supporting, 'evidenceClassTaxonomy.supporting');
  assertUniqueStringArray(taxonomy.gateUnavailable, 'evidenceClassTaxonomy.gateUnavailable');
  assert.deepEqual(taxonomy.recognized, RECOGNIZED_EVIDENCE_CLASSES, 'recognized evidence classes changed');
  assert.deepEqual(taxonomy.measured, MEASURED_EVIDENCE_CLASSES, 'measured evidence classes changed');
  assert.deepEqual(taxonomy.supporting, SUPPORTING_EVIDENCE_CLASSES, 'supporting evidence classes changed');
  assert.deepEqual(taxonomy.gateUnavailable, GATE_UNAVAILABLE_EVIDENCE_CLASSES, 'gate-unavailable classes changed');
  assert.ok(taxonomy.measured.includes('canary_soak'), 'canary_soak must remain accepted measured evidence');
  assert.ok(taxonomy.measured.includes('rollback_rehearsal'), 'rollback_rehearsal must remain accepted measured evidence');

  assert.ok(Array.isArray(crossReference.entries), 'cross-reference entries must be an array');
  assert.equal(crossReference.entries.length, 125, 'cross-reference must contain exactly 125 entries');
  const orderedCrossReferenceIds = crossReference.entries.map(entry => entry.requirementId);
  assertUniqueStringArray(orderedCrossReferenceIds, 'cross-reference requirement IDs', {
    pattern: /^WPE-\d{3}-R\d{2}$/,
  });
  assert.deepEqual(
    orderedCrossReferenceIds,
    expectedIds,
    'cross-reference must contain every canonical requirement exactly once in source order',
  );

  const observedRequirementIds = new Set();
  const observedAssertionIds = new Set();
  const mappedInvariantIds = new Set();
  const mappedScenarioIds = new Set();
  const mappedEvidenceClasses = new Set();
  const entriesPerStory = new Map([...STORY_REQUIREMENT_COUNTS.keys()].map(storyId => [storyId, 0]));
  const recognizedEvidenceSet = new Set(RECOGNIZED_EVIDENCE_CLASSES);

  for (const entry of crossReference.entries) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['assertionIds', 'evidenceClasses', 'invariantIds', 'requirementId', 'scenarioIds', 'storyId'].sort(),
      `${entry.requirementId} has unexpected or missing mapping fields`,
    );
    assert.ok(expectedIdSet.has(entry.requirementId), `unknown requirement ${entry.requirementId}`);
    assert.ok(!observedRequirementIds.has(entry.requirementId), `duplicate requirement ${entry.requirementId}`);
    const artifactRequirement = artifactRequirementsById.get(entry.requirementId);
    assert.equal(entry.storyId, artifactRequirement.storyId, `${entry.requirementId} maps to the wrong story`);
    entriesPerStory.set(entry.storyId, entriesPerStory.get(entry.storyId) + 1);

    const entryInvariantIds = assertUniqueStringArray(entry.invariantIds, `${entry.requirementId}.invariantIds`);
    const entryScenarioIds = assertUniqueStringArray(entry.scenarioIds, `${entry.requirementId}.scenarioIds`);
    const assertionPattern = new RegExp(`^WPE-A-${entry.requirementId.slice(4)}-[A-Z0-9]+(?:-[A-Z0-9]+)*$`);
    const assertionIds = assertUniqueStringArray(entry.assertionIds, `${entry.requirementId}.assertionIds`, {
      pattern: assertionPattern,
    });
    const entryEvidenceClasses = assertUniqueStringArray(entry.evidenceClasses, `${entry.requirementId}.evidenceClasses`);

    const scenarioInvariantUnion = new Set();
    for (const scenarioId of entryScenarioIds) {
      assert.ok(scenarioIds.has(scenarioId), `${entry.requirementId} maps unknown scenario ${scenarioId}`);
      const scenarioInvariantIds = new Set(scenariosById.get(scenarioId).invariantIds);
      assert.ok(
        [...entryInvariantIds].some(invariantId => scenarioInvariantIds.has(invariantId)),
        `${entry.requirementId} maps scenario ${scenarioId} without a related invariant`,
      );
      for (const invariantId of scenarioInvariantIds) scenarioInvariantUnion.add(invariantId);
      mappedScenarioIds.add(scenarioId);
    }
    for (const invariantId of entryInvariantIds) {
      assert.ok(invariantIds.has(invariantId), `${entry.requirementId} maps unknown invariant ${invariantId}`);
      assert.ok(
        scenarioInvariantUnion.has(invariantId),
        `${entry.requirementId} invariant ${invariantId} is not exercised by its mapped scenarios`,
      );
      mappedInvariantIds.add(invariantId);
    }
    for (const assertionId of assertionIds) {
      assert.ok(!observedAssertionIds.has(assertionId), `duplicate assertion ${assertionId}`);
      observedAssertionIds.add(assertionId);
    }
    for (const evidenceClass of entryEvidenceClasses) {
      assert.ok(recognizedEvidenceSet.has(evidenceClass), `${entry.requirementId} has unknown evidence class ${evidenceClass}`);
      mappedEvidenceClasses.add(evidenceClass);
    }
    observedRequirementIds.add(entry.requirementId);
  }

  assert.deepEqual(observedRequirementIds, expectedIdSet, 'every canonical requirement must be cross-referenced exactly once');
  assert.equal(observedAssertionIds.size, 125, 'each requirement must have one globally unique executable assertion ID');
  assert.deepEqual(mappedInvariantIds, invariantIds, 'cross-reference must cover every invariant');
  assert.deepEqual(mappedScenarioIds, scenarioIds, 'cross-reference must cover every scenario');
  for (const evidenceClass of MEASURED_EVIDENCE_CLASSES) {
    assert.ok(mappedEvidenceClasses.has(evidenceClass), `measured evidence class ${evidenceClass} has no requirement mapping`);
  }
  for (const [storyId, expectedCount] of STORY_REQUIREMENT_COUNTS) {
    assert.equal(entriesPerStory.get(storyId), expectedCount, `${storyId} cross-reference coverage is incomplete`);
  }

  return {
    invariantCount: invariantIds.size,
    scenarioCount: scenarioIds.size,
    storyCount: STORY_REQUIREMENT_COUNTS.size,
    requirementCount: artifactRequirementIds.size,
    crossReferenceCount: observedRequirementIds.size,
  };
}

export function main() {
  const traceability = loadWaveQualificationTraceability();
  const result = validateWaveQualificationTraceability(traceability);
  const compiledSource = fs.readFileSync(compiledAssertionRegistryPath, 'utf8');
  const compiledMatch = compiledSource.match(/Object\.freeze\((\[[\s\S]*\]) as const\)/);
  assert.ok(compiledMatch, 'compiled canonical assertion registry is unreadable');
  const compiledIds = JSON.parse(compiledMatch[1]);
  const crossReferenceIds = traceability.crossReference.entries.flatMap(entry => entry.assertionIds).sort();
  assert.deepEqual(compiledIds, crossReferenceIds, 'compiled canonical assertion registry is stale');
  console.log(
    `Wave qualification traceability valid: ${result.invariantCount} invariants, ` +
      `${result.scenarioCount} scenarios, ${result.storyCount} stories, ` +
      `${result.requirementCount} requirements, ${result.crossReferenceCount} cross-references`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
