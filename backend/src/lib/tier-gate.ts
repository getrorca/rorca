/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import type { NextFunction, Request, Response } from 'express';
import { authRequired } from './auth-utils';
import {
  AdminRequiredError,
  PaymentRequiredError,
} from './errors';
import { getRorcaTier, type OpenApiTierSpecLike, type RorcaTier } from './tier-auth';

interface RouteMatcher {
  method: string;
  regex: RegExp;
  tier: RorcaTier;
}

function pathToRegex(pathname: string): RegExp {
  const escaped = pathname
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{[^/]+\\\}/g, '[^/]+');
  return new RegExp(`^${escaped}/?$`);
}

function buildMatchers(spec: OpenApiTierSpecLike): RouteMatcher[] {
  const matchers: RouteMatcher[] = [];

  for (const [pathname, methods] of Object.entries(spec.paths ?? {})) {
    if (!methods) continue;

    for (const [method, operation] of Object.entries(methods)) {
      if (!operation) continue;
      const { tier } = getRorcaTier(operation);
      if (tier === 'denied') continue;

      matchers.push({
        method: method.toUpperCase(),
        regex: pathToRegex(pathname),
        tier,
      });
    }
  }

  return matchers.sort((a, b) => b.regex.source.length - a.regex.source.length);
}

function findTier(
  req: Request,
  matchers: RouteMatcher[],
): RorcaTier | null {
  const method = req.method.toUpperCase();
  const path = req.path;

  for (const matcher of matchers) {
    if (matcher.method !== method) continue;
    if (matcher.regex.test(path)) {
      return matcher.tier;
    }
  }

  return null;
}

async function requireResolvedAuth(
  req: Request,
  res: Response,
): Promise<boolean> {
  let resolved = false;

  await authRequired(req, res, () => {
    resolved = true;
  });

  return resolved;
}

export function createTierGate(spec: OpenApiTierSpecLike) {
  const matchers = buildMatchers(spec);

  return async function tierGate(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const tier = findTier(req, matchers);

    if (!tier || tier === 'public') {
      next();
      return;
    }

    const authed = await requireResolvedAuth(req, res);
    if (!authed) return;

    if (tier === 'auth') {
      next();
      return;
    }

    if (tier === 'admin') {
      if (req.user?.role !== 'admin') {
        next(new AdminRequiredError());
        return;
      }
      next();
      return;
    }

    if (tier === 'paid') {
      const plan = String(req.user?.plan ?? 'free').toLowerCase();
      if (plan === 'free') {
        next(new PaymentRequiredError());
        return;
      }
      next();
      return;
    }

    next();
  };
}
