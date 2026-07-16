/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  extractLearnCandidateInputs,
  MAX_LEARN_CANDIDATES,
  redactLearnContent,
  toMemoryDraft,
  type LearnCloseoutFacts,
} from '../learn-closeout';

const release = { type: 'commit_sha' as const, value: 'a'.repeat(40) };

function facts(patch: Partial<LearnCloseoutFacts> = {}): LearnCloseoutFacts {
  return {
    workspaceId: 'ws-a',
    specId: 'evidence-learning',
    runId: 42,
    runStatus: 'done',
    retriedFromRunId: null,
    retryReasonCodes: [],
    retrySourceId: null,
    releaseSubject: release,
    commitSha: release.value,
    closedAt: '2026-07-15T12:00:00.000Z',
    mergeStatus: 'merged',
    prNumber: 17,
    acceptedCloseoutCount: 1,
    evidence: [{
      id: '101', storyId: 'LFC-027', classification: 'validation', status: 'passed',
      trustLevel: 'host_observed', sourceType: 'wal_validation', sourceSystem: 'rorca:host',
      subject: release, revisionMismatch: false,
    }],
    decisions: [{
      id: 'CLO-sha256:accepted', storyId: 'LFC-027', decisionType: 'story_closeout',
      status: 'accepted', rationale: null, sourceEvidenceIds: ['101'],
    }],
    ...patch,
  };
}

describe('Learn closeout deterministic extraction', () => {
  it('stages bounded review-only candidates with complete provenance from verified closeout facts', () => {
    const source = facts();
    const candidates = extractLearnCandidateInputs(source);

    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates.length).toBeLessThanOrEqual(MAX_LEARN_CANDIDATES);
    const accepted = candidates.find((item) => item.factType === 'accepted_decision');
    expect(accepted).toMatchObject({
      category: 'Decision', storyId: 'LFC-027', sourceEvidenceIds: ['101'],
      sourceDecisionIds: ['CLO-sha256:accepted'], releaseSubject: release,
    });

    const draft = toMemoryDraft(source, accepted!);
    expect(draft.status).toBe('review_required');
    expect(draft.defaultRetrievalEligible).toBe(false);
    expect(draft.provenance).toMatchObject({
      kind: 'lifecycle_closeout', workspaceId: 'ws-a', specId: 'evidence-learning',
      runId: 42, storyId: 'LFC-027', commitSha: release.value,
      releaseSubject: release, sourceEvidenceIds: ['101'], candidateCategory: 'Decision',
      confidence: 'high', deduplicationKey: accepted!.dedupeKey,
    });
  });

  it('produces no durable learning from agent-proposed evidence or absent accepted packets', () => {
    expect(extractLearnCandidateInputs(facts({ acceptedCloseoutCount: 0 }))).toEqual([]);
    expect(extractLearnCandidateInputs(facts({
      evidence: facts().evidence.map((item) => ({ ...item, trustLevel: 'agent_proposed' })),
    }))).toEqual([]);
  });

  it('deduplicates equivalent retries by normalized fact plus release subject', () => {
    const first = extractLearnCandidateInputs(facts());
    const retry = extractLearnCandidateInputs(facts({ runId: 43 }));
    const firstDecision = first.find((item) => item.factType === 'accepted_decision')!;
    const retryDecision = retry.find((item) => item.factType === 'accepted_decision')!;
    expect(retryDecision.dedupeKey).toBe(firstDecision.dedupeKey);
  });

  it('keeps materially changed release subjects separately reviewable', () => {
    const first = extractLearnCandidateInputs(facts()).find((item) => item.factType === 'accepted_decision')!;
    const changedRelease = { type: 'commit_sha' as const, value: 'b'.repeat(40) };
    const changed = extractLearnCandidateInputs(facts({
      releaseSubject: changedRelease,
      commitSha: changedRelease.value,
      evidence: facts().evidence.map((item) => ({ ...item, subject: changedRelease })),
    })).find((item) => item.factType === 'accepted_decision')!;
    expect(changed.dedupeKey).not.toBe(first.dedupeKey);
  });

  it('preserves conflicting authoritative evidence as a human-review gotcha', () => {
    const candidates = extractLearnCandidateInputs(facts({
      evidence: [
        ...facts().evidence,
        { ...facts().evidence[0], id: '102', status: 'story_caused_failure' },
      ],
    }));
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        factType: 'conflicting_evidence',
        category: 'Gotcha',
        reviewReason: 'conflicting_authoritative_evidence_requires_human_review',
        sourceEvidenceIds: ['101', '102'],
      }),
    ]));
  });

  it('redacts secret, credential, private Slack, customer/tenant, and canary values before output', () => {
    const raw = 'token=abc123 customerId=tenant-44 https://acme.slack.com/archives/private RORCA_SECRET_CANARY_gold';
    const redacted = redactLearnContent(raw);
    expect(redacted.redacted).toBe(true);
    expect(redacted.content).not.toContain('abc123');
    expect(redacted.content).not.toContain('tenant-44');
    expect(redacted.content).not.toContain('acme.slack.com');
    expect(redacted.content).not.toContain('CANARY_gold');

    const unsafeSubject = { type: 'deployment_id' as const, value: 'RORCA_SECRET_CANARY_release' };
    const candidates = extractLearnCandidateInputs(facts({
      releaseSubject: unsafeSubject,
      commitSha: null,
      evidence: facts().evidence.map((item) => ({ ...item, subject: unsafeSubject })),
    }));
    expect(JSON.stringify(candidates)).not.toContain('CANARY_release');
    expect(candidates[0].releaseSubject.value).toMatch(/^redacted:/);
  });

  it('forces production and credential blockers through human review with no auto-promotion', () => {
    const deployment = { type: 'deployment_id' as const, value: 'deploy-9' };
    const source = facts({
      releaseSubject: deployment,
      evidence: [{ ...facts().evidence[0], status: 'environment_credential_blocker', subject: deployment }],
    });
    const candidates = extractLearnCandidateInputs(source);
    expect(candidates.every((item) => item.securitySensitive)).toBe(true);
    expect(candidates.map((item) => toMemoryDraft(source, item)).every((item) => (
      item.status === 'review_required' && item.defaultRetrievalEligible === false
    ))).toBe(true);
  });
});
