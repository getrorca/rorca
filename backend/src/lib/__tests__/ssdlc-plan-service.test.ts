/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockExecute = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../ssdlc-lifecycle-orchestrator', () => ({
  projectOrEnqueueCurrentLifecyclePlanEvidence: jest.fn().mockResolvedValue(undefined),
}));


import {
  backfillWorkspacePlans,
  compileSpecPlan,
  computeSsdlcPlanInputHash,
} from '../ssdlc-plan-service';
import { deriveCanonicalStoryMaterialHash } from '../ssdlc-forge-authoring';
import { normalizeSsdlcContractJson } from '../ssdlc-contracts';
import { GENERAL_SDLC_7_PROFILE } from '../../ssdlc/profiles/general-sdlc-7';

const workspaceId = 'ws-plan-test';
let workspacePath: string;
let specSlug: string;
let saveGeneration: number | null;
let versionRow: { version: number; content_json: unknown } | undefined;
let currentPlan: any;
let candidatePlan: any;
let concurrentPlan: any;
let tagReadCount: number;
let mutateOnSecondTagRead: (() => void) | null;

function canonicalSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Cosmetic display title',
    _notes: 'operator notes',
    model: 'model-a',
    agentOverride: 'claude',
    effortLevel: 'high',
    thinkingEnabled: true,
    autoWorktree: true,
    userStories: [{
      id: 'LFC-001',
      title: 'Compile lifecycle plan',
      description: 'Compile final canonical story intent.',
      acceptanceCriteria: ['A complete current plan is selected', 'A retry is idempotent'],
      dependsOn: [],
      tags: ['backend'],
      passes: true,
      model: 'story-model-a',
    }],
    ...overrides,
  };
}

function writeSpec(content: Record<string, unknown>, location: 'pending' | 'approved' = 'pending'): string {
  const directory = path.join(workspacePath, 'forge', 'specs', location);
  fs.mkdirSync(directory, { recursive: true });
  const specPath = path.join(directory, `${specSlug}.json`);
  fs.writeFileSync(specPath, JSON.stringify(content, null, 2));
  return specPath;
}

