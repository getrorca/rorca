/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { getMcpToolDefinitions } from '../mcp-http';
import { swaggerSpec } from '../swagger';
import { getRorcaTier } from '../tier-auth';
import {
  PROVIDER_MUTATION_ROUTES,
  providerMutationApiTemplate,
} from '../../../../shared/contracts/provider-mutation-routes';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
const paths = (swaggerSpec as any).paths as Record<string, Record<string, any>>;
const definitions = getMcpToolDefinitions(swaggerSpec as any);

const listedOperations = [
  ['get', '/api/workspaces/{id}/github', 'getWorkspaceGithubRepositoryStatus'],
  ['get', '/api/workspaces/{id}/github/account', 'getWorkspaceGithubAccountStatus'],
  ['get', '/api/workspaces/{id}/github/workflows', 'listWorkspaceGithubWorkflows'],
  ['post', '/api/workspaces/{id}/github/webhook-ping', 'pingWorkspaceGithubWebhook'],
  ['post', '/api/workspaces/{id}/github/pr-template-preview', 'previewWorkspaceGithubPrTemplate'],
] as const;

function operation(method: string, pathname: string): any {
  const found = paths[pathname]?.[method];
  expect(found).toBeDefined();
  return found;
}

test('all five Gate 9 GitHub operations have stable IDs and complete workspace path schemas', () => {
  for (const [method, pathname, operationId] of listedOperations) {
    const op = operation(method, pathname);
    expect(op.operationId).toBe(operationId);
    expect(op.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        in: 'path',
        name: 'id',
        required: true,
        schema: expect.objectContaining({ type: 'string' }),
      }),
    ]));
  }
});

test('every exposed placeholder is declared and reaches generated MCP input; every GitHub placeholder is audited', () => {
  for (const [pathname, pathItem] of Object.entries(paths)) {
    const placeholders = [...pathname.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
    for (const [method, op] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !op) continue;
      const tier = getRorcaTier(op).tier;
      if (tier === 'denied' && !pathname.includes('/github')) continue;
      if (placeholders.length === 0) continue;
      const parameters = new Map(
        (op.parameters ?? [])
          .filter((parameter: any) => parameter.in === 'path')
          .map((parameter: any) => [parameter.name, parameter]),
      );
      for (const placeholder of placeholders) {
        expect(parameters.get(placeholder)).toMatchObject({
          in: 'path',
          name: placeholder,
          required: true,
          schema: expect.objectContaining({ type: expect.any(String) }),
        });
      }

      if (!['public', 'auth'].includes(tier) || op['x-rorca-mcp'] === false) continue;
      const definition = definitions.find((candidate) => (
        candidate.capturedMethod === method.toUpperCase() && candidate.capturedPath === pathname
      ));
      expect(definition).toBeDefined();
      for (const placeholder of placeholders) {
        expect(Object.keys(definition!.zodShape)).toContain(placeholder);
      }
    }
  }
});

test('canonical provider mutations have OpenAPI parity, remain admin/default-denied, and are absent from MCP', () => {
  for (const route of PROVIDER_MUTATION_ROUTES) {
    const method = route.method.toLowerCase();
    const pathname = providerMutationApiTemplate(route).replace(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}');
    const op = operation(method, pathname);
    expect(['admin', 'denied']).toContain(getRorcaTier(op).tier);
    expect(definitions.some((candidate) => (
      candidate.capturedMethod === route.method && candidate.capturedPath === pathname
    ))).toBe(false);
  }
});
