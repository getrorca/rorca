/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Canonical context-capture trust tiers shared by sidecar, backend contracts, and UI filters. */
export const CONTEXT_TRUST_TIERS = [
  'agent_observation',
  'working_note',
  'engineering_decision',
  'approved_policy',
  'verified_fact',
] as const;

export type ContextTrustTier = typeof CONTEXT_TRUST_TIERS[number];

export const CONTEXT_TRUST_TIER_LABELS: Record<ContextTrustTier, string> = {
  agent_observation: 'Agent observation',
  working_note: 'Working note',
  engineering_decision: 'Engineering decision',
  approved_policy: 'Approved policy',
  verified_fact: 'Verified fact',
};
