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
const authority = fs.readFileSync(path.join(__dirname, '..', 'github-poster-authority.ts'), 'utf8');
const trustedWal = fs.readFileSync(path.join(__dirname, '..', 'trusted-wal.ts'), 'utf8');

test('final Check Runs require trusted complete state and move to the exact final SHA', () => {
  expect(checkRun).toContain('authorizeCompleteTerminalRun(event)');
  expect(checkRun).toContain('persistDesiredProjection({');
  expect(checkRun).toContain("desired_state: 'in_progress' | 'completed'");
  expect(checkRun).toContain('subscribeDurable(async (event)');
  expect(checkRun).toContain('reconcilePendingCheckRunProjections');
  expect(checkRun).toContain('external_id: claim.external_id');
  expect(checkRun).toContain('fetchGithubWithTimeout(fetch, url');
  expect(authority).toContain('expected_story_ids');
  expect(authority).toContain("row.closeout_status !== 'accepted'");
  expect(authority).toContain("row.result_provenance !== 'host'");
  expect(authority).toContain("row.result_commit_source !== 'worktree_branch'");
  expect(authority).toContain('outboxes.length !== 1 || !outboxes[0].outbox_ready_at');
  const accept = checkRun.slice(
    checkRun.indexOf('export async function acceptCheckRunWalEvent'),
    checkRun.indexOf('async function claimProjection'),
  );
  expect(accept).not.toContain('getGithubRepositoryAuthority(');
  expect(accept).not.toContain('resolveWorkspaceGitHubToken(');
});

test('final commit status consumes only accepted trusted pass outbox events', () => {
  expect(commitStatus).toContain('authorizeStoryPassEvent(event)');
  expect(commitStatus).toContain("purpose: 'statuses-write'");
  expect(commitStatus).toContain('fetchGithubWithTimeout(fetch, url');
  expect(authority).toContain("event.trusted_source === 'story-result'");
  expect(trustedWal).toContain("trust_provenance !== 'host'");
});

test('spec-compliance status uses purpose-narrow read/write credentials', () => {
  expect(checks).toContain("getGithubToken(workspaceId, owner, repo, 'pulls-read')");
  expect(checks).toContain("getGithubToken(workspaceId, owner, repo, 'statuses-write')");
  expect(checks).not.toContain("purpose: 'checks'");
});
