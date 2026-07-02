/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { boundRetrievalTelemetryEvent, type RetrievalTelemetryEvent } from '../retrieval-telemetry';
import { PayloadTooLargeError } from '../errors';

const LIMIT_ENV = [
  'RORCA_RETRIEVAL_MAX_CANDIDATES',
  'RORCA_TRACE_MAX_PAYLOAD_BYTES',
  'RORCA_CANDIDATE_MAX_PAYLOAD_BYTES',
];

function baseEvent(overrides: Partial<RetrievalTelemetryEvent> = {}): RetrievalTelemetryEvent {
  return {
    id: 'rt-test',
    workspaceId: 'ws',
    createdAt: new Date(0).toISOString(),
    queryPreview: 'brief',
    matchedSkills: [],
    selectedCandidateKeys: [],
    droppedCandidateKeys: [],
    needsMoreEvidence: false,
    candidateCount: 0,
    selectedCount: 0,
    tokenBudget: 100,
    contradictions: [],
    candidates: [],
    ...overrides,
  };
}

describe('retrieval telemetry payload limits', () => {
  beforeEach(() => {
    for (const key of LIMIT_ENV) delete process.env[key];
  });

  it('caps stored candidates to the configured retrieval candidate limit', () => {
    process.env.RORCA_RETRIEVAL_MAX_CANDIDATES = '2';
    const bounded = boundRetrievalTelemetryEvent(baseEvent({
      candidateCount: 3,
      candidates: [
        { key: 'a', origin: 'cache', finalScore: 1, decision: 'keep', freshnessScore: 1, validatorScore: 1, graphScore: 0, historicalScore: 0, reasons: [], conflictsWith: [] },
        { key: 'b', origin: 'cache', finalScore: 1, decision: 'keep', freshnessScore: 1, validatorScore: 1, graphScore: 0, historicalScore: 0, reasons: [], conflictsWith: [] },
        { key: 'c', origin: 'cache', finalScore: 1, decision: 'drop', freshnessScore: 1, validatorScore: 1, graphScore: 0, historicalScore: 0, reasons: [], conflictsWith: [] },
      ],
    }));
    expect(bounded.candidates.map(candidate => candidate.key)).toEqual(['a', 'b']);
    expect(bounded.candidateCount).toBe(3);
  });

  it('throws an actionable error when the telemetry payload cap is exceeded', () => {
    process.env.RORCA_TRACE_MAX_PAYLOAD_BYTES = '200';
    expect(() => boundRetrievalTelemetryEvent(baseEvent({
      queryPreview: 'x'.repeat(240),
      candidates: [
        { key: 'a', origin: 'cache', finalScore: 1, decision: 'keep', freshnessScore: 1, validatorScore: 1, graphScore: 0, historicalScore: 0, reasons: ['x'.repeat(500)], conflictsWith: [] },
      ],
    }))).toThrow(PayloadTooLargeError);

    try {
      boundRetrievalTelemetryEvent(baseEvent({
        queryPreview: 'x'.repeat(240),
        candidates: [
          { key: 'a', origin: 'cache', finalScore: 1, decision: 'keep', freshnessScore: 1, validatorScore: 1, graphScore: 0, historicalScore: 0, reasons: ['x'.repeat(500)], conflictsWith: [] },
        ],
      }));
    } catch (error) {
      expect((error as Error).message).toMatch(/Retrieval telemetry payload/i);
      expect((error as Error).message).toMatch(/retry/i);
    }
  });
});
