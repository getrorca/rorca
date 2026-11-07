/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';

const queryOne = jest.fn();
const postCommitStatus = jest.fn();
const requireAuthority = jest.fn();
const resolveToken = jest.fn();
const providerFetch = jest.fn();

jest.mock('../../db/index', () => ({ queryOne: (...args: unknown[]) => queryOne(...args) }));
jest.mock('../../lib/github-checks', () => ({
  postCommitStatus: (...args: unknown[]) => postCommitStatus(...args),
  MANUAL_CHECK_NAME: 'rorca/manual-spec-compliance',
}));
jest.mock('../../lib/auth-utils', () => ({
  requireWorkspaceAdmin: () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers['x-test-admin'] === 'true') { (req as any).user = { id: 'admin' }; next(); }
    else res.status(403).json({ error: 'Forbidden' });
  },
}));
jest.mock('../../lib/github-repository-authority', () => ({
  requireGithubRepositoryAuthority: (...args: unknown[]) => requireAuthority(...args),
  githubRepoApiUrl: (owner: string, repo: string, suffix: string) => `https://api.github.com/repos/${owner}/${repo}${suffix}`,
}));
jest.mock('../../lib/github-token-resolver', () => ({
  resolveWorkspaceGitHubToken: (...args: unknown[]) => resolveToken(...args),
}));
jest.mock('../../lib/github-app-credential-provider', () => ({
  fetchGithubWithTimeout: (...args: unknown[]) => providerFetch(...args),
}));
jest.mock('../../lib/sse-hub', () => ({ broadcastAll: jest.fn() }));

import githubChecksRouter from '../github-checks';

const SHA = 'a'.repeat(40);
const OPERATOR_CAPABILITY = 'github-checks-test-operator';
function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.headers['x-rorca-operator-capability'] = OPERATOR_CAPABILITY;
    next();
  });
  instance.use('/api/github/checks', githubChecksRouter);
  return instance;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.AUTH_REQUIRED = 'false';
  process.env.RORCA_OPERATOR_CAPABILITY_SHA256 = crypto.createHash('sha256').update(OPERATOR_CAPABILITY).digest('hex');
  queryOne.mockImplementation(async (sql: string) => sql.includes('FROM pipeline_runs')
    ? { id: 7, workspace_id: 'ws-1', pr_number: 12, branch_name: 'run/secure' }
    : { id: 1 });
  requireAuthority.mockResolvedValue({ owner: 'acme', name: 'widgets' });
  resolveToken.mockResolvedValue({ token: 'opaque', source: 'workspace-pat' });
  providerFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ number: 12, head: { sha: SHA, ref: 'run/secure', repo: { full_name: 'acme/widgets' } } }),
  });
  postCommitStatus.mockResolvedValue(true);
});

afterAll(() => {
  delete process.env.AUTH_REQUIRED;
  delete process.env.RORCA_OPERATOR_CAPABILITY_SHA256;
});

test('manual status requires workspace-admin authority before database or provider access', async () => {
  const response = await request(app()).post(`/api/github/checks/${SHA}`).send({ workspaceId: 'ws-1', runId: 7, state: 'success' });
  expect(response.status).toBe(403);
  expect(queryOne).not.toHaveBeenCalled();
  expect(providerFetch).not.toHaveBeenCalled();
});

test('manual status rejects abbreviated and malformed object ids', async () => {
  for (const candidate of ['abcdef1', `${'g'.repeat(40)}`, `${'a'.repeat(41)}`]) {
    const response = await request(app()).post(`/api/github/checks/${candidate}`).set('x-test-admin', 'true')
      .send({ workspaceId: 'ws-1', runId: 7, state: 'success' });
    expect(response.status).toBe(400);
  }
  expect(providerFetch).not.toHaveBeenCalled();
});

test('manual status fails closed when run has no canonical workspace/PR binding', async () => {
  queryOne.mockResolvedValueOnce(undefined);
  const response = await request(app()).post(`/api/github/checks/${SHA}`).set('x-test-admin', 'true')
    .send({ workspaceId: 'victim', runId: 7, state: 'success' });
  expect(response.status).toBe(404);
  expect(postCommitStatus).not.toHaveBeenCalled();
});

test('manual status rejects a stale/non-PR SHA before publishing', async () => {
  providerFetch.mockResolvedValueOnce({ ok: true, json: async () => ({
    number: 12, head: { sha: 'b'.repeat(40), ref: 'run/secure', repo: { full_name: 'acme/widgets' } },
  }) });
  const response = await request(app()).post(`/api/github/checks/${SHA}`).set('x-test-admin', 'true')
    .send({ workspaceId: 'ws-1', runId: 7, state: 'success' });
  expect(response.status).toBe(409);
  expect(postCommitStatus).not.toHaveBeenCalled();
});

test('valid manual status uses a fixed non-governing context and canonical run/PR', async () => {
  const response = await request(app()).post(`/api/github/checks/${SHA}`).set('x-test-admin', 'true')
    .send({ workspaceId: 'ws-1', runId: 7, state: 'success', description: 'operator observation' });
  expect(response.status).toBe(200);
  expect(postCommitStatus).toHaveBeenCalledWith(
    'acme', 'widgets', SHA, 'success', 'operator observation', undefined, 'ws-1', 'rorca/manual-spec-compliance',
  );
  expect(response.body).toMatchObject({ runId: 7, prNumber: 12, context: 'rorca/manual-spec-compliance', governingEvidenceEligible: false });
});
