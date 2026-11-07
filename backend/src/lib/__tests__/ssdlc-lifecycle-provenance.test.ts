/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
jest.mock('../../db/index', () => ({ query: jest.fn(), queryOne: jest.fn(), execute: jest.fn() }));

import { candidateSpecHash, describeLifecycleRawReference } from '../ssdlc-lifecycle-read';
import { normalizeSsdlcContractJson } from '../ssdlc-contracts';

const runScope = { runId: 42 };

describe('lifecycle evidence raw-reference authorization', () => {
  test.each([
    ['run-output-chunks:42?sequence=1-4', 'story_result', 'rorca:run_output_chunks', '/runs/42', 'run'],
    ['/workspace/forge/specs/logs/US-001.log', 'story_result', 'rorca:story_results', '/runs/42', 'log'],
    ['pty:42', 'completion_signal', 'rorca:pty', '/runs/42', 'pty'],
    ['https://github.com/rorca/rorca/actions/runs/7', 'github_check', 'github:checks', 'https://github.com/rorca/rorca/actions/runs/7', 'github'],
  ])('allowlists %s through an existing authorized destination', (rawReference, type, system, href, kind) => {
    expect(describeLifecycleRawReference({ rawReference, source: { type, system }, scope: runScope })).toMatchObject({
      available: true, allowed: true, href, kind, rawPayloadIncluded: false,
    });
  });

  test('retains GitReins identity without fabricating an unsafe URL', () => {
    expect(describeLifecycleRawReference({
      rawReference: 'gitreins:judgment-7', source: { type: 'gitreins_judgment', system: 'hermes:gitreins' }, scope: { runId: null },
    })).toMatchObject({ allowed: true, kind: 'gitreins', href: null, reference: 'gitreins:judgment-7' });
  });

  test.each([
    ['javascript:alert(1)', 'github_check'],
    ['https://evil.example/check/7', 'github_check'],
    ['https://github.com.evil.example/check/7', 'github_check'],
    ['attachments:qa/secret', 'manual_qa'],
  ])('keeps unrecognized or unsafe reference %s copy-only', (rawReference, type) => {
    expect(describeLifecycleRawReference({ rawReference, source: { type, system: 'test' }, scope: { runId: null } })).toMatchObject({
      available: true, allowed: false, href: null, kind: 'unknown', rawPayloadIncluded: false,
    });
  });
});

describe('lifecycle reconciliation revision selection', () => {
  test('binds receipts to current candidate content before stale compiled-plan provenance', () => {
    const oldPlanHash = `sha256:${'a'.repeat(64)}`;
    const currentContent = {
      title: 'Changed candidate',
      userStories: [{ id: 'US-001', passes: false, acceptanceCriteria: ['Changed intent'] }],
    };
    const currentHash = `sha256:${crypto.createHash('sha256')
      .update(normalizeSsdlcContractJson(currentContent))
      .digest('hex')}`;

    expect(candidateSpecHash({
      content_json: currentContent,
      provenance_json: { specHash: oldPlanHash },
    })).toBe(currentHash);
    expect(currentHash).not.toBe(oldPlanHash);
  });
});
