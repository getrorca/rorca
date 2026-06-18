/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  legacyLingeringJobKanbanState,
  newestEditKanbanState,
  specEditReEnrichmentCases,
  type EditRegressionCase,
  type SpecDiskSnapshot,
} from './fixtures/spec-edit-re-enrichment-fixture';

function writeDiskSnapshot(root: string, snapshot: SpecDiskSnapshot): unknown {
  const absolutePath = join(root, snapshot.relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(snapshot.json, null, 2)}\n`, 'utf8');
  return JSON.parse(readFileSync(absolutePath, 'utf8')) as unknown;
}

function expectStageAndGenerationState(regressionCase: EditRegressionCase): void {
  expect(regressionCase.before.generationLog.status).toBe(regressionCase.expected.beforeGenerationStatus);
  expect(regressionCase.after.generationLog.status).toBe(regressionCase.expected.afterGenerationStatus);
  expect(regressionCase.before.generationLog.context_summary_json.postSaveStages)
    .toEqual(regressionCase.expected.beforePostSaveStages);
  expect(regressionCase.after.generationLog.context_summary_json.postSaveStages)
    .toEqual(regressionCase.expected.afterPostSaveStages);
}

function expectJobState(regressionCase: EditRegressionCase): void {
  expect(regressionCase.before.specJobs.map(({ id, job_type, status }) => ({ id, job_type, status })))
    .toEqual(regressionCase.expected.beforeJobStates);
  expect(regressionCase.after.specJobs.map(({ id, job_type, status }) => ({ id, job_type, status })))
    .toEqual(regressionCase.expected.afterJobStates);
}

describe('RER-001 spec-edit re-enrichment regression fixture', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'rorca-rer-001-'));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('covers all required edit classes', () => {
    expect(specEditReEnrichmentCases.map((regressionCase) => regressionCase.editClass).sort()).toEqual([
      'context-affecting',
      'metadata-only',
      'rapid-successive-saves',
      'story-content-only',
    ]);
  });

  it.each(specEditReEnrichmentCases)('$editClass: captures before/after jobs, generation logs, postSaveStages, and disk spec', (regressionCase) => {
    expect(regressionCase.before.diskSpec.relativePath).toBe(`forge/specs/approved/${regressionCase.specId}.json`);
    expect(regressionCase.after.diskSpec.relativePath).toBe(`forge/specs/approved/${regressionCase.specId}.json`);
    expect(regressionCase.before.diskSpec.relativePath).not.toContain(regressionCase.before.diskSpec.json.specName);

    const beforeDiskJson = writeDiskSnapshot(tempRoot, regressionCase.before.diskSpec);
    const afterDiskJson = writeDiskSnapshot(tempRoot, regressionCase.after.diskSpec);

    expect(beforeDiskJson).toEqual(regressionCase.before.diskSpec.json);
    expect(afterDiskJson).toEqual(regressionCase.after.diskSpec.json);
    expect(regressionCase.before.dbSpecRow.edit_revision).toBe(regressionCase.before.generationLog.context_summary_json.editRevision);
    expect(regressionCase.after.dbSpecRow.edit_revision).toBe(regressionCase.after.generationLog.context_summary_json.editRevision);

    expectJobState(regressionCase);
    expectStageAndGenerationState(regressionCase);
    expect(newestEditKanbanState(regressionCase.before.specJobs)).toEqual(regressionCase.expected.beforeKanbanActiveState);
    expect(newestEditKanbanState(regressionCase.after.specJobs)).toEqual(regressionCase.expected.afterKanbanActiveState);
  });

  it('metadata-only edits do not trigger re-enrichment or context resynthesis', () => {
    const regressionCase = specEditReEnrichmentCases.find((candidate) => candidate.editClass === 'metadata-only');
    expect(regressionCase).toBeDefined();
    if (!regressionCase) return;

    expect(regressionCase.after.specJobs).toHaveLength(regressionCase.before.specJobs.length);
    expect(regressionCase.after.generationLog.context_summary_json.generationFingerprint)
      .toBe(regressionCase.before.generationLog.context_summary_json.generationFingerprint);
    expect(regressionCase.after.generationLog.context_summary_json.contextFingerprint)
      .toBe(regressionCase.before.generationLog.context_summary_json.contextFingerprint);
    expect(regressionCase.after.generationLog.context_summary_json.postSaveStages)
      .toEqual(regressionCase.before.generationLog.context_summary_json.postSaveStages);
  });

  it('context-affecting edits snapshot both the DB row and slug-based spec JSON on disk', () => {
    const regressionCase = specEditReEnrichmentCases.find((candidate) => candidate.editClass === 'context-affecting');
    expect(regressionCase).toBeDefined();
    if (!regressionCase) return;

    expect(regressionCase.after.dbSpecRow.context_fingerprint).toBe('ctx-v2');
    expect(regressionCase.after.diskSpec.json.context.stageFingerprint).toBe('ctx-v2');
    expect(regressionCase.after.generationLog.context_summary_json.contextUsed)
      .toContain(`forge/specs/approved/${regressionCase.specId}.json`);
    expect(regressionCase.after.diskSpec.relativePath).toBe(`forge/specs/approved/${regressionCase.specId}.json`);
    expect(regressionCase.after.diskSpec.relativePath).not.toBe(`specs/approved/${regressionCase.after.diskSpec.json.specName}.json`);
  });

  it('rapid successive saves reproduce stale older jobs but expose latest-wins state', () => {
    const regressionCase = specEditReEnrichmentCases.find((candidate) => candidate.editClass === 'rapid-successive-saves');
    expect(regressionCase).toBeDefined();
    if (!regressionCase) return;

    const lingeringOlderJobs = regressionCase.after.specJobs.filter((row) => (
      row.request_payload.editRevision === 2 && (row.status === 'pending' || row.status === 'running')
    ));
    expect(lingeringOlderJobs.map((row) => row.id).sort()).toEqual(['job-rapid-v2-enrich', 'job-rapid-v2-match']);
    expect(lingeringOlderJobs.every((row) => row.request_payload.supersededByRevision === 3)).toBe(true);
    expect(lingeringOlderJobs.every((row) => row.result_payload?.applied !== true)).toBe(true);

    expect(legacyLingeringJobKanbanState(regressionCase.after.specJobs))
      .toEqual(regressionCase.expected.legacyStuckKanbanState);
    expect(newestEditKanbanState(regressionCase.after.specJobs))
      .toEqual(regressionCase.expected.afterKanbanActiveState);

    const finalAppliedJobs = regressionCase.after.specJobs.filter((row) => row.result_payload?.applied === true);
    expect(finalAppliedJobs.map((row) => row.request_payload.editRevision)).toEqual([1, 1, 3, 3]);
    expect(regressionCase.after.generationLog.context_summary_json.editRevision).toBe(3);
    expect(regressionCase.after.generationLog.context_summary_json.postSaveStages.enrich.jobId).toBe('job-rapid-v3-enrich');
    expect(regressionCase.after.generationLog.context_summary_json.postSaveStages.matchSkills.jobId).toBe('job-rapid-v3-match');
  });
});
