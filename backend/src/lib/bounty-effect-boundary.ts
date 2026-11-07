/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { NextFunction, Request, Response } from 'express';
import {
  BountyFeatureDisabledError,
  type BountyFeaturePolicy,
  resolveBountyFeaturePolicy,
} from './bounty-feature-policy';

export type BountyPolicyResolver = () => Promise<BountyFeaturePolicy>;

/**
 * Mandatory first middleware for every bounty mutation or target-effect route.
 * The route receives the effective policy only after the fail-closed gate passes.
 */
export function requireBountyEffectsEnabled(
  resolvePolicy: BountyPolicyResolver = resolveBountyFeaturePolicy,
) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const policy = await resolvePolicy();
      if (!policy.enabled) throw new BountyFeatureDisabledError();
      req.bountyPolicy = policy;
      next();
    } catch (error: unknown) {
      next(error);
    }
  };
}
