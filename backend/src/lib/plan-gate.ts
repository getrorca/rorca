/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { RequestHandler } from 'express';
import { INTERNAL_SERVICE_USER_ID } from './auth-utils';
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

      const nativeApi = operation['x-rorca-native-api'] === true;
      const intentionallyDenied = operation['x-rorca-intentionally-denied'] === true;
      if (nativeApi && intentionallyDenied) {
        logger.error({ method: req.method, path: req.path }, '[plan-gate] contradictory native route classification');
        res.status(500).json({ error: 'Server misconfiguration', code: 'NATIVE_ROUTE_MISCONFIGURED' });
        return;
      }
      if (intentionallyDenied) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (nativeApi) {
        // Native operations are dashboard/local-operator surfaces, not service
        // capabilities. Internal callers must use an explicitly tiered contract;
        // their synthetic admin role must never collapse into human authority.
        const authenticated = req.user;
        const servicePrincipal = authenticated?.id === INTERNAL_SERVICE_USER_ID
          || authenticated?.id === 'rorca-hermes-service'
          || req.headers['x-rorca-service'] !== undefined;
        if (servicePrincipal) {
          res.status(403).json({
            error: 'Native API requires human administrator authority',
            code: 'NATIVE_API_SERVICE_DENIED',
          });
          return;
        }

        const user = await getEffectiveUser(req);
        if (!user) {
          res.status(401).json({ error: 'Authentication required', code: 'AUTH_ERROR' });
          return;
        }
        if (user.role !== 'admin') {
          res.status(403).json({
            error: 'Native API requires local administrator authority',
            code: 'NATIVE_API_ADMIN_REQUIRED',
          });
          return;
        }

        next();
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
