/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export type ProviderMutationMethod = 'POST' | 'DELETE';
export type ProviderMutationRouterModule =
  | 'workspace-github'
  | 'workspace-github-app'
  | 'delivery-governance'
  | 'github-checks'
  | 'webhooks';

export interface ProviderMutationRoute {
  readonly id: string;
  readonly method: ProviderMutationMethod;
  readonly mountPath: string;
  readonly routePath: string;
  readonly routerModule: ProviderMutationRouterModule;
  readonly routerSymbol: 'router' | 'webhookAdminRouter';
  readonly browserExposed: boolean;
}

/**
 * Canonical inventory of live operator-authorized provider and release-authority
 * mutations. Express handlers attach the capability middleware route-locally;
 * browser transport and contract tests consume this same bounded inventory.
 */
export const PROVIDER_MUTATION_ROUTES = [
  { id: 'workspace-github-connect', method: 'POST', mountPath: '/api/workspaces', routePath: '/:id/github/connect', routerModule: 'workspace-github', routerSymbol: 'router', browserExposed: true },
  { id: 'workspace-github-oauth-disconnect', method: 'POST', mountPath: '/api/workspaces', routePath: '/:id/github/disconnect-oauth', routerModule: 'workspace-github', routerSymbol: 'router', browserExposed: true },
  { id: 'workspace-github-legacy-disconnect', method: 'POST', mountPath: '/api/workspaces', routePath: '/:id/github/disconnect', routerModule: 'workspace-github', routerSymbol: 'router', browserExposed: true },
  { id: 'workspace-github-disconnect', method: 'DELETE', mountPath: '/api/workspaces', routePath: '/:id/github', routerModule: 'workspace-github', routerSymbol: 'router', browserExposed: true },
  { id: 'workspace-github-webhook-ping', method: 'POST', mountPath: '/api/workspaces', routePath: '/:id/github/webhook-ping', routerModule: 'workspace-github', routerSymbol: 'router', browserExposed: true },
  { id: 'workspace-github-app-exchange', method: 'POST', mountPath: '/api/workspaces', routePath: '/:id/github/app/setup/exchange', routerModule: 'workspace-github-app', routerSymbol: 'router', browserExposed: true },
  { id: 'workspace-github-app-import', method: 'POST', mountPath: '/api/workspaces', routePath: '/:id/github/app/import', routerModule: 'workspace-github-app', routerSymbol: 'router', browserExposed: true },
  { id: 'workspace-github-app-revalidate', method: 'POST', mountPath: '/api/workspaces', routePath: '/:id/github/app/revalidate', routerModule: 'workspace-github-app', routerSymbol: 'router', browserExposed: true },
  { id: 'workspace-github-app-bind', method: 'POST', mountPath: '/api/workspaces', routePath: '/:id/github/app/bind', routerModule: 'workspace-github-app', routerSymbol: 'router', browserExposed: true },
  { id: 'delivery-policy-create', method: 'POST', mountPath: '/api/workspaces', routePath: '/:id/github/delivery-policies', routerModule: 'delivery-governance', routerSymbol: 'router', browserExposed: true },
  { id: 'delivery-policy-activate', method: 'POST', mountPath: '/api/workspaces', routePath: '/:id/github/delivery-policies/:policyId/activate', routerModule: 'delivery-governance', routerSymbol: 'router', browserExposed: true },
  { id: 'delivery-policy-revoke', method: 'POST', mountPath: '/api/workspaces', routePath: '/:id/github/delivery-policies/:policyId/revoke', routerModule: 'delivery-governance', routerSymbol: 'router', browserExposed: true },
  { id: 'delivery-evidence-observe', method: 'POST', mountPath: '/api/workspaces', routePath: '/:id/github/delivery-evidence', routerModule: 'delivery-governance', routerSymbol: 'router', browserExposed: true },
  { id: 'autonomous-delivery-start', method: 'POST', mountPath: '/api/workspaces', routePath: '/:id/github/autonomous-deliveries', routerModule: 'delivery-governance', routerSymbol: 'router', browserExposed: true },
  { id: 'github-manual-check-status', method: 'POST', mountPath: '/api/github/checks', routePath: '/:sha', routerModule: 'github-checks', routerSymbol: 'router', browserExposed: false },
  { id: 'webhook-dlq-replay', method: 'POST', mountPath: '/api/webhooks', routePath: '/dlq/:id/retry', routerModule: 'webhooks', routerSymbol: 'webhookAdminRouter', browserExposed: false },
] as const satisfies readonly ProviderMutationRoute[];

export type ProviderMutationRouteId = typeof PROVIDER_MUTATION_ROUTES[number]['id'];

export function providerMutationApiTemplate(route: ProviderMutationRoute): string {
  return `${route.mountPath}${route.routePath}`;
}

function matchesTemplate(pathname: string, template: string): boolean {
  const pathSegments = pathname.split('/');
  const templateSegments = template.split('/');
  if (pathSegments.length !== templateSegments.length) return false;
  return templateSegments.every((segment, index) => {
    const candidate = pathSegments[index];
    return segment.startsWith(':')
      ? candidate.length > 0 && candidate !== '.' && candidate !== '..' && !/[\u0000-\u001f\u007f\s]/.test(candidate)
      : candidate === segment;
  });
}

/**
 * Match only canonical browser paths. Reject alternate encodings and path
 * normalization inputs instead of trying to emulate Express decoding rules.
 */
export function isBrowserProviderMutation(method: string, requestPath: string): boolean {
  const normalizedMethod = method.toUpperCase();
  const pathname = requestPath.split(/[?#]/, 1)[0];
  if (!pathname.startsWith('/') || pathname.length > 2048 || pathname.endsWith('/')
    || pathname.includes('//') || pathname.includes('\\') || pathname.includes('%')) {
    return false;
  }
  return PROVIDER_MUTATION_ROUTES.some((route) => (
    route.browserExposed
      && route.method === normalizedMethod
      && matchesTemplate(pathname, providerMutationApiTemplate(route))
  ));
}
