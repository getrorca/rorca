/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, urlencoded, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  BrowserMcpConformanceFixtureRegistry,
  browserMcpConformanceFixtureRegistry,
} from '../lib/browser-mcp-conformance-fixture';
import { ValidationError } from '../lib/errors';

const FixtureIdSchema = z.string().uuid();

function fixtureId(request: Request): string {
  const parsed = FixtureIdSchema.safeParse(request.params.fixtureId);
  if (!parsed.success) throw new ValidationError('Browser MCP conformance fixture ID is invalid');
  return parsed.data;
}

function requestRecord(request: Request): Record<string, unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(request.body);
  if (!parsed.success) throw new ValidationError('Browser MCP conformance protocol body is invalid');
  return parsed.data;
}

export function createBrowserMcpConformanceFixtureRouter(
  registry: BrowserMcpConformanceFixtureRegistry = browserMcpConformanceFixtureRegistry,
): Router {
  const router = Router({ strict: true, caseSensitive: true });
  router.use(urlencoded({ extended: false, limit: '16kb' }));

  /** @swagger
   * /browser-conformance/{fixtureId}/.well-known/oauth-protected-resource:
   *   get:
   *     summary: Read disposable MCP fixture protected-resource metadata
   *     parameters:
   *       - { in: path, name: fixtureId, required: true, schema: { type: string, format: uuid } }
   *     x-rorca-tier: public
   *     x-rorca-rationale: "Ephemeral standards metadata for an explicitly enabled, random-ID conformance fixture; no Rorca or provider authority is exposed."
   *     x-rorca-mcp: false
   *     responses:
   *       200: { description: RFC 9728 metadata }
   *       404: { description: Unknown or destroyed fixture }
   */
  router.get('/:fixtureId/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
    res.json(registry.metadata(fixtureId(req)).protectedResource);
  });

  /** @swagger
   * /browser-conformance/{fixtureId}/.well-known/oauth-authorization-server:
   *   get:
   *     summary: Read disposable MCP fixture OAuth metadata
   *     parameters:
   *       - { in: path, name: fixtureId, required: true, schema: { type: string, format: uuid } }
   *     x-rorca-tier: public
   *     x-rorca-rationale: "Ephemeral OAuth discovery for the one bounded Claude conformance client; fixture operation remains disabled by default."
   *     x-rorca-mcp: false
   *     responses:
   *       200: { description: RFC 8414 metadata }
   */
  router.get('/:fixtureId/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
    res.json(registry.metadata(fixtureId(req)).authorizationServer);
  });

  /** @swagger
   * /browser-conformance/{fixtureId}/oauth/register:
   *   post:
   *     summary: Register the one bounded Claude fixture client
   *     parameters:
   *       - { in: path, name: fixtureId, required: true, schema: { type: string, format: uuid } }
   *     x-rorca-tier: public
   *     x-rorca-rationale: "Dynamic registration returns the fixed public test client only after exact Claude callback, no-secret auth, code/refresh grants, and web application policy match."
   *     x-rorca-mcp: false
   *     responses:
   *       201: { description: Fixed bounded public-client metadata }
   *       403: { description: Registration policy mismatch }
   */
  router.post('/:fixtureId/oauth/register', (req: Request, res: Response) => {
    res.status(201).json(registry.registerClient(fixtureId(req), requestRecord(req)));
  });

  /** @swagger
   * /browser-conformance/{fixtureId}/oauth/authorize:
   *   get:
   *     summary: Begin bounded Claude fixture OAuth consent
   *     parameters:
   *       - { in: path, name: fixtureId, required: true, schema: { type: string, format: uuid } }
   *     x-rorca-tier: public
   *     x-rorca-rationale: "Random-ID disposable consent endpoint accepts only the sealed Claude test client, subject, redirect URI, scope, and S256 PKCE contract."
   *     x-rorca-mcp: false
   *     responses:
   *       200: { description: Human-readable deterministic consent surface }
   *       403: { description: Client, redirect, scope, or PKCE policy mismatch }
   */
  router.get('/:fixtureId/oauth/authorize', (req: Request, res: Response) => {
    const authorization = registry.beginAuthorization(fixtureId(req), req.query);
    res.type('html').send(authorization.html);
  });

  /** @swagger
   * /browser-conformance/{fixtureId}/oauth/consent/{requestId}/approve:
   *   get:
   *     summary: Approve one visible bounded fixture consent request
   *     parameters:
   *       - { in: path, name: fixtureId, required: true, schema: { type: string, format: uuid } }
   *       - { in: path, name: requestId, required: true, schema: { type: string, format: uuid } }
   *     x-rorca-tier: public
   *     x-rorca-rationale: "Single-use unguessable consent link is reachable only from the fixture's human-visible page and redirects solely to the pre-bound Claude callback."
   *     x-rorca-mcp: false
   *     responses:
   *       302: { description: Single-use authorization code redirect }
   *       409: { description: Consent request already consumed }
   */
  router.get('/:fixtureId/oauth/consent/:requestId/approve', (req: Request, res: Response) => {
    const requestId = FixtureIdSchema.safeParse(req.params.requestId);
    if (!requestId.success) throw new ValidationError('Claude MCP conformance consent request ID is invalid');
    res.redirect(302, registry.approveConsent(fixtureId(req), requestId.data));
  });

  /** @swagger
   * /browser-conformance/{fixtureId}/oauth/token:
   *   post:
   *     summary: Exchange or refresh the bounded fixture OAuth grant
   *     parameters:
   *       - { in: path, name: fixtureId, required: true, schema: { type: string, format: uuid } }
   *     x-rorca-tier: public
   *     x-rorca-rationale: "PKCE-bound ephemeral token endpoint admits only the exact test client and one short-lived harmless MCP scope."
   *     x-rorca-mcp: false
   *     responses:
   *       200: { description: Short-lived fixture token response }
   *       400: { description: Invalid or replayed grant }
   *       401: { description: Wrong client }
   */
  router.post('/:fixtureId/oauth/token', (req: Request, res: Response) => {
    const result = registry.exchangeToken(fixtureId(req), requestRecord(req));
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.json({
      access_token: result.accessToken,
      token_type: 'Bearer',
      expires_in: result.expiresIn,
      scope: 'mcp:tools',
      ...(result.refreshToken ? { refresh_token: result.refreshToken } : {}),
    });
  });

  /** @swagger
   * /browser-conformance/{fixtureId}/oauth/revoke:
   *   post:
   *     summary: Revoke every OAuth grant for the disposable fixture
   *     parameters:
   *       - { in: path, name: fixtureId, required: true, schema: { type: string, format: uuid } }
   *     x-rorca-tier: public
   *     x-rorca-rationale: "RFC 7009 endpoint can only reduce the authority of the random-ID fixture's exact test client and retains no submitted token in evidence."
   *     x-rorca-mcp: false
   *     responses:
   *       200: { description: Revocation accepted }
   *       403: { description: Wrong client }
   */
  router.post('/:fixtureId/oauth/revoke', (req: Request, res: Response) => {
    registry.revoke(fixtureId(req), requestRecord(req));
    res.status(200).end();
  });

  /** @swagger
   * /browser-conformance/{fixtureId}/mcp:
   *   post:
   *     summary: Invoke the disposable one-tool MCP conformance fixture
   *     parameters:
   *       - { in: path, name: fixtureId, required: true, schema: { type: string, format: uuid } }
   *     x-rorca-tier: public
   *     x-rorca-rationale: "Random-ID test-only MCP surface requires its ephemeral OAuth grant and admits exactly initialize, tools/list, and one deterministic harmless tool call."
   *     x-rorca-mcp: false
   *     responses:
   *       200: { description: Bounded MCP JSON-RPC response }
   *       401: { description: Missing, expired, or revoked fixture grant }
   *       403: { description: Method or tool contract not admitted }
   */
  router.post('/:fixtureId/mcp', (req: Request, res: Response) => {
    const id = fixtureId(req);
    const result = registry.handleMcp(id, req.header('authorization'), req.body);
    if (result.status === 401) {
      const fixture = registry.snapshotById(id);
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${fixture.fixtureOrigin}/.well-known/oauth-protected-resource"`);
    }
    if (result.body === null) {
      res.status(result.status).end();
      return;
    }
    res.status(result.status).json(result.body);
  });

  return router;
}

export default createBrowserMcpConformanceFixtureRouter();
