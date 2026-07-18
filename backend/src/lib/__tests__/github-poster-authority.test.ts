/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';

const checkRun = fs.readFileSync(path.join(__dirname, '..', 'check-run-poster.ts'), 'utf8');
const commitStatus = fs.readFileSync(path.join(__dirname, '..', 'commit-status-poster.ts'), 'utf8');
const checks = fs.readFileSync(path.join(__dirname, '..', 'github-checks.ts'), 'utf8');

test('final Check Runs move to the exact workspace/run-scoped final SHA', () => {
  expect(checkRun).toContain('WHERE workspace_id = $1 AND run_id = $2');
  expect(checkRun).toContain("conclusion: 'neutral'");
  expect(checkRun).toContain('createCheckRun(state.owner, state.repo, finalSha');
  expect(checkRun).toContain('isFullGitObjectId(finalCommit.commit_sha)');
  expect(checkRun).toContain('fetchGithubWithTimeout(fetch, url');
});

test('final commit status requires the scoped closeout row and treats WAL SHA as a cross-check only', () => {
  expect(commitStatus).toContain('WHERE workspace_id = $1 AND run_id = $2 AND story_id = $3 AND spec_id = $4');
  expect(commitStatus).toContain('eventSha !== sha');
  expect(commitStatus).not.toMatch(/\{40,64\}/);
  expect(commitStatus).toContain('fetchGithubWithTimeout(fetch, url');
});

test('spec-compliance status uses purpose-narrow read/write credentials', () => {
  expect(checks).toContain("getGithubToken(workspaceId, owner, repo, 'pulls-read')");
  expect(checks).toContain("getGithubToken(workspaceId, owner, repo, 'statuses-write')");
  expect(checks).not.toContain("purpose: 'checks'");
});
