/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { Request, RequestHandler } from 'express';
import { queryOne } from '../db/index';
import { HERMES_OPERATOR_DISPATCH_USER_ID, INTERNAL_SERVICE_USER_ID } from './auth-utils';
import { getEffectiveUser } from './get-user';
import { verifyLicense } from './license-verifier';
import { logger } from './logger';
import {
  requiredHermesAuthorityMode,
  requireHermesAction,
  type HermesAction,
} from './hermes-authority';
import { swaggerSpec } from './swagger';
import {
  getRorcaTier,
  matchOperationFromRoute,
  planHasCapability,
  resolveRorcaPlan,
  type RorcaPlan,
} from './tier-auth';

export const HERMES_PUBLIC_MUTATION_OPERATION_IDS = new Set([
  'triggerTaskManifestPipelineRun',
  'triggerPipelineRun',
  'retryPipelineRun',
  'getSpecGenerationContext',
  'preflightSpecAuthoring',
  'confirmSpecAuthoringPlan',
  'persistExplicitSpecDraft',
  'persistExplicitSpecDraftBatch',
  'approveSpec',
]);

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const HERMES_OPERATION_ACTIONS: Readonly<Record<string, HermesAction>> = {
  getSpecGenerationContext: 'intent',
  preflightSpecAuthoring: 'intent',
  confirmSpecAuthoringPlan: 'persist',
  persistExplicitSpecDraft: 'persist',
  persistExplicitSpecDraftBatch: 'persist',
  approveSpec: 'persist',
  triggerTaskManifestPipelineRun: 'dispatch',
  triggerPipelineRun: 'dispatch',
  retryPipelineRun: 'dispatch',
};

function resolveMutationWorkspaceId(req: Request): string | null {
  const params = req.params as Record<string, string | undefined>;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const query = req.query as Record<string, string | undefined>;
  const candidate = params.workspaceId
    ?? (typeof body.workspaceId === 'string' ? body.workspaceId : undefined)
    ?? (typeof body.workspace_id === 'string' ? body.workspace_id : undefined)
    ?? (typeof query.workspaceId === 'string' ? query.workspaceId : undefined);
  return candidate ? String(candidate) : null;
}

function isHermesServicePrincipal(req: Request): boolean {
  return req.user?.id === 'rorca-hermes-service'
    || req.user?.id === HERMES_OPERATOR_DISPATCH_USER_ID
    || String(req.headers['x-rorca-service'] ?? '').trim().toLowerCase() === 'hermes';
}

async function authorizePublicMutation(req: Request, operation: Record<string, unknown>): Promise<{
  status: number;
  body: Record<string, unknown>;
} | null> {
  const user = req.user;
  if (!user) {
    return { status: 401, body: { error: 'Authentication required', code: 'AUTH_ERROR' } };
  }

  if (isHermesServicePrincipal(req)) {
    const operationId = typeof operation.operationId === 'string' ? operation.operationId : '';
    if (!HERMES_PUBLIC_MUTATION_OPERATION_IDS.has(operationId)) {
      return {
        status: 403,
        body: { error: 'Hermes service is not authorized for this operation', code: 'PUBLIC_MUTATION_SERVICE_DENIED' },
      };
    }
    const action = HERMES_OPERATION_ACTIONS[operationId];
    try {
      if (!action) throw new Error('Hermes operation has no declared authority action');
      requireHermesAction(req.hermesAuthority, action, requiredHermesAuthorityMode(action));
    } catch {
      return {
        status: 403,
        body: { error: 'Hermes authority does not permit this operation', code: 'HERMES_ACTION_AUTHORITY_DENIED' },
      };
    }
    return null;
  }

  // Local/platform administrators and the localhost MCP service intentionally
  // retain operator authority across workspaces. Ordinary hosted principals are
  // always bound to an explicit workspace membership below.
  if (user.role === 'admin' || user.id === INTERNAL_SERVICE_USER_ID) return null;

  const workspaceId = resolveMutationWorkspaceId(req);
  if (!workspaceId) {
    return {
      status: 403,
      body: { error: 'Workspace authority is required', code: 'PUBLIC_MUTATION_WORKSPACE_REQUIRED' },
    };
  }

  const membership = await queryOne<{ role: string }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_auth_id = $2',
    [workspaceId, user.supabaseId],
  );
  if (!membership) {
    return { status: 403, body: { error: 'Forbidden', code: 'PUBLIC_MUTATION_WORKSPACE_DENIED' } };
  }
  return null;
}

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
        // Hermes may acquire only the exact operator-equivalent pipeline dispatch
        // capability. It remains a separate audit principal and cannot use that
        // declaration at any other native/admin route.
        const authenticated = req.user;
        const operationId = typeof operation.operationId === 'string' ? operation.operationId : '';
        if (authenticated?.id === HERMES_OPERATOR_DISPATCH_USER_ID
          && (operationId === 'preflightPipelineCheck' || operationId === 'triggerPipelineRun')) {
          try {
            requireHermesAction(req.hermesAuthority, 'dispatch', 'operator-dispatch');
            next();
            return;
          } catch {
            res.status(403).json({
              error: 'Hermes dispatch authority declaration is required',
              code: 'HERMES_DISPATCH_AUTHORITY_DENIED',
            });
            return;
          }
        }

        // All service identities fail closed before generic admin role checks.
        const servicePrincipal = authenticated?.id === INTERNAL_SERVICE_USER_ID
          || authenticated?.id === 'rorca-hermes-service'
          || authenticated?.id === HERMES_OPERATOR_DISPATCH_USER_ID
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
        if (MUTATING_METHODS.has(req.method.toUpperCase())) {
          const denial = await authorizePublicMutation(req, operation as Record<string, unknown>);
          if (denial) {
            res.status(denial.status).json(denial.body);
            return;
          }
        }
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
        if (isHermesServicePrincipal(req) || user.id === INTERNAL_SERVICE_USER_ID || req.authSource === 'internal') {
          res.status(403).json({
            error: 'Service identity cannot exercise admin-tier authority',
            code: 'ADMIN_TIER_SERVICE_IDENTITY_DENIED',
          });
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
