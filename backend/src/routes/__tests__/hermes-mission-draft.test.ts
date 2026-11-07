/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import '../../lib/async-handler';

import express from 'express';
import request from 'supertest';
import { bridgeMissionDraft, deriveFrozenBundleDigest, type MissionDraftPersistencePort, type PersistSpecDraftPayload } from '../../lib/mission-draft-bridge';
import { declareHermesAuthority } from '../../lib/hermes-authority';
import { createHermesMissionDraftRouter } from '../hermes-mission-draft';
import { MISSION_CONTRACT_VERSIONS, type EntityRefV1 } from '../../lib/mission-contracts';
import { assertCurrentAssuranceProfile } from '../../ssdlc/assurance-profile';
import { deriveSourceBundleHash, SOURCE_CONTRACT_VERSIONS, type SourceBundleV1, type SourceRefV1 } from '../../lib/source-contracts';

const HASH = (character: string) => `sha256:${character.repeat(64)}`;
const NOW = new Date().toISOString();

function workspaceRef(): EntityRefV1 {
  return { schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef, workspaceId: 'workspace-one', kind: 'workspace', id: 'workspace-one', label: 'Workspace One' };
}

function sourceBundle(): SourceBundleV1 {
  const source: SourceRefV1 = {
    schemaVersion: SOURCE_CONTRACT_VERSIONS.sourceRef,
    sourceId: 'genesis-package-gen-001', kind: 'genesis_package', locator: 'genesis/packages/gen-001', title: 'Genesis package',
    contentHash: HASH('a'), sourceVersion: '3', reviewStatus: 'approved', sensitivity: 'internal', authority: 'approved_context', selectedSections: ['scope'],
  };
  const citations = [{
    schemaVersion: SOURCE_CONTRACT_VERSIONS.sourceCitation,
    citationId: 'citation-scope', sourceId: source.sourceId, section: 'scope', excerptHash: HASH('b'), rationale: 'Canonical Genesis scope.',
  }] as const;
  const userIntent = 'Deliver the source-verified workflow';
  return {
    schemaVersion: SOURCE_CONTRACT_VERSIONS.sourceBundle, bundleId: 'bundle-one',
    bundleHash: deriveSourceBundleHash({ userIntent, includedSources: [source], citations }),
    userIntent, workspaceRef: workspaceRef(), includedSources: [source], excludedSources: [], conflicts: [], assumptions: [], truncations: [], citations: [...citations], compiledAt: NOW,
  };
}

function bridgeBody(bundle = sourceBundle()) {
  return {
    disposition: {
      schemaVersion: SOURCE_CONTRACT_VERSIONS.intentDisposition, disposition: 'mission_draft', permittedAction: 'draft_mission',
      targetRef: null, draftHash: bundle.bundleHash, frozenBundleDigest: deriveFrozenBundleDigest(bundle),
      rationale: 'Verified bundle may become a draft.', requiredDecision: null,
      auditIdentity: 'hermes@rorca.internal', authorityMode: 'service-audit',
    },
    sourceBundle: bundle,
    genesis: {
      packageId: 'gen-001', packageHash: HASH('c'), contentHash: HASH('a'), canonicalStore: 'pglite+genesis-vault',
      citationSummary: 'One approved Genesis scope citation.', warningCount: 0, skippedEvidenceCount: 0,
      freshnessTs: NOW, bridgeVersion: 'genesis-bridge.v1',
    },
    title: 'Source Verified Workflow', slug: 'source-verified-workflow',
    stories: [{ id: 'HMG-001', title: 'Persist source context', description: 'Freeze exact provenance.', acceptanceCriteria: ['Exact refs survive readback.'], dependsOn: [] }],
    maxBundleAgeSeconds: 900,
    assurance: {
      profileId: 'profile-source-verified-workflow', repositoryContextHash: HASH('d'),
      mechanisms: [{ mechanismId: 'review-workflow', kind: 'review', locator: 'rorca/review/source-verified-workflow' }],
      riskProfile: { level: 'high', tags: ['source-verified'], rationale: 'Supply-chain provenance requires assurance.' },
      applicability: { productProfile: 'api-service', riskProfile: [], domainRegulatory: [] },
    },
  };
}

test('bridges bundle -> explicit persist -> controls -> assurance with exact readback provenance', async () => {
  const calls: Array<{ endpoint: string; payload: PersistSpecDraftPayload }> = [];
  const port: MissionDraftPersistencePort = { persist: async (payload) => {
    calls.push({ endpoint: '/api/specs/persist', payload: structuredClone(payload) });
    return { id: payload.slug, slug: payload.slug, status: 'pending', readback: structuredClone(payload) };
  } };
  const body = bridgeBody();
  const response = await bridgeMissionDraft(body, port);

  expect(calls).toHaveLength(1);
  expect(calls[0].endpoint).toBe('/api/specs/persist');
  expect(calls[0].payload).toMatchObject({
    stories: body.stories,
    source: 'hermes-mission-draft',
    contextUsed: { genesis: body.genesis, meta: { sourceVerification: { bundleHash: body.sourceBundle.bundleHash, sourceRefs: body.sourceBundle.includedSources, sourceBundle: body.sourceBundle } } },
  });
  const persistedProvenance = calls[0].payload.contextUsed.meta.sourceVerification;
  expect(response.provenance.entityRef).toEqual(persistedProvenance.entityRef);
  expect(response.provenance.revisionRef).toEqual(persistedProvenance.revisionRef);
  expect(response.assuranceProfile.specRevision).toEqual(persistedProvenance.revisionRef);
  expect(response.assuranceProfile.sourceContext?.bundleHash).toBe(body.sourceBundle.bundleHash);
  expect(response.assuranceProfile.selectionContext?.applicabilityControlIds).toEqual(response.applicability.activeControlIds);
  expect(response.assuranceProfile.controlInstances.every((control) => control.mechanismBindings.length > 0)).toBe(true);
  expect(response.requirementsReview.specRevision).toEqual(persistedProvenance.revisionRef);
  expect(response.requirementsReview.storyReviews).toEqual([
    expect.objectContaining({ storyId: 'HMG-001', status: 'verified', blockingGaps: [] }),
  ]);
  expect(response.requirementsReview.evidence.every((evidence) => (
    evidence.scope.phaseId === 'requirements'
    && evidence.scope.storyId === 'HMG-001'
    && evidence.subject.value === persistedProvenance.revisionRef.value
  ))).toBe(true);
  expect(response.approvalReady).toBe(true);

  expect(() => assertCurrentAssuranceProfile(response.assuranceProfile, {
    specRef: persistedProvenance.entityRef,
    specRevision: { kind: 'artifact_digest', value: HASH('f') },
    repositoryContextHash: body.assurance.repositoryContextHash,
    sourceBundle: body.sourceBundle,
  })).toThrow(expect.objectContaining({ code: 'SPEC_REVISION_MISMATCH' }));
});

