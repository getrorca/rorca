/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { NextFunction, Request, Response } from 'express';
import { AdminRequiredError, ForbiddenError } from './errors';
import { requireProviderMutationAuthority } from './provider-mutation-authority';

function canonicalLocalOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1')
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
let originCacheKey = '';
let originCache: ReadonlySet<string> = new Set();

export function configuredLocalOrigins(): ReadonlySet<string> {
  const port = String(process.env.PORT || 3030);
  const cacheKey = `${process.env.CORS_ORIGIN ?? ''}\0${process.env.RORCA_SERVE_STATIC ?? ''}\0${port}`;
  if (cacheKey === originCacheKey) return originCache;
  const configured = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const candidates = configured.length > 0
    ? configured
    : ['http://localhost:5210', 'http://127.0.0.1:5210'];
  // The API's own loopback origins are implicit deployment origins even when
  // Vite's separate development origin is configured.
  candidates.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
  originCache = new Set(candidates.map(canonicalLocalOrigin).filter((origin): origin is string => origin !== null));
  originCacheKey = cacheKey;
  return originCache;
}

export function isConfiguredLocalOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  const canonical = canonicalLocalOrigin(origin);
  return canonical !== null && configuredLocalOrigins().has(canonical);
}

export function requireConfiguredBrowserOrigin(req: Request, _res: Response, next: NextFunction): void {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (!isConfiguredLocalOrigin(origin)) {
    next(new ForbiddenError('Browser origin is not authorized for this local Rorca API'));
    return;
  }
  next();
}

function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split('%', 1)[0];
  return normalized === '::1' || normalized === '127.0.0.1'
    || normalized.startsWith('127.') || normalized.startsWith('::ffff:127.');
}

/** Defense-in-depth boundary for host-sensitive routes. Authentication and CSRF
 * still mount before this middleware; local mode additionally requires the
 * explicit operator capability digest preimage. */
export function requireLocalOperatorBoundary(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    next(new AdminRequiredError('Local administrator authority is required'));
    return;
  }
  if (!isLoopbackPeer(req.socket.remoteAddress)) {
    next(new ForbiddenError('Operator route is restricted to the local machine'));
    return;
  }
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (!isConfiguredLocalOrigin(origin)) {
    next(new ForbiddenError('Operator request origin is not authorized'));
    return;
  }
  requireProviderMutationAuthority(req, res, next);
}
