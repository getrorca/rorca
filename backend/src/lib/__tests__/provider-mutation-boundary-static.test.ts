/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PROVIDER_MUTATION_ROUTES,
  providerMutationApiTemplate,
} from '../../../../shared/contracts/provider-mutation-routes';

const src = path.resolve(__dirname, '..', '..');
const server = fs.readFileSync(path.join(src, 'server.ts'), 'utf8');
const routeSources = new Map([
  ['workspace-github', fs.readFileSync(path.join(src, 'routes', 'workspace-github.ts'), 'utf8')],
  ['workspace-github-app', fs.readFileSync(path.join(src, 'routes', 'workspace-github-app.ts'), 'utf8')],
  ['delivery-governance', fs.readFileSync(path.join(src, 'routes', 'delivery-governance.ts'), 'utf8')],
  ['github-checks', fs.readFileSync(path.join(src, 'routes', 'github-checks.ts'), 'utf8')],
  ['webhooks', fs.readFileSync(path.join(src, 'routes', 'webhooks.ts'), 'utf8')],
]);
const workspaceGithub = routeSources.get('workspace-github')!;
const worktrees = fs.readFileSync(path.join(src, 'routes', 'worktrees.ts'), 'utf8');
const webhookHandlers = fs.readFileSync(path.join(src, 'routes', 'webhook-handlers.ts'), 'utf8');
const webhooks = fs.readFileSync(path.join(src, 'routes', 'webhooks.ts'), 'utf8');
const tokenResolver = fs.readFileSync(path.join(src, 'lib', 'github-token-resolver.ts'), 'utf8');
const credentialProvider = fs.readFileSync(path.join(src, 'lib', 'github-app-credential-provider.ts'), 'utf8');
const authUtils = fs.readFileSync(path.join(src, 'lib', 'auth-utils.ts'), 'utf8');
const providerAuthority = fs.readFileSync(path.join(src, 'lib', 'provider-mutation-authority.ts'), 'utf8');
const releaseAuthority = fs.readFileSync(path.join(src, 'lib', 'release-authority.ts'), 'utf8');
const deliveryEvidence = fs.readFileSync(path.join(src, 'lib', 'github-pr-delivery-evidence.ts'), 'utf8');
const frontendRoot = path.resolve(src, '..', '..', 'src');
const githubSettingsPanel = fs.readFileSync(path.join(frontendRoot, 'panels', 'GitHubSettingsPanel.tsx'), 'utf8');
const autonomousDeliverySettings = fs.readFileSync(path.join(frontendRoot, 'components', 'AutonomousDeliverySettings.tsx'), 'utf8');

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

test('canonical provider manifest is complete and every live mutation attaches the guard route-locally', () => {
  expect(PROVIDER_MUTATION_ROUTES.map((route) => route.id)).toEqual([
    'workspace-github-connect',
    'workspace-github-oauth-disconnect',
    'workspace-github-legacy-disconnect',
    'workspace-github-disconnect',
    'workspace-github-webhook-ping',
    'workspace-github-app-setup-start',
    'workspace-github-app-exchange',
    'workspace-github-app-import',
    'workspace-github-app-revalidate',
    'workspace-github-app-bind',
    'workspace-github-app-disable',
    'delivery-policy-create',
    'delivery-policy-activate',
    'delivery-policy-revoke',
    'delivery-evidence-observe',
    'autonomous-delivery-start',
    'github-manual-check-status',
    'webhook-dlq-replay',
  ]);

  for (const route of PROVIDER_MUTATION_ROUTES) {
    const source = routeSources.get(route.routerModule)!;
    const declaration = `${route.routerSymbol}.${route.method.toLowerCase()}('${route.routePath}', requireProviderMutationAuthority,`;
    expect(source).toContain(declaration);
    expect(providerMutationApiTemplate(route)).toMatch(/^\/api\//);
  }

  const allRouteLocalDeclarations = [...routeSources.values()].flatMap((source) => (
    [...source.matchAll(/(?:router|webhookAdminRouter)\.(?:post|delete)\('([^']+)', requireProviderMutationAuthority,/g)]
      .map((match) => match[1])
  ));
  expect(allRouteLocalDeclarations).toHaveLength(PROVIDER_MUTATION_ROUTES.length);

  const intentionallyCapabilityFreePosts = [...routeSources.entries()].flatMap(([moduleName, source]) => (
    [...source.matchAll(/router\.post\('([^']+)',([^\n]*)/g)]
      .filter((match) => !match[2].includes('requireProviderMutationAuthority'))
      .map((match) => `${moduleName}:${match[1]}`)
  ));
  expect(intentionallyCapabilityFreePosts).toEqual([
    'workspace-github:/:id/github/test-connection',
    'workspace-github:/:id/github/pr-template-preview',
    'workspace-github:/:id/github/dispatch',
  ]);

  expect(server).not.toContain('guardWorkspaceProviderMutations');
  expect(server).toContain("app.use('/api/github/checks', githubChecksRouter)");
});

  const sourceBackedRoutes = new Set([
    'workspace-github-app-setup-start',
    'workspace-github-app-exchange',
    'workspace-github-app-revalidate',
    'workspace-github-app-bind',
    'workspace-github-app-disable',
    'delivery-policy-create',
    'delivery-policy-activate',
    'delivery-policy-revoke',
    'delivery-evidence-observe',
    'autonomous-delivery-start',
  ]);
test('every browser-exposed manifest operation has a dedicated capability transport call', () => {
  for (const route of PROVIDER_MUTATION_ROUTES.filter((entry) => sourceBackedRoutes.has(entry.id))) {
    const endpoint = providerMutationApiTemplate(route)
      .replace(':id', '${workspaceId}')
      .replace(':policyId', '${policy.id}');
    const source = route.routerModule === 'delivery-governance'
      ? autonomousDeliverySettings
      : githubSettingsPanel;
    const canonicalSource = source.replaceAll('${actionWorkspaceId}', '${workspaceId}');
    const endpointIndexes = [...canonicalSource.matchAll(new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))]
      .map((match) => match.index);
    expect(endpointIndexes.length).toBeGreaterThan(0);
    expect(endpointIndexes.some((endpointIndex) => (
      canonicalSource.slice(Math.max(0, endpointIndex - 220), endpointIndex).includes('apiFetchProviderMutation')
    ))).toBe(true);
  }
  const evidenceObservationHandler = routeSlice(autonomousDeliverySettings, 'const observeEvidence = async () =>', 'if (!connected) return null');
  expect(evidenceObservationHandler).not.toContain('await apiFetch(');
});

test('authority routers and the application use strict case-sensitive routing', () => {
  expect(server).toContain("app.enable('case sensitive routing')");
  expect(server).toContain("app.enable('strict routing')");
  expect(server).toContain("'X-Rorca-Operator-Capability'");
  for (const source of routeSources.values()) {
    expect(source).toContain('strict: true, caseSensitive: true');
  }
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