test('rejects persistence readback drift before controls, assurance, review, or execution authority are returned', async () => {
  const body = bridgeBody();
  const persist = jest.fn(async (payload: PersistSpecDraftPayload) => ({
    id: payload.slug,
    slug: payload.slug,
    status: 'pending',
    readback: {
      ...structuredClone(payload),
      contextUsed: {
        ...structuredClone(payload.contextUsed),
        meta: {
          sourceVerification: {
            ...structuredClone(payload.contextUsed.meta.sourceVerification),
            bundleHash: HASH('f'),
          },
        },
      },
    },
  }));

  await expect(bridgeMissionDraft(body, { persist })).rejects.toMatchObject({
    statusCode: 422,
    code: 'SPEC_REVISION_MISMATCH',
  });
  expect(persist).toHaveBeenCalledTimes(1);
});

test.each([
  ['mutated', (body: ReturnType<typeof bridgeBody>) => { body.sourceBundle.assumptions.push({ description: 'post-compilation mutation', sourceIds: [] }); }],
  ['stale', (body: ReturnType<typeof bridgeBody>) => {
    body.sourceBundle.compiledAt = '2020-01-01T00:00:00Z';
    body.disposition.frozenBundleDigest = deriveFrozenBundleDigest(body.sourceBundle);
  }],
] as const)('rejects a %s bundle before any persistence endpoint is invoked', async (_case, mutate) => {
  const persist = jest.fn<Promise<Record<string, unknown>>, [PersistSpecDraftPayload]>();
  const body = bridgeBody();
  mutate(body);
  await expect(bridgeMissionDraft(body, { persist })).rejects.toMatchObject({
    statusCode: 422, code: expect.stringMatching(/SOURCE_BUNDLE_(MUTATED|STALE)/),
  });
  expect(persist).not.toHaveBeenCalled();
});

test('rejects a disposition bundle-hash mismatch before persistence', async () => {
  const persist = jest.fn<Promise<Record<string, unknown>>, [PersistSpecDraftPayload]>();
  const body = bridgeBody();
  body.disposition.draftHash = HASH('f');
  await expect(bridgeMissionDraft(body, { persist })).rejects.toMatchObject({ statusCode: 422, code: 'SOURCE_BUNDLE_MISMATCH' });
  expect(persist).not.toHaveBeenCalled();
});

function authorityApp(authority?: ReturnType<typeof declareHermesAuthority>) {
  const poster = jest.fn(async (payload: PersistSpecDraftPayload) => ({
    id: payload.slug,
    slug: payload.slug,
    status: 'pending',
    readback: structuredClone(payload),
  }));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.hermesAuthority = authority;
    next();
  });
  app.use('/api/hermes/mission-draft', createHermesMissionDraftRouter(poster));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message, code: error.code });
  });
  return { app, poster };
}

describe('Hermes mission draft authority boundary', () => {
  test('allows persistence only with explicit operator-equivalent authority', async () => {
    const { app, poster } = authorityApp(declareHermesAuthority('persist', 'operator-dispatch'));
    const response = await request(app).post('/api/hermes/mission-draft').send(bridgeBody());
    expect(response.status).toBe(200);
    expect(poster).toHaveBeenCalledTimes(1);
  });

  test('returns stale-bundle rejection through the Express error boundary without persisting', async () => {
    const { app, poster } = authorityApp(declareHermesAuthority('persist', 'operator-dispatch'));
    const body = bridgeBody();
    body.sourceBundle.compiledAt = '2020-01-01T00:00:00Z';
    body.disposition.frozenBundleDigest = deriveFrozenBundleDigest(body.sourceBundle);

    const response = await request(app).post('/api/hermes/mission-draft').send(body);
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('SOURCE_BUNDLE_STALE');
    expect(poster).not.toHaveBeenCalled();
  });

  test('denies missing authority instead of falling back to local admin', async () => {
    const { app, poster } = authorityApp();
    const response = await request(app).post('/api/hermes/mission-draft/recompile').send({});
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('HERMES_ACTION_AUTHORITY_DENIED');
    expect(poster).not.toHaveBeenCalled();
  });

  test('denies a declaration from another Hermes surface', async () => {
    const { app, poster } = authorityApp(declareHermesAuthority('subscription', 'service-audit'));
    const response = await request(app).post('/api/hermes/mission-draft/recompile').send({});
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('HERMES_ACTION_AUTHORITY_DENIED');
    expect(poster).not.toHaveBeenCalled();
  });
});
