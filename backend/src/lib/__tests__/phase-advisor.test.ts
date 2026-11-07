/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ValidationError, UnprocessableError } from '../errors';
import { generatePhaseAdvice, PHASE_ADVISOR_MAX_SUGGESTIONS } from '../phase-advisor';
import type { SpecCoverageByPhase } from '../engineering-canon';

const mockChatComplete = jest.fn();
const mockGetLifecycleSpec = jest.fn();
const mockGetLifecycleCoverageByPhase = jest.fn();

jest.mock('../llm-client', () => ({
  chatComplete: (...args: unknown[]) => mockChatComplete(...args),
}));

jest.mock('../ssdlc-lifecycle-read', () => {
  const actual = jest.requireActual('../ssdlc-lifecycle-read');
  return {
    ...actual,
    getLifecycleSpec: (...args: unknown[]) => mockGetLifecycleSpec(...args),
    getLifecycleCoverageByPhase: (...args: unknown[]) => mockGetLifecycleCoverageByPhase(...args),
  };
});

function specFacts(overrides: Record<string, unknown> = {}) {
  return {
    specId: 'spec-a',
    title: 'Billing anomaly alerts',
    state: 'current',
    plan: { version: 3, specVersion: '7', policyVersion: 'policy-1', compilerVersion: 'compiler-1' },
    phaseTimeline: [{ phaseId: 'testing', status: 'blocked' }],
    sourceBundle: {
      includedSources: [{
        sourceId: 'source-brief', title: 'Billing brief', kind: 'local_file', selectedSections: ['scope', 'acceptance'],
      }],
    },
    traceability: {
      requirements: { items: ['REQ-002'] },
      gates: { items: [{ gateId: 'gate-validation', phaseId: 'testing', title: 'Validation gate', status: 'blocked' }] },
    },
    ...overrides,
  };
}

function phaseEntry(overrides: Partial<SpecCoverageByPhase['phases']['testing']> = {}): SpecCoverageByPhase['phases']['testing'] {
  return {
    phaseId: 'testing',
    inScope: true,
    required: [{ requirementId: 'REQ-VALIDATION-2', overlayId: 'overlay.validation', operation: 'review', disposition: 'required', gaps: ['insufficient_evidence'] }],
    covered: [{ requirementId: 'REQ-VALIDATION-1', overlayId: 'overlay.validation', operation: 'review', resolution: 'covered' }],
    uncovered: [{ requirementId: 'REQ-VALIDATION-2', overlayId: 'overlay.validation', operation: 'review', disposition: 'required', gaps: ['insufficient_evidence'] }],
    missingSkills: [],
    nextActions: [{ code: 'attach_approved_evidence', label: 'Attach approved evidence in the required classes.' }],
    genesisPackageIds: ['GEN-PKG-1'],
    ...overrides,
  };
}

function coverageFixture(): Record<string, unknown> {
  return {
    adapterStatus: 'available',
    coveredCells: [],
    uncoveredCells: [],
    nextActions: [],
    evidenceProvenance: { evidenceIds: [], genesisPackageIds: ['GEN-PKG-1'], redacted: true },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetLifecycleSpec.mockResolvedValue(specFacts());
  mockGetLifecycleCoverageByPhase.mockResolvedValue({ coverage: coverageFixture(), phase: phaseEntry() });
});

