/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Human/operator-only boundary for local delivery creation; never provider authority. */
import type { NextFunction, Request, Response } from 'express';
import {
  INTERNAL_SERVICE_USER_ID,
  isLocalHumanApprovalPrincipal,
} from './auth-utils';
import { ForbiddenError } from './errors';

function isInternalPrincipal(user: NonNullable<Request['user']>): boolean {
  return user.id === INTERNAL_SERVICE_USER_ID
    || user.id === 'system'
    || user.supabaseId === '00000000-0000-0000-0000-000000000000'
    || user.email.toLowerCase().endsWith('@rorca.internal');
}

export async function requireLocalDeliveryCreationAuthority(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = req.user;
    if (!user || isInternalPrincipal(user)) {
      throw new ForbiddenError('Human operator authority is required to create a local review bundle');
    }
    if (process.env.AUTH_REQUIRED !== 'true') {
      if (!isLocalHumanApprovalPrincipal(user)) {
        throw new ForbiddenError('Exact local human authority is required to create a local review bundle');
      }
      next();
      return;
    }
    // Hosted human bearer authentication is intentionally unsupported by the
    // production auth resolver today. Do not imply coverage by accepting an
    // injected user or querying workspace membership on an unreachable path.
    throw new ForbiddenError('Hosted human local-review-bundle creation is not supported');
  } catch (error) {
    next(error);
  }
}
