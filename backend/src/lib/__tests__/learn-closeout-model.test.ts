/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

const mockChat = jest.fn();

jest.mock('../llm-client', () => ({ chatComplete: (...args: unknown[]) => mockChat(...args) }));
jest.mock('../workflow-config-resolver', () => ({
  resolveWorkflowConfig: jest.fn().mockResolvedValue({ provider: 'test', model: 'test-model', apiKey: null, baseUrl: null }),
}));

import { summarizeLearnCandidates, type LearnCandidateInput } from '../learn-closeout';

const candidate: LearnCandidateInput = {
  factType: 'validation_classification',
  category: 'Pattern',
  content: 'Host validation classified story LFC-027 as passed for commit sha abc123.',
  confidence: 'high',
  storyId: 'LFC-027',
  sourceEvidenceIds: ['7'],
  sourceDecisionIds: [],
  releaseSubject: { type: 'commit_sha', value: 'abc123' },
  commitSha: 'abc123',
  securitySensitive: false,
  reviewReason: 'verified_delivery_fact_requires_human_review',
  normalizedFact: 'host validation classified story lfc 027 as passed for commit sha abc123',
  dedupeKey: 'sha256:dedupe',
};

describe('Learn closeout optional summarization', () => {
  beforeEach(() => mockChat.mockReset());

  test('degrades to the deterministic candidate with a typed retryable blocker', async () => {
    mockChat.mockRejectedValueOnce(new Error('provider unavailable'));
    const result = await summarizeLearnCandidates([candidate], true);
    expect(result.candidates).toEqual([candidate]);
    expect(result.applied).toBe(0);
    expect(result.blocker).toMatchObject({ code: 'model_unavailable', retryable: true });
  });

  test('rejects unsupported model claims without changing provenance or review policy', async () => {
    mockChat.mockResolvedValueOnce({ text: 'Production deployment succeeded for every tenant.', usage: {} });
    const result = await summarizeLearnCandidates([candidate], true);
    expect(result.candidates).toEqual([candidate]);
    expect(result.applied).toBe(0);
    expect(result.candidates[0]).toMatchObject({
      sourceEvidenceIds: ['7'],
      dedupeKey: 'sha256:dedupe',
      reviewReason: 'verified_delivery_fact_requires_human_review',
    });
  });
});
