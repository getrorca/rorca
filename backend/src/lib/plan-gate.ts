/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { RequestHandler } from 'express';
import { getEffectiveUser } from './get-user';
import { verifyLicense } from './license-verifier';
import { logger } from './logger';
import { swaggerSpec } from './swagger';
import {
  getRorcaTier,
  matchOperationFromRoute,
  planHasCapability,
  resolveRorcaPlan,
  type RorcaPlan,
} from './tier-auth';

function resolveEffectivePlan(rawPlan: string | null | undefined): RorcaPlan {
  const envLicenseKey = process.env.RORCA_LICENSE_KEY;
  if (envLicenseKey) {
    const license = verifyLicense(envLicenseKey);
    if (license.valid && license.plan !== 'free') {
      return resolveRorcaPlan(license.plan);
    }
    logger.debug({ error: license.error }, '[plan-gate] Ignoring invalid or downgraded RORCA_LICENSE_KEY for plan resolution');
  }

  return resolveRorcaPlan(rawPlan);
}

export function planGate(): RequestHandler {
  return async (req, res, next) => {
    try {
      const operation = matchOperationFromRoute(req, swaggerSpec as any);
      if (!operation) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      const { tier, capability } = getRorcaTier(operation);

      if (tier === 'public') {
        next();
        return;
      }

      const user = await getEffectiveUser(req);

      if (tier === 'auth') {
        if (!user) {
          res.status(401).json({ error: 'Authentication required', code: 'AUTH_ERROR' });
          return;
        }
        next();
        return;
      }

      if (tier === 'paid') {
        if (!user) {
          res.status(401).json({ error: 'Authentication required', code: 'AUTH_ERROR' });
          return;
        }

        if (!capability) {
          logger.error({ method: req.method, path: req.path }, '[plan-gate] Paid route missing x-rorca-capability annotation');
          res.status(500).json({ error: 'Server misconfiguration', code: 'PAID_ROUTE_MISCONFIGURED' });
          return;
        }

        const userPlan = resolveEffectivePlan(user.plan);
        if (!planHasCapability(userPlan, capability)) {
          res.status(402).json({
            error: 'Payment Required',
            code: 'PLAN_REQUIRED',
            requiredCapability: capability,
            currentPlan: userPlan,
            upgradeUrl: 'https://rorca.app/pricing',
            hint: `This feature requires a plan with '${capability}'. Current plan: ${userPlan}.`,
          });
          return;
        }

        next();
        return;
      }

      if (tier === 'admin') {
        if (!user) {
          res.status(401).json({ error: 'Authentication required', code: 'AUTH_ERROR' });
          return;
        }
        if (user.role !== 'admin') {
          res.status(403).json({ error: 'Admin role required', code: 'ADMIN_REQUIRED' });
          return;
        }
        next();
        return;
      }

      res.status(404).json({ error: 'Not found' });
    } catch (error) {
      next(error);
    }
  };
}