describe('generatePhaseAdvice', () => {
  test('returns advisory suggestions whose citations come from the phase input context', async () => {
    mockChatComplete.mockResolvedValue({
      text: JSON.stringify({
        suggestions: [
          { text: 'Attach an approved test artifact to the validation gate.', cites: ['REQ-VALIDATION-2', 'source-brief'] },
          { text: 'Confirm the GEN-PKG-1 binding is still intended.', cites: ['CTRL-VALIDATION-GATE'] },
        ],
      }),
      usage: { inputTokens: 100, outputTokens: 40, reasoningTokens: 0 },
    });

    const result = await generatePhaseAdvice({ workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'testing' });

    expect(result.advisory).toBe(true);
    expect(result.specId).toBe('spec-a');
    expect(result.phaseId).toBe('testing');
    expect(result.suggestions).toEqual([
      { text: 'Attach an approved test artifact to the validation gate.', cites: ['REQ-VALIDATION-2', 'source-brief'] },
      { text: 'Confirm the GEN-PKG-1 binding is still intended.', cites: ['CTRL-VALIDATION-GATE'] },
    ]);
    const prompt = String(mockChatComplete.mock.calls[0][0][0].content);
    expect(prompt).toContain('REQ-VALIDATION-2');
    expect(prompt).toContain('source-brief');
    expect(prompt).toContain('Billing anomaly alerts');
  });

  test('passes the optional storyId into the advisory prompt', async () => {
    mockChatComplete.mockResolvedValue({ text: '{"suggestions":[]}', usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0 } });

    await generatePhaseAdvice({ workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'testing', storyId: 'US-011' });

    expect(String(mockChatComplete.mock.calls[0][0][0].content)).toContain('Focused story: US-011');
  });

  test('drops suggestions that cite outside the requirement/source/control namespaces', async () => {
    mockChatComplete.mockResolvedValue({
      text: '```json\n' + JSON.stringify({
        suggestions: [
          { text: 'Valid citation only.', cites: ['REQ-VALIDATION-2', 'bad cite!'] },
          { text: 'No valid citation remains.', cites: ['bad cite!'] },
          { text: 'Plan-level requirement is citable.', cites: ['REQ-002'] },
        ],
      }) + '\n```',
      usage: { inputTokens: 100, outputTokens: 40, reasoningTokens: 0 },
    });

    const result = await generatePhaseAdvice({ workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'testing' });

    expect(result.suggestions).toEqual([
      { text: 'Valid citation only.', cites: ['REQ-VALIDATION-2'] },
      { text: 'Plan-level requirement is citable.', cites: ['REQ-002'] },
    ]);
  });

  test('bounds suggestion count, citation count, and text length', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      text: `Suggestion ${index}`,
      cites: Array.from({ length: 9 }, (_, citeIndex) => (citeIndex === 0 ? 'REQ-VALIDATION-2' : `CTRL-${citeIndex}`)),
    }));
    mockChatComplete.mockResolvedValue({
      text: JSON.stringify({ suggestions: many }),
      usage: { inputTokens: 100, outputTokens: 40, reasoningTokens: 0 },
    });

    const result = await generatePhaseAdvice({ workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'testing' });

    expect(result.suggestions.length).toBeLessThanOrEqual(PHASE_ADVISOR_MAX_SUGGESTIONS);
    expect(result.suggestions.every((suggestion) => suggestion.cites.length <= 6)).toBe(true);
    expect(result.suggestions.every((suggestion) => suggestion.text.length <= 1000)).toBe(true);
    expect(new Set(result.suggestions.flatMap((suggestion) => suggestion.cites)).has('bad cite!')).toBe(false);
  });

  test('rejects non-JSON and non-object model output as malformed', async () => {
    mockChatComplete.mockResolvedValue({ text: 'I am sorry, I cannot help.', usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0 } });

    await expect(generatePhaseAdvice({ workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'testing' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'ADVISOR_MALFORMED_OUTPUT' });

    mockChatComplete.mockResolvedValue({ text: '[1, 2, 3]', usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0 } });
    await expect(generatePhaseAdvice({ workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'testing' }))
      .rejects.toBeInstanceOf(UnprocessableError);
  });

  test('validates the phase before any read or model call', async () => {
    await expect(generatePhaseAdvice({ workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'frontend' as never }))
      .rejects.toBeInstanceOf(ValidationError);
    expect(mockGetLifecycleSpec).not.toHaveBeenCalled();
    expect(mockChatComplete).not.toHaveBeenCalled();
  });

  test('is structurally read-only: it never imports or invokes persistence surfaces', async () => {
    mockChatComplete.mockResolvedValue({ text: '{"suggestions":[]}', usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0 } });

    const result = await generatePhaseAdvice({ workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'testing' });

    expect(result.advisory).toBe(true);
    expect(result.suggestions).toEqual([]);
    // The advisor source must not reach lifecycle evidence/mutation writers or SQL.
    const source = fs.readFileSync(path.join(__dirname, '..', 'phase-advisor.ts'), 'utf8');
    expect(source).not.toMatch(/from '\.\/lifecycle-mutations'|from '\.\/lifecycle-evidence'|INSERT INTO|UPDATE [a-z_]+ SET|DELETE FROM/);
    expect(mockGetLifecycleSpec).toHaveBeenCalledWith({ workspaceId: 'ws-1', specId: 'spec-a' });
    expect(mockGetLifecycleCoverageByPhase).toHaveBeenCalledWith({ workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'testing' });
  });
});
