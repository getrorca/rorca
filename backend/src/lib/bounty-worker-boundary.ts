/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  BOUNTY_FEATURE_DISABLED_REASON_CODE,
  type BountyFeaturePolicy,
  resolveBountyFeaturePolicy,
} from './bounty-feature-policy';

export type BountyEffectWorkerRegistrar = (policy: BountyFeaturePolicy) => Promise<void>;

export type BountyEffectWorkerRegistrationResult =
  | { registered: false; reasonCode: typeof BOUNTY_FEATURE_DISABLED_REASON_CODE }
  | { registered: true; reasonCode: null };

/**
 * The sole registration seam for target-effect-capable bounty workers.
 * Registrars are not invoked at all while policy is absent/disabled.
 */
export async function registerBountyEffectWorkers(options: {
  resolvePolicy?: () => Promise<BountyFeaturePolicy>;
  registrars?: readonly BountyEffectWorkerRegistrar[];
} = {}): Promise<BountyEffectWorkerRegistrationResult> {
  const policy = await (options.resolvePolicy ?? resolveBountyFeaturePolicy)();
  if (!policy.enabled) {
    return { registered: false, reasonCode: BOUNTY_FEATURE_DISABLED_REASON_CODE };
  }

  for (const register of options.registrars ?? []) {
    await register(policy);
  }
  return { registered: true, reasonCode: null };
}
