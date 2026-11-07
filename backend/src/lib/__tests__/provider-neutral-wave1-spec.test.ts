/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WAVE_1_SPEC_CONTENT_HASH } from '../wave-1-stabilization';

const root = path.resolve(__dirname, '../../../..');
const specPath = path.join(root, 'forge/specs/pending/wave-1-stabilize-evidence-closeout-and-managed-branch-delivery.json');
const coveragePath = path.join(root, 'docs/implementation/governed-mission-waves-coverage.json');
const specBytes = fs.readFileSync(specPath);
const spec = JSON.parse(specBytes.toString('utf8')) as Record<string, any>;
const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8')) as Record<string, any>;
const specHash = `sha256:${crypto.createHash('sha256').update(specBytes).digest('hex')}`;

test('material provider-neutral revision records exact before/after identity and invalidates stale approval', () => {
  expect(spec.revision).toMatchObject({
    reason: 'provider-neutral-local-first-delivery-pivot',
    material: true,
    previousSpecSha256: 'sha256:0934cdff26bc35d72af84e958114b322186e1b21adacae510fb7fd9ee404425d',
    staleAuthoringApprovalInvalidated: true,
    executionAuthority: 'none',
  });
  expect(spec.authoring).toMatchObject({
    state: 'stale_authoring_preflight',
    approvalReady: false,
    reasonCode: 'stale_authoring_preflight',
    lifecycleCompiler: { state: 'superseded_by_material_edit' },
    executionAuthority: 'none',
  });
  expect(spec.authoring.stale.expectedMaterialHash).not.toBe(spec.authoring.stale.currentMaterialHash);
  expect(spec.authoring.stale.expectedAuthoringMaterialHash).not.toBe(spec.authoring.stale.currentAuthoringMaterialHash);
  expect(spec.userStories.every((story: Record<string, unknown>) => story.passes === false)).toBe(true);

  const wave1 = coverage.specs.find((entry: Record<string, unknown>) => entry.wave === 'wave1');
  expect(wave1.previousSpecSha256).toBe(spec.revision.previousSpecSha256);
  expect(wave1.specSha256).toBe(specHash);
  expect(WAVE_1_SPEC_CONTENT_HASH).toBe(specHash);
});

test('W1-010 criteria are mirrored exactly and make local delivery default while GitHub remains optional', () => {
  const story = spec.userStories.find((entry: Record<string, unknown>) => entry.id === 'W1-010');
  const annotation = spec.authoring.storyAnnotations.find((entry: Record<string, unknown>) => entry.id === 'W1-010');
  const wave1 = coverage.specs.find((entry: Record<string, unknown>) => entry.wave === 'wave1');
  const ledger = wave1.stories.find((entry: Record<string, unknown>) => entry.storyId === 'W1-010');
  expect(story.title).toMatch(/provider-neutral/);
  expect(story.acceptanceCriteria).toHaveLength(6);
  expect(annotation.acceptanceCriteria.map((criterion: Record<string, unknown>) => criterion.text)).toEqual(story.acceptanceCriteria);
  expect(ledger.criteria.map((criterion: Record<string, unknown>) => criterion.text)).toEqual(story.acceptanceCriteria);
  expect(story.acceptanceCriteria[0]).toMatch(/canonical default/);
  expect(story.acceptanceCriteria[0]).toMatch(/GitHub App path remains available only as an explicit optional provider/);
  expect(story.acceptanceCriteria[2]).toMatch(/mergeAuthority=none/);
  expect(story.acceptanceCriteria[5]).toMatch(/independent reviewer/);
  expect(ledger.criteria[5].status).toBe('blocked_final_independent_review');
});

test('separate context-continuation work remains a later controlled integration', () => {
  expect(spec.revision.contextContinuationIntegration).toBe('deferred_to_later_controlled_integration_after_independent_review');
  const architecture = fs.readFileSync(path.join(root, 'docs/architecture/provider-neutral-delivery.md'), 'utf8');
  expect(architecture).toMatch(/spec\/context-continuation-retrieval-contract-20260728/);
  expect(architecture).toMatch(/51df69a6016596df33dc486353620919c2a56c11/);
  expect(architecture).toMatch(/later controlled integration/);
});
