/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { NotFoundError, ValidationError } from '../lib/errors';
import {
  resolveGenesisSource,
  type GenesisAuthorityBridge,
  type GenesisSourceRequest,
} from '../lib/source-adapters/genesis';
import { createGenesisAuthorityBridge } from '../ssdlc/genesis/genesis-authority-bridge';

/**
 * Genesis bridge endpoint. Resolves canonical Genesis context through the
 * production GenesisAuthorityBridge with an explicit principal identity.
 * Restricted chunks never leave the bridge: the adapter returns the redaction
 * marker for every access-denied chunk.
 */
export function createGenesisRouter(bridge: GenesisAuthorityBridge = createGenesisAuthorityBridge()): Router {
  const router = Router();

  function requirePrincipalId(req: Request): string {
    const value = req.query.principalId;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ValidationError('principalId is required', { field: 'principalId' });
    }
    return value.trim();
  }

  function parseSelectedChunkIds(req: Request): string[] | undefined {
    const value = req.query.selectedChunkIds ?? req.query['selectedChunkIds[]'];
    if (value === undefined) return undefined;
    const raw = Array.isArray(value) ? value : [value];
    const ids = raw.flatMap((item) => (
      typeof item === 'string' ? item.split(',').map((part) => part.trim()).filter(Boolean) : []
    ));
    return ids.length > 0 ? ids : undefined;
  }

  function mapResolveError(error: unknown): unknown {
    if (error instanceof ValidationError && /was not found$/.test(error.message)) {
      return new NotFoundError(error.message);
    }
    return error;
  }

  /**
   * @swagger
   * /api/genesis/sources/{kind}/{id}:
   *   get:
   *     summary: Resolve canonical Genesis source context for a principal
   *     description: Principal-aware read-only resolution through the Genesis authority bridge. Restricted chunks are never emitted by the bridge; the adapter returns the redaction marker only.
   *     tags: [Genesis]
   *     operationId: resolveGenesisSourceContext
   *     x-rorca-tier: public
   *     x-rorca-rationale: "Read-only canonical context resolution with bridge-owned redaction; no write, approval, or operator-only side effects, so local automation and MCP may use it."
   *     parameters:
   *       - in: path
   *         name: kind
   *         required: true
   *         schema: { type: string, enum: [genesis_package, genesis_evidence] }
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, maxLength: 128 }
   *       - in: query
   *         name: principalId
   *         required: true
   *         schema: { type: string, maxLength: 256 }
   *       - in: query
   *         name: selectedChunkIds
   *         schema: { type: array, items: { type: string, maxLength: 500 } }
   *     responses:
   *       200: { description: Resolved Genesis source with bridge-owned redaction }
   *       400: { description: Invalid source request or bridge projection }
   *       404: { description: Genesis source not found }
   */
  router.get('/sources/:kind/:id', (req: Request, res: Response, next: NextFunction) => {
    const selectedChunkIds = parseSelectedChunkIds(req);
    const request: GenesisSourceRequest = {
      kind: req.params.kind as GenesisSourceRequest['kind'],
      id: req.params.id as string,
      principalId: requirePrincipalId(req),
      ...(selectedChunkIds ? { selectedChunkIds } : {}),
    };
    resolveGenesisSource(request, bridge)
      .then((result) => res.json(result))
      .catch((error: unknown) => next(mapResolveError(error)));
  });

  return router;
}

export default createGenesisRouter();
