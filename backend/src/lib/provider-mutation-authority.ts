/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * HTTP capability boundary for operator-initiated provider mutations.
 *
 * Autonomous execution children receive neither an authenticated user JWT nor
 * the raw local operator capability. In local single-user mode the server keeps
 * only a configured SHA-256 digest; an operator supplies the preimage explicitly
 * per request. PATH wrappers are defense in depth and are not trusted here.
 */

import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, ServiceUnavailableError } from './errors';
import { LOCAL_ADMIN } from './auth-utils';

const DIGEST = /^[0-9a-f]{64}$/;
const HEADER = 'x-rorca-operator-capability';

function sameDigest(expected: string, capability: string): boolean {
  const actual = crypto.createHash('sha256').update(capability, 'utf8').digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

export function requireProviderMutationAuthority(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  // With mandatory auth enabled, the authenticated non-local principal is the
  // capability. Workspace/platform role middleware still applies afterward.
  if (process.env.AUTH_REQUIRED === 'true') {
    const user = (req as Request & { user?: { id?: string } }).user;
    if (!user?.id || user.id === LOCAL_ADMIN.id) {
      throw new ForbiddenError('Authenticated operator authority is required for provider mutation');
    }
    next();
    return;
  }

  const expected = String(process.env.RORCA_OPERATOR_CAPABILITY_SHA256 ?? '').trim().toLowerCase();
  if (!DIGEST.test(expected)) {
    throw new ServiceUnavailableError(
      'Provider mutations are disabled in local mode until RORCA_OPERATOR_CAPABILITY_SHA256 is configured',
    );
  }
  const supplied = String(req.headers[HEADER] ?? '');
  if (!supplied || supplied.length > 1024 || !sameDigest(expected, supplied)) {
    throw new ForbiddenError('Explicit local operator capability is required for provider mutation');
  }
  next();
}

/** Match only provider-facing workspace surfaces; ordinary local writes remain local-first. */
export function guardWorkspaceProviderMutations(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
    || !/^\/[^/]+\/github(?:\/|$)/.test(req.path)) {
    next();
    return;
  }
  requireProviderMutationAuthority(req, res, next);
}
