/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertBountyDirectAutoMemoryForbidden,
  evaluateBountyReflectionMatches,
  sanitizeBountyLessonDraft,
  type BountyReflectionKind,
} from '../bounty-reflection';
import { ForbiddenError } from '../errors';

const root = process.cwd().endsWith(`${path.sep}backend`) ? process.cwd() : path.join(process.cwd(), 'backend');
const source = fs.readFileSync(path.join(root, 'src/lib/bounty-reflection.ts'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'src/lib/bounty-controller.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'src/db/pg-migrations/20260803190000_bounty_program_reflection.sql'), 'utf8');
const route = fs.readFileSync(path.join(root, 'src/routes/bounty-reflections.ts'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');

const kinds: Array<[BountyReflectionKind, string]> = [
  ['false-positive', 'REFLECTION_FALSE_POSITIVE'],
  ['rejection', 'REFLECTION_REJECTED'],
  ['duplicate', 'REFLECTION_DUPLICATE'],
  ['dead-gadget', 'REFLECTION_DEAD_GADGET'],
  ['disclosure', 'REFLECTION_ALREADY_DISCLOSED'],
];

test('every reflection pass/fail path has a visible reason code', () => {
  assert.deepEqual(evaluateBountyReflectionMatches('route', []), {
    boundary: 'route', decision: 'allow', reasonCodes: ['REFLECTION_ROUTE_CLEAR'], matchedReflectionIds: [],
  });
  assert.deepEqual(evaluateBountyReflectionMatches('candidate-admission', []), {
    boundary: 'candidate-admission', decision: 'allow', reasonCodes: ['REFLECTION_CANDIDATE_CLEAR'], matchedReflectionIds: [],
  });
  for (const [kind, reasonCode] of kinds) {
    const decision = evaluateBountyReflectionMatches('route', [{ id: `id-${kind}`, reflection_kind: kind }]);
    assert.equal(decision.decision, 'block');
    assert.deepEqual(decision.reasonCodes, [reasonCode]);
  }
});

test('pending candidate bytes redact credentials, targets, evidence, and identifiers by default', () => {
  const candidate = sanitizeBountyLessonDraft({
    category: 'Pattern',
    title: 'Avoid https://victim.example.com for accountId=tenant-77',
    rule: 'password=hunter2 and api_key=sk-live-secret must not persist',
    context: 'evidence_payload: private response for 123e4567-e89b-42d3-a456-426614174000',
  });
  const bytes = candidate.bytes.toString('utf8');
  for (const sensitive of ['victim.example.com', 'tenant-77', 'hunter2', 'sk-live-secret', 'private response', '123e4567-e89b-42d3-a456-426614174000']) {
    assert.equal(bytes.includes(sensitive), false, sensitive);
  }
  assert.deepEqual(candidate.redactionManifest.defaultExclusions, ['credential', 'target-content', 'sensitive-evidence', 'identifier']);
  assert.deepEqual(new Set(candidate.redactionManifest.redactions.map((entry) => entry.reasonCode)), new Set([
    'EXCLUDED_CREDENTIAL', 'EXCLUDED_TARGET_CONTENT', 'EXCLUDED_SENSITIVE_EVIDENCE', 'EXCLUDED_IDENTIFIER',
  ]));
  assert.match(candidate.hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(candidate.redactionManifestHash, /^sha256:[0-9a-f]{64}$/);
});

test('all bounty identity forms fail direct auto-memory', () => {
  for (const identity of [
    { workspaceId: 'workspace-1', programId: 'program-1' },
    { workspaceId: 'workspace-1', missionId: 'mission-1' },
    { workspaceId: 'workspace-1', findingId: 'finding-1' },
  ]) {
    assert.throws(() => assertBountyDirectAutoMemoryForbidden(identity), (error: unknown) => {
      assert.ok(error instanceof ForbiddenError);
      assert.deepEqual(error.details?.reasonCodes, ['BOUNTY_DIRECT_AUTO_MEMORY_FORBIDDEN']);
      return true;
    });
  }
});

test('reflection runs before route and candidate admission and remains program-scoped', () => {
  assert.ok(controller.indexOf('await checkBountyReflectionBeforeRoute') < controller.indexOf('routeBountyWorkPackages(command.routeInput)'));
  assert.match(source, /boundary: 'candidate-admission'[\s\S]+if \(reflectionCheck\.decision === 'block'\)/);
  assert.match(source, /WHERE workspace_id=\$1 AND program_id=\$2 AND subject_fingerprint=ANY/);
  assert.match(migration, /UNIQUE \(workspace_id, program_id, reflection_kind, subject_fingerprint\)/);
  assert.match(migration, /FOREIGN KEY \(workspace_id, program_id\) REFERENCES bounty_programs/);
  assert.match(migration, /boundary TEXT NOT NULL CHECK \(boundary IN \('route','candidate-admission'\)\)/);
  assert.match(route, /createBountyLessonCandidate/);
  assert.match(route, /Sanitized pending candidate and reflection reason codes/);
});

test('dedupe is program-local and rejected candidates can only revisit through a new revision', () => {
  assert.match(source, /WHERE workspace_id=\$1 AND program_id=\$2 AND candidate_hash=\$3/);
  assert.match(migration, /UNIQUE \(workspace_id, program_id, candidate_hash\)/);
  assert.match(migration, /bounty_lesson_candidate_revision_sequence/);
  assert.match(source, /const revision = Number\(current\.revision\) \+ 1/);
  assert.match(source, /if \(input\.decision === 'rejected'\) return/);
  assert.ok(source.indexOf("if (input.decision === 'rejected') return") < source.indexOf('INSERT INTO bounty_generalized_lessons'));
  assert.doesNotMatch(source, /UPDATE bounty_lesson_candidate_revisions/);
});

test('exact review binds candidate bytes, manifest, closeout, and credential reviewer', () => {
  assert.match(source, /candidate\.candidate_hash !== input\.expectedCandidateHash/);
  assert.match(source, /candidate\.redaction_manifest_hash !== input\.expectedRedactionManifestHash/);
  assert.match(source, /candidate\.closeout_hash !== input\.expectedSourceCloseoutHash/);
  assert.match(source, /sourceCloseoutHash: candidate\.closeout_hash, reviewer: input\.reviewer/);
  assert.match(route, /reviewer: actor\(req\)/);
  assert.match(migration, /UNIQUE \(workspace_id, candidate_revision_id\)/);
  assert.match(migration, /bounty_lesson_candidate_reviews_immutable/);
});

test('pending and rejected candidates are retrieval-invisible while reviewed lessons may cross programs', () => {
  const view = migration.match(/CREATE VIEW bounty_pinned_generalized_lessons AS([\s\S]*?);/)?.[1] ?? '';
  assert.match(view, /bounty_generalized_lessons/);
  assert.match(view, /bounty_mission_lesson_pins/);
  assert.doesNotMatch(view, /candidate_revisions|candidate_lineages/);
  assert.match(source, /FROM bounty_pinned_generalized_lessons/);
  assert.match(source, /Explicit operator review surface; this is not memory or mission retrieval/);
  assert.doesNotMatch(source, /INSERT INTO memor(?:y|ies)|autoSynthesizeMemory/);
  assert.match(migration, /source_program_id/);
  const pinTable = migration.match(/CREATE TABLE bounty_mission_lesson_pins \(([\s\S]*?)\n\);/)?.[1] ?? '';
  assert.doesNotMatch(pinTable, /program_id/);
});

test('later missions pin exact hashes and same-mission hot loading fails', () => {
  assert.match(migration, /actual_hash <> NEW\.lesson_hash/);
  assert.match(migration, /source_mission = NEW\.mission_id OR target_created <= source_created/);
  assert.match(source, /lesson\.source_mission_id === input\.missionId/);
  assert.match(source, /target\.rows\[0\]\.created_at <= lesson\.source_created_at/);
  assert.match(source, /LESSON_SAME_MISSION_HOT_LOAD_FORBIDDEN/);
  assert.match(source, /l\.lesson_hash=ANY\(\$2::text\[\]\)/);
});

test('operator routes are strict, non-MCP, and mounted', () => {
  assert.match(route, /\.strict\(\)/);
  assert.equal((route.match(/x-rorca-tier: admin/g) ?? []).length, 8);
  assert.equal((route.match(/x-rorca-mcp: false/g) ?? []).length, 8);
  assert.match(server, /app\.use\('\/api\/admin\/bounty', bountyReflectionsRouter\)/);
});
