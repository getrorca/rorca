/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Operator surface for the Wave 5 Forgejo adapter (W5-002/W5-006): register,
 * rotate and revoke the repository-scoped credential, and provision/rotate/
 * revoke the dedicated webhook signing secret. Every endpoint is admin-tier
 * (never MCP-exposed), validates at the route boundary, and never returns or
 * logs the raw token or webhook secret.
 */

import { Router, type Request, type Response } from 'express';
import { ValidationError } from '../lib/errors';
import {
  registerForgejoCredential,
  rotateForgejoCredential,
  revokeForgejoCredential,
  provisionForgejoWebhookSecret,
  rotateForgejoWebhookSecret,
  revokeForgejoWebhookSecret,
} from '../lib/forgejo-token-credential-provider';
import { requireLocalOperatorBoundary } from '../lib/local-operator-boundary';

export const forgejoOperatorRouter = Router({ strict: true, caseSensitive: true });
forgejoOperatorRouter.use(requireLocalOperatorBoundary);

const REGISTER_SCHEMA = {
  instanceUrl: 'string', owner: 'string', name: 'string', token: 'string',
} as const;

function requireStringFields(body: unknown, fields: Record<string, string>): Record<string, string> {
  const value = (body ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [field, type] of Object.entries(fields)) {
    const raw = value[field];
    if (typeof raw !== type || (type === 'string' && String(raw).trim() === '')) {
      throw new ValidationError(`Forgejo operator request field ${field} must be a non-empty ${type}`);
    }
    out[field] = String(raw);
  }
  return out;
}

/** @swagger
 * /api/forgejo/credentials/{workspaceId}:
 *   post:
 *     summary: Register a repository-scoped Forgejo credential
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local operator-only registration of the W5 Forgejo adapter credential — mutates the credential registry, never MCP-callable."
 *     responses:
 *       200: { description: Registered binding summary }
 *       400: { description: Validation failure }
 *       401: { description: Capability probe rejected the token }
 */
forgejoOperatorRouter.post('/credentials/:workspaceId', async (req: Request, res: Response) => {
  const fields = requireStringFields(req.body, REGISTER_SCHEMA);
  const webhookSecret = typeof (req.body as Record<string, unknown>).webhookSecret === 'string'
    ? String((req.body as Record<string, unknown>).webhookSecret)
    : undefined;
  const binding = await registerForgejoCredential({
    workspaceId: String(req.params.workspaceId),
    instanceUrl: fields.instanceUrl,
    owner: fields.owner,
    name: fields.name,
    token: fields.token,
    webhookSecret,
    createdBy: 'operator-surface',
  });
  res.json({
    workspaceId: binding.workspaceId,
    owner: binding.owner,
    name: binding.name,
    status: binding.status,
    credentialVersion: binding.credentialVersion,
    keyVersion: binding.keyVersion,
  });
});

/** @swagger
 * /api/forgejo/credentials/{workspaceId}/rotate:
 *   post:
 *     summary: Rotate the Forgejo credential token
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local operator-only rotation of the W5 Forgejo adapter credential — mutates the credential registry, never MCP-callable."
 *     responses:
 *       200: { description: Rotated binding summary }
 *       409: { description: Version conflict or missing credential }
 */
forgejoOperatorRouter.post('/credentials/:workspaceId/rotate', async (req: Request, res: Response) => {
  const fields = requireStringFields(req.body, REGISTER_SCHEMA);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const credentialVersion = Number(body.credentialVersion ?? 0);
  const keyVersion = Number(body.keyVersion ?? 0);
  if (!Number.isSafeInteger(credentialVersion) || credentialVersion < 1
    || !Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new ValidationError('Forgejo rotation requires positive integer credentialVersion and keyVersion');
  }
  const binding = await rotateForgejoCredential({
    workspaceId: String(req.params.workspaceId),
    instanceUrl: fields.instanceUrl,
    owner: fields.owner,
    name: fields.name,
    token: fields.token,
    credentialVersion,
    keyVersion,
  });
  res.json({
    workspaceId: binding.workspaceId,
    owner: binding.owner,
    name: binding.name,
    status: binding.status,
    credentialVersion: binding.credentialVersion,
    keyVersion: binding.keyVersion,
  });
});

/** @swagger
 * /api/forgejo/credentials/{workspaceId}/revoke:
 *   post:
 *     summary: Revoke the Forgejo credential binding
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local operator-only revocation of the W5 Forgejo adapter credential — mutates the credential registry, never MCP-callable."
 *     responses:
 *       200: { description: Revoked }
 */
forgejoOperatorRouter.post('/credentials/:workspaceId/revoke', async (req: Request, res: Response) => {
  await revokeForgejoCredential(String(req.params.workspaceId), 'operator_revoke');
  res.json({ workspaceId: req.params.workspaceId, status: 'revoked' });
});

/** @swagger
 * /api/forgejo/credentials/{workspaceId}/webhook-secret:
 *   post:
 *     summary: Provision, rotate or revoke the Forgejo webhook signing secret
 *     parameters:
 *       - { in: path, name: workspaceId, required: true, schema: { type: string } }
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local operator-only provisioning of the W5 webhook HMAC secret — never MCP-callable; the secret is ciphertext-only at rest."
 *     responses:
 *       200: { description: Secret version }
 *       400: { description: Invalid action or secret }
 */
forgejoOperatorRouter.post('/credentials/:workspaceId/webhook-secret', async (req: Request, res: Response) => {
  const body = req.body && typeof req.body === 'object'
    ? req.body as Record<string, unknown>
    : {};
  const action = typeof body.action === 'string' ? body.action : '';
  const secret = typeof body.secret === 'string' ? body.secret : null;
  if (action === 'provision' || action === 'rotate') {
    if (!secret || secret.length < 32 || Buffer.byteLength(secret, 'utf8') > 1024) {
      throw new ValidationError('Forgejo webhook secret must contain between 32 and 1024 bytes');
    }
    const outcome = action === 'provision'
      ? await provisionForgejoWebhookSecret(String(req.params.workspaceId), secret)
      : await rotateForgejoWebhookSecret(String(req.params.workspaceId), secret);
    res.json({ workspaceId: req.params.workspaceId, version: outcome.version });
    return;
  }
  if (action === 'revoke') {
    await revokeForgejoWebhookSecret(String(req.params.workspaceId));
    res.json({ workspaceId: req.params.workspaceId, version: 0 });
    return;
  }
  throw new ValidationError(`Forgejo webhook-secret action must be provision, rotate, or revoke (got ${action || 'none'})`);
});

export default forgejoOperatorRouter;
