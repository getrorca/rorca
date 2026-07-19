/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { getMcpToolDefinitions } from '../mcp-http';
import { swaggerSpec } from '../swagger';
import { getRorcaTier } from '../tier-auth';

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

test('semantic GitHub provider writes are admin/default-denied and absent from MCP', () => {
  const providerWrites = [
    ['post', '/api/workspaces/{id}/github/connect'],
    ['post', '/api/workspaces/{id}/github/disconnect'],
    ['delete', '/api/workspaces/{id}/github'],
    ['post', '/api/workspaces/{id}/github/webhook-ping'],
    ['post', '/api/workspaces/{id}/github/app/setup/exchange'],
    ['post', '/api/workspaces/{id}/github/app/import'],
    ['post', '/api/workspaces/{id}/github/app/revalidate'],
    ['post', '/api/workspaces/{id}/github/app/bind'],
    ['post', '/api/workspaces/{id}/github/delivery-policies'],
    ['post', '/api/workspaces/{id}/github/delivery-policies/{policyId}/activate'],
    ['post', '/api/workspaces/{id}/github/delivery-policies/{policyId}/revoke'],
    ['post', '/api/workspaces/{id}/github/autonomous-deliveries'],
  ] as const;

  for (const [method, pathname] of providerWrites) {
    const op = operation(method, pathname);
    expect(['admin', 'denied']).toContain(getRorcaTier(op).tier);
    expect(definitions.some((candidate) => (
      candidate.capturedMethod === method.toUpperCase() && candidate.capturedPath === pathname
    ))).toBe(false);
  }
});
