/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const src = path.resolve(__dirname, '..', '..');
const server = fs.readFileSync(path.join(src, 'server.ts'), 'utf8');
const workspaceGithub = fs.readFileSync(path.join(src, 'routes', 'workspace-github.ts'), 'utf8');
const worktrees = fs.readFileSync(path.join(src, 'routes', 'worktrees.ts'), 'utf8');
const webhookHandlers = fs.readFileSync(path.join(src, 'routes', 'webhook-handlers.ts'), 'utf8');
const webhooks = fs.readFileSync(path.join(src, 'routes', 'webhooks.ts'), 'utf8');
const tokenResolver = fs.readFileSync(path.join(src, 'lib', 'github-token-resolver.ts'), 'utf8');
const credentialProvider = fs.readFileSync(path.join(src, 'lib', 'github-app-credential-provider.ts'), 'utf8');
const authUtils = fs.readFileSync(path.join(src, 'lib', 'auth-utils.ts'), 'utf8');
const providerAuthority = fs.readFileSync(path.join(src, 'lib', 'provider-mutation-authority.ts'), 'utf8');
const releaseAuthority = fs.readFileSync(path.join(src, 'lib', 'release-authority.ts'), 'utf8');
const deliveryEvidence = fs.readFileSync(path.join(src, 'lib', 'github-pr-delivery-evidence.ts'), 'utf8');

function routeSlice(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

test('internal service authentication is cryptographic/configured and can never become provider authority', () => {
  expect(authUtils).toContain('RORCA_INTERNAL_SERVICE_TOKEN is required in production');
  expect(authUtils).toContain("crypto.randomBytes(32).toString('base64url')");
  expect(authUtils).toContain('crypto.timingSafeEqual');
  expect(authUtils).not.toContain('rorca-internal-${process.pid}');
  expect(providerAuthority).toContain("user?.id === INTERNAL_SERVICE_USER_ID");
  expect(providerAuthority).toContain("user?.id === 'system'");
  expect(providerAuthority).toContain("endsWith('@rorca.internal')");
});

test('semantic workspace GitHub/provider mutations and manual checks cross the operator capability boundary', () => {
  const guard = server.indexOf("app.use('/api/workspaces', guardWorkspaceProviderMutations)");
  const githubRoutes = server.indexOf("app.use('/api/workspaces', workspaceGithubRouter)");
  const appRoutes = server.indexOf("app.use('/api/workspaces', workspaceGithubAppRouter)");
  const deliveryRoutes = server.indexOf("app.use('/api/workspaces', deliveryGovernanceRouter)");
  expect(guard).toBeGreaterThan(-1);
  expect(guard).toBeLessThan(githubRoutes);
  expect(guard).toBeLessThan(appRoutes);
  expect(guard).toBeLessThan(deliveryRoutes);
  expect(server).toContain("app.use('/api/github/checks', requireProviderMutationAuthority, githubChecksRouter)");
});

test('legacy Auto-PR, workflow config/YAML, and dispatch routes are inert compatibility conflicts', () => {
  const autoPr = routeSlice(workspaceGithub, "router.put('/:id/github/auto-pr'", '/**\n * @swagger\n * /api/workspaces/{id}/github/workflow-config:');
  const workflowConfig = routeSlice(workspaceGithub, "router.get('/:id/github/workflow-config'", '/**\n * @swagger\n * /api/workspaces/{id}/github/workflows:');
  const actionsYaml = routeSlice(workspaceGithub, "router.get('/:id/github/actions-yaml'", '/**\n * @swagger\n * /api/workspaces/{id}/github/dispatch:');
  for (const route of [autoPr, workflowConfig, actionsYaml]) {
    expect(route).toMatch(/retired|unavailable/);
    expect(route).toContain('ConflictError');
    expect(route).not.toContain('resolveWorkspaceGitHubToken');
    expect(route).not.toContain('fetchGithubWithTimeout');
    expect(route).not.toContain('await execute');
  }

  expect(releaseAuthority).toContain('const targetBaseBranch = localBaseBranch');
  expect(releaseAuthority).not.toContain('canonicalRepository?.autoPrTargetBranch');
  expect(deliveryEvidence).toContain('JOIN pipeline_run_release_intents i');
  expect(deliveryEvidence).toContain('i.base_branch AS release_base_branch');
});

test('workflow dispatch compatibility route resolves no credential and performs no provider call', () => {
  const route = routeSlice(workspaceGithub, "router.post('/:id/github/dispatch'", 'export function verifyWebhookSignature');
  expect(route).toContain('hard disabled');
  expect(route).not.toContain('resolveWorkspaceGitHubToken');
  expect(route).not.toContain('fetchGithubWithTimeout');
  expect(route).not.toContain('/dispatches');
  expect(tokenResolver).not.toContain("'workflow-dispatch'");
  expect(credentialProvider).toContain("actions: 'read'");
  expect(credentialProvider).not.toContain("actions: 'write'");
});

test('legacy canonical-workspace merge and preview routes are inert conflicts', () => {
  const preview = routeSlice(worktrees, "router.post('/merge/preview'", '/**\n * @swagger\n * /api/worktrees/merge:');
  const merge = routeSlice(worktrees, "router.post('/merge'", '/**\n * @swagger\n * /api/worktrees/status:');
  for (const route of [preview, merge]) {
    expect(route).toContain("res.status(409)");
    expect(route).not.toContain('.merge(');
    expect(route).not.toContain('.stash(');
  }
});

test('signed PR webhook path records local evidence without automatic status mutation', () => {
  expect(webhookHandlers).not.toContain('evaluatePrAndPostCheck(');
  expect(webhookHandlers).toContain('without automatic provider status mutation');
  expect(webhooks).toContain("webhookAdminRouter.post('/dlq/:id/retry', requireProviderMutationAuthority");
});
