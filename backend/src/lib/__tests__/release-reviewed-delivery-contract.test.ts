/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';

const lib = path.resolve(__dirname, '..');
const release = fs.readFileSync(path.join(lib, 'release-authority.ts'), 'utf8');
const evidence = fs.readFileSync(path.join(lib, 'github-pr-delivery-evidence.ts'), 'utf8');
const delivery = fs.readFileSync(path.join(lib, 'autonomous-pr-delivery.ts'), 'utf8');
const locking = fs.readFileSync(path.join(lib, 'release-identity.ts'), 'utf8');

describe('release PR → evidence → reviewed delivery authority contract', () => {
  test('uses one cross-container workspace fence for freeze, evidence, merge, and recovery', () => {
    expect(locking).toContain('withPgAdvisoryLock(`github-authority:${workspaceId}`');
    expect(locking).toContain('withPgAdvisoryLock(`github-authority:${identity.workspaceId}`');
    expect(release).toContain('canonical repository authority changed before release intent freeze');
    expect(evidence).toContain("withGithubRepositoryAuthorityLock(input.workspaceId, '', ''");
    expect(delivery).toContain("withGithubReleaseActuation(releaseIdentity, 'merge'");
    expect(delivery).toContain("withGithubReleaseActuation(releaseIdentity, 'reviewed-delivery'");
  });

  test('freezes distinct local branch and provider ref and requires exact base/head SHA throughout', () => {
    expect(release).toContain('providerReleaseRef: repository');
    expect(release).toContain('branchName: authority.branchName');
    expect(evidence).toContain('release_base_sha');
    expect(evidence).toContain('Pull request base SHA does not match the immutable run release intent');
    expect(evidence).toContain('Resolved GitHub App credential differs from immutable run release authority');
    expect(delivery).toContain("currentPr.base?.sha?.toLowerCase() !== evidence.pullRequest.baseSha");
    // After merge the provider base ref may advance. Recovery instead proves
    // the immutable pre-merge base is the merge commit's exact ancestor.
    expect(delivery).toContain('compare/${evidence.pullRequest.baseSha}...${pr.merge_commit_sha}');
    expect(delivery).toContain("comparison.merge_base_commit?.sha?.toLowerCase() !== evidence.pullRequest.baseSha");
  });

  test('requires exact PR number, URL, repository, state, draft, refs, and SHAs at merge and recovery', () => {
    for (const contract of [
      'currentPr.number !== Number(delivery.pr_number)',
      'currentPr.html_url !== evidence.pullRequest.url',
      "currentPr.state !== 'open'",
      'currentPr.draft !== false',
      'currentPr.merged !== false',
      'currentPr.head?.repo?.full_name?.toLowerCase() !== expectedRepository',
      'currentPr.base?.repo?.full_name?.toLowerCase() !== expectedRepository',
      'pr.number !== Number(delivery.pr_number)',
      'pr.html_url !== evidence.pullRequest.url',
      "pr.state !== 'closed'",
      'pr.draft !== false',
      'pr.merged !== true',
    ]) expect(delivery).toContain(contract);
  });

  test('durably attributes governing evidence to immutable repository/App authority', () => {
    expect(evidence).toContain('repository_authority_source');
    expect(evidence).toContain('repository_binding_id');
    expect(evidence).toContain('repository_installation_id');
    expect(evidence).toContain('repository_id');
  });
});