function canonicalHash(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(normalizeSsdlcContractJson(value)).digest('hex')}`;
}


beforeEach(() => {
  jest.clearAllMocks();
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-plan-service-'));
  specSlug = 'safe-lifecycle';
  saveGeneration = 41;
  versionRow = { version: 7, content_json: canonicalSpec() };
  currentPlan = undefined;
  candidatePlan = undefined;
  concurrentPlan = undefined;
  tagReadCount = 0;
  mutateOnSecondTagRead = null;

  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM spec_tags')) {
      tagReadCount += 1;
      if (tagReadCount === 2) mutateOnSecondTagRead?.();
      return [];
    }
    return [];
  });
  mockQueryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM spec_generation_logs')) {
      return saveGeneration === null ? undefined : { save_generation: saveGeneration };
    }
    if (sql.includes('FROM spec_versions')) return versionRow;
    if (sql.includes('FROM ssdlc_compiled_plans')) return currentPlan;
    return undefined;
  });
  mockExecute.mockResolvedValue({ rowCount: 1 });
  mockTransaction.mockImplementation(async (callback: (client: { query: (sql: string, params?: unknown[]) => Promise<any> }) => Promise<any>) => {
    const client = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (sql.includes('is_current = TRUE') && sql.includes('SELECT id::text')) {
          return { rows: concurrentPlan ? [concurrentPlan] : currentPlan ? [currentPlan] : [] };
        }
        if (sql.includes('next_version')) {
          return { rows: [{ next_version: currentPlan ? currentPlan.plan_json.planVersion + 1 : 1 }] };
        }
        if (sql.includes('INSERT INTO ssdlc_compiled_plans')) {
          const plan = JSON.parse(String(params[6]));
          const provenance = JSON.parse(String(params[7]));
          candidatePlan = {
            id: '99',
            spec_version: String(params[2]),
            normalized_input_hash: String(params[4]),
            compiler_version: String(params[3]),
            profile_hash: String(params[8]),
            plan_json: plan,
            provenance_json: provenance,
            created_at: new Date(),
          };
          return { rows: [{ id: '99' }] };
        }
        if (sql.includes('SELECT id::text, validation_status')) {
          return { rows: candidatePlan ? [{ id: candidatePlan.id, validation_status: 'draft', plan_json: candidatePlan.plan_json }] : [] };
        }
        if (sql.includes("validation_status = 'validated'") && sql.includes("validation_status = 'draft'")) {
          currentPlan = candidatePlan;
          return { rows: currentPlan ? [currentPlan] : [] };
        }
        if (sql.includes("validation_status = 'validated'")) {
          currentPlan = candidatePlan ?? concurrentPlan;
          return { rows: currentPlan ? [currentPlan] : [] };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    return callback(client);
  });
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

test('material hash ignores cosmetic title/notes and generated Context while tracking lifecycle inputs', () => {
  const base = canonicalSpec();
  const cosmetic = structuredClone(base);
  cosmetic.title = 'A different display title';
  cosmetic._notes = 'different notes';
  cosmetic.model = 'model-b';
  (cosmetic.userStories as any[])[0].description += '\n\n## Context\n- generated annotation';
  (cosmetic.userStories as any[])[0].passes = false;
  (cosmetic.userStories as any[])[0].model = 'story-model-b';
  expect(computeSsdlcPlanInputHash(cosmetic)).toBe(computeSsdlcPlanInputHash(base));

  expect(computeSsdlcPlanInputHash(base, ['security'])).not.toBe(computeSsdlcPlanInputHash(base));

  for (const changed of [
    canonicalSpec({ userStories: [{ ...(base.userStories as any[])[0], title: 'Material story title' }] }),
    canonicalSpec({ userStories: [{ ...(base.userStories as any[])[0], acceptanceCriteria: ['Changed criterion'] }] }),
    canonicalSpec({ userStories: [{ ...(base.userStories as any[])[0], riskLevel: 'high' }] }),
    canonicalSpec({ tags: ['security'] }),
    canonicalSpec({ lifecycleAnnotations: [{ type: 'profile_hint', profile: 'data-storage' }] }),
  ]) {
    expect(computeSsdlcPlanInputHash(changed)).not.toBe(computeSsdlcPlanInputHash(base));
  }
});

test.each(['pending', 'approved'] as const)('compiles a complete current plan for a %s spec and skips exact replay', async (location) => {
  const content = canonicalSpec();
  writeSpec(content, location);

  const first = await compileSpecPlan({ workspaceId, workspacePath, specSlug, expectedSaveGeneration: 41 });
  expect(first.status).toBe('compiled');
  expect(first.specVersion).toBe('7');
  expect(first.planVersion).toBe(1);
  expect(currentPlan.normalized_input_hash).not.toBe(computeSsdlcPlanInputHash(content));
  expect(currentPlan.provenance_json).toMatchObject({
    specHash: canonicalHash(content),
    materialInputHash: computeSsdlcPlanInputHash(content),
    normalizedInputHash: currentPlan.normalized_input_hash,
    planIdentity: {
      hash: currentPlan.normalized_input_hash,
      exactSpecHash: canonicalHash(content),
      assuranceCompilationReceiptHash: currentPlan.provenance_json.assuranceProfile.compilationReceiptHash,
      repositoryContextHash: currentPlan.provenance_json.assuranceRepositoryContext.hash,
      lifecycleProfileHash: GENERAL_SDLC_7_PROFILE.contentHash,
    },
  });
  expect(currentPlan.provenance_json.assuranceProfile.specRevision.value).toBe(canonicalHash(content));
  expect(currentPlan.provenance_json.assuranceRepositoryContext.mechanisms).toContainEqual({
    mechanismId: `repository-path:canonical-spec:${specSlug}`,
    kind: 'repository-path',
    locator: `forge/specs/${location}/${specSlug}.json`,
  });

  const second = await compileSpecPlan({ workspaceId, workspacePath, specSlug, expectedSaveGeneration: 41 });
  expect(second).toMatchObject({ status: 'skipped', planId: first.planId, planVersion: 1 });
  expect(mockTransaction).toHaveBeenCalledTimes(1);
});

test('a compiler-version change recompiles identical material instead of reusing stale gate semantics', async () => {
  writeSpec(canonicalSpec());
  const first = await compileSpecPlan({ workspaceId, workspacePath, specSlug });
  currentPlan.compiler_version = 'ssdlc-plan-compiler-1';
  currentPlan.plan_json.compilerVersion = 'ssdlc-plan-compiler-1';

  const upgraded = await compileSpecPlan({ workspaceId, workspacePath, specSlug });
  expect(first.compilerVersion).toBe('ssdlc-plan-compiler-5');
  expect(upgraded).toMatchObject({
    status: 'compiled',
    compilerVersion: 'ssdlc-plan-compiler-5',
    planVersion: 2,
  });
});

test('a stage-profile change supersedes the previous plan even when spec material is identical', async () => {
  writeSpec(canonicalSpec());
  await compileSpecPlan({ workspaceId, workspacePath, specSlug });
  // Simulate a plan compiled under a previous general-sdlc-7 mapping: same
  // normalized input hash, different profile hash.
  currentPlan.profile_hash = `sha256:${'f'.repeat(64)}`;
  currentPlan.plan_json.profile.profileHash = `sha256:${'f'.repeat(64)}`;

  const upgraded = await compileSpecPlan({ workspaceId, workspacePath, specSlug });
  expect(upgraded).toMatchObject({
    status: 'compiled',
    planVersion: 2,
    profileHash: GENERAL_SDLC_7_PROFILE.contentHash,
  });
  expect(currentPlan.profile_hash).toBe(GENERAL_SDLC_7_PROFILE.contentHash);
});

test('exact canonical and assurance identity governs reuse even when the material hash is cosmetic-stable', async () => {
  const content = canonicalSpec();
  const specPath = writeSpec(content);
  const first = await compileSpecPlan({ workspaceId, workspacePath, specSlug });

  fs.writeFileSync(specPath, JSON.stringify(content));
  const exactReplay = await compileSpecPlan({ workspaceId, workspacePath, specSlug });
  expect(exactReplay).toMatchObject({ status: 'skipped', planVersion: first.planVersion });

  const cosmetic = canonicalSpec({ title: 'Cosmetic only', _notes: 'new notes' });
  expect(computeSsdlcPlanInputHash(cosmetic)).toBe(computeSsdlcPlanInputHash(content));
  fs.writeFileSync(specPath, JSON.stringify(cosmetic));
  const cosmeticChange = await compileSpecPlan({ workspaceId, workspacePath, specSlug });
  expect(cosmeticChange).toMatchObject({ status: 'compiled', planVersion: 2 });

  const material = canonicalSpec({ userStories: [{ ...(canonicalSpec().userStories as any[])[0], riskLevel: 'high' }] });
  fs.writeFileSync(specPath, JSON.stringify(material));
  versionRow = { version: 8, content_json: material };
  const changed = await compileSpecPlan({ workspaceId, workspacePath, specSlug });
  expect(changed).toMatchObject({ status: 'compiled', planVersion: 3, specVersion: '8', riskLevel: 'high' });
});

test('repository assurance drift creates a new persisted identity for the unchanged exact spec', async () => {
  const content = canonicalSpec();
  writeSpec(content);
  const first = await compileSpecPlan({ workspaceId, workspacePath, specSlug });
  const firstReceipt = currentPlan.provenance_json.assuranceProfile.compilationReceiptHash;
  const firstRepositoryContextHash = currentPlan.provenance_json.assuranceRepositoryContext.hash;

  fs.writeFileSync(path.join(workspacePath, 'package.json'), JSON.stringify({
    scripts: { test: 'jest --runInBand' },
    devDependencies: { jest: '30.0.0' },
  }));
  const changed = await compileSpecPlan({ workspaceId, workspacePath, specSlug });

  expect(changed).toMatchObject({ status: 'compiled', planVersion: 2, specHash: canonicalHash(content) });
  expect(changed.inputHash).not.toBe(first.inputHash);
  expect(currentPlan.provenance_json.assuranceProfile.compilationReceiptHash).not.toBe(firstReceipt);
  expect(currentPlan.provenance_json.assuranceRepositoryContext.hash).not.toBe(firstRepositoryContextHash);
});

test('mechanism config byte drift recompiles unchanged commands and exact spec identity', async () => {
  const content = canonicalSpec();
  writeSpec(content);
  fs.writeFileSync(path.join(workspacePath, 'package.json'), JSON.stringify({
    scripts: { test: 'jest --runInBand' },
    devDependencies: { jest: '30.0.0' },
  }));
  const configPath = path.join(workspacePath, 'jest.config.ts');
  fs.writeFileSync(configPath, 'export default { testMatch: ["**/*.test.ts"] };');
  const first = await compileSpecPlan({ workspaceId, workspacePath, specSlug });
  const firstRepositoryContext = currentPlan.provenance_json.assuranceRepositoryContext;
  const firstMechanisms = structuredClone(firstRepositoryContext.mechanisms);

  fs.writeFileSync(configPath, 'export default { testMatch: ["**/*.unit.test.ts"] };');
  const changed = await compileSpecPlan({ workspaceId, workspacePath, specSlug });

  expect(changed).toMatchObject({ status: 'compiled', planVersion: 2, specHash: canonicalHash(content) });
  expect(changed.inputHash).not.toBe(first.inputHash);
  expect(currentPlan.provenance_json.assuranceRepositoryContext.mechanisms).toEqual(firstMechanisms);
  expect(currentPlan.provenance_json.assuranceRepositoryContext.hash).not.toBe(firstRepositoryContext.hash);
  expect(currentPlan.provenance_json.assuranceRepositoryContext.inspectedArtifacts)
    .toContainEqual(expect.objectContaining({
      path: 'jest.config.ts',
      state: 'hashed',
      contentHash: `sha256:${crypto.createHash('sha256').update('export default { testMatch: ["**/*.unit.test.ts"] };').digest('hex')}`,
    }));
});

test('compiler failure records a retryable reason and leaves the prior current plan untouched', async () => {
  const valid = canonicalSpec();
  writeSpec(valid);
  const prior = await compileSpecPlan({ workspaceId, workspacePath, specSlug });
  const priorRow = currentPlan;

  const invalid = canonicalSpec({ userStories: [{ ...(valid.userStories as any[])[0], acceptanceCriteria: [] }] });
  writeSpec(invalid);
  versionRow = { version: 8, content_json: invalid };
  await expect(compileSpecPlan({ workspaceId, workspacePath, specSlug })).rejects.toMatchObject({
    statusCode: 422,
    code: 'PLAN_COMPILATION_FAILED',
  });
  expect(currentPlan).toBe(priorRow);
  expect(currentPlan.plan_json.planId).toBe(prior.planId);
  expect(mockExecute).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO ssdlc_plan_readiness_reasons'),
    expect.arrayContaining([workspaceId, specSlug]),
  );

  const recovered = canonicalSpec({
    userStories: [{ ...(valid.userStories as any[])[0], title: 'Recovered material title' }],
  });
  writeSpec(recovered);
  versionRow = { version: 9, content_json: recovered };
  const recovery = await compileSpecPlan({ workspaceId, workspacePath, specSlug });
  expect(recovery).toMatchObject({ status: 'compiled', planVersion: 2, specVersion: '9' });
  expect(currentPlan).not.toBe(priorRow);
  expect(mockExecute).toHaveBeenCalledWith(
    expect.stringContaining('SET resolved_at = NOW()'),
    [workspaceId, specSlug],
  );
});

test('legacy specs without a version row compile with a deterministic fallback and do not mutate version history', async () => {
  writeSpec(canonicalSpec(), 'approved');
  saveGeneration = null;
  versionRow = undefined;
  const result = await compileSpecPlan({ workspaceId, workspacePath, specSlug });
  expect(result).toMatchObject({ status: 'compiled', specVersion: '1' });
  expect(mockExecute.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO spec_versions'))).toBe(false);
});

test('accepted authoring-plan identity and preflight hash are verified and carried into provenance', async () => {
  const content = canonicalSpec();
  const authoring: Record<string, unknown> = {
    state: 'validated',
    parentAuthoringPlan: {
      acceptedPlanHash: 'sha256:accepted-plan',
      acceptedPreflightHash: 'sha256:accepted-preflight',
    },
    specReference: 'safe-lifecycle',
    boundary: { ownedRequirementReferences: ['REQ-1'] },
    requirements: [{ reference: 'REQ-1', text: 'Compile safely' }],
    storyAnnotations: [],
  };
  const authoringMaterial = {
    parentAuthoringPlan: authoring.parentAuthoringPlan,
    specReference: authoring.specReference,
    boundary: authoring.boundary,
    requirements: authoring.requirements,
    storyAnnotations: authoring.storyAnnotations,
  };
  authoring.preflight = {
    canonicalMaterialHash: deriveCanonicalStoryMaterialHash(content.userStories as never),
    authoringMaterialHash: `sha256:${crypto.createHash('sha256').update(normalizeSsdlcContractJson(authoringMaterial)).digest('hex')}`,
  };
  content.authoring = authoring;
  writeSpec(content);
  versionRow = { version: 7, content_json: content };

  await expect(compileSpecPlan({ workspaceId, workspacePath, specSlug })).resolves.toMatchObject({ status: 'compiled' });
  expect(currentPlan.provenance_json).toMatchObject({
    acceptedAuthoringPlanHash: 'sha256:accepted-plan',
    acceptedPreflightHash: 'sha256:accepted-preflight',
  });
});

test('stale accepted preflight identity blocks compilation without changing the saved spec', async () => {
  const content = canonicalSpec({
    authoring: {
      state: 'validated',
      parentAuthoringPlan: {
        acceptedPlanHash: 'sha256:accepted-plan',
        acceptedPreflightHash: 'sha256:accepted-preflight',
      },
      preflight: { canonicalMaterialHash: 'sha256:stale-material' },
    },
  });
  const specPath = writeSpec(content);
  const before = fs.readFileSync(specPath, 'utf8');

  await expect(compileSpecPlan({ workspaceId, workspacePath, specSlug })).rejects.toMatchObject({
    code: 'STALE_AUTHORING_PREFLIGHT',
    statusCode: 422,
  });
  expect(fs.readFileSync(specPath, 'utf8')).toBe(before);
  expect(mockTransaction).not.toHaveBeenCalled();
});

test('bounded backfill processes one resumable page and never enqueues jobs', async () => {
  versionRow = undefined;
  saveGeneration = null;
  for (let index = 1; index <= 22; index += 1) {
    const slug = `legacy-${String(index).padStart(2, '0')}`;
    const directory = path.join(workspacePath, 'forge', 'specs', index % 2 === 0 ? 'approved' : 'pending');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${slug}.json`), JSON.stringify({
      userStories: [{ id: `LEG-${index}`, title: 'Legacy', description: 'Legacy', acceptanceCriteria: [] }],
    }));
  }

  const page = await backfillWorkspacePlans({ workspaceId, workspacePath, limit: 20 });
  expect(page.failed).toHaveLength(20);
  expect(page.compiled).toEqual([]);
  expect(page.skipped).toEqual([]);
  expect(page.nextCursor).toBe('legacy-20');
  expect(page.limit).toBe(20);
  expect(mockExecute.mock.calls.some(([sql]) => String(sql).includes('boss.send'))).toBe(false);
});

