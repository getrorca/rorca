/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';

const LIB = path.resolve(__dirname, '..');
const BACKEND_SRC = path.resolve(LIB, '..');
const providerCallers = [
  path.join(LIB, 'github-pr-creator.ts'),
  path.join(LIB, 'github-draft-pr.ts'),
  path.join(BACKEND_SRC, 'worker.ts'),
  path.join(LIB, 'check-run-poster.ts'),
  path.join(LIB, 'commit-status-poster.ts'),
  path.join(LIB, 'github-checks.ts'),
  path.join(LIB, 'ci-autofix', 'fix-orchestrator.ts'),
  path.join(LIB, 'autonomous-pr-delivery.ts'),
  path.join(BACKEND_SRC, 'routes', 'workspace-github.ts'),
];

test('durable/logging GitHub callers never read arbitrary provider response bodies', () => {
  for (const file of providerCallers) {
    const source = fs.readFileSync(file, 'utf8');
    expect(source).not.toMatch(/\b(?:res|response|createRes|updateRes|patchRes|dispatchRes)\.text\s*\(/);
    expect(source).not.toMatch(/\berrText\b/);
    expect(source).toContain('github-provider-error');
  }
});

test('durable error fields are fed bounded formatted errors rather than thrown/provider body messages', () => {
  const prCreator = fs.readFileSync(providerCallers[0], 'utf8');
  const draftPr = fs.readFileSync(providerCallers[1], 'utf8');
  const worker = fs.readFileSync(providerCallers[2], 'utf8');
  const autonomousDelivery = fs.readFileSync(providerCallers[7], 'utf8');
  expect(prCreator).toContain('const errMsg = formatGithubProviderError(providerError)');
  expect(prCreator).toContain('await storeResult(runId, null, errMsg)');
  expect(draftPr).toContain('const errMsg = formatGithubProviderError(providerError)');
  expect(worker).toContain('error: errorMessage');
  expect(worker).not.toContain('error: err.message');
  expect(autonomousDelivery).toContain("extractGithubProviderError(response, 'GITHUB_EXACT_SHA_MERGE_FAILED')");
  expect(autonomousDelivery).toContain('formatGithubProviderError(providerError)');
  expect(autonomousDelivery).not.toContain('raw.message');
});