test('concurrent compilation reuses only an exact plan identity selected under the advisory lock', async () => {
  const content = canonicalSpec();
  writeSpec(content);
  const first = await compileSpecPlan({ workspaceId, workspacePath, specSlug });
  const exactPlan = currentPlan;
  currentPlan = undefined;
  concurrentPlan = exactPlan;
  candidatePlan = undefined;

  const result = await compileSpecPlan({ workspaceId, workspacePath, specSlug });
  expect(result).toMatchObject({ inputHash: first.inputHash, planVersion: 1 });
  expect(candidatePlan).toBeUndefined();
});

test('a concurrent material edit returns a typed stale-generation blocker and exposes no candidate', async () => {
  const specPath = writeSpec(canonicalSpec());
  mutateOnSecondTagRead = () => {
    const changed = canonicalSpec({ userStories: [{ ...(canonicalSpec().userStories as any[])[0], title: 'Newer material title' }] });
    fs.writeFileSync(specPath, JSON.stringify(changed));
  };

  await expect(compileSpecPlan({ workspaceId, workspacePath, specSlug, expectedSaveGeneration: 41 }))
    .rejects.toMatchObject({ code: 'STALE_PLAN_GENERATION', statusCode: 422 });
  expect(mockTransaction).not.toHaveBeenCalled();
  expect(currentPlan).toBeUndefined();
});
