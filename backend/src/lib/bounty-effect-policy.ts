/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Pure authorization boundary for target effects. No I/O is permitted here.
 */
import { hashBountyContract } from './bounty-contracts';

export const DENIED_EFFECT_ACTIONS = [
  'payment', 'deletion', 'messaging', 'invitation', 'credential.change', 'role.change',
  'production.mutation', 'dos', 'persistence', 'social.engineering', 'submission',
] as const;
export type EffectDecisionCode = 'ALLOW' | 'EXPIRED' | 'MISSION_INACTIVE' | 'SCOPE_DENIED' | 'ACTION_DENIED' | 'ROLE_DENIED' | 'BUDGET_DENIED' | 'LIFECYCLE_DENIED' | 'INVALID_REQUEST';
export interface EffectRequest {
  workspaceId: string; missionId: string; workPackageId: string; target: string;
  action: string; credentialRole: string; costCents: number; concurrency: number;
  repeatable: boolean; expiresAt: string; input: Record<string, unknown>;
}
export interface EffectAdmission {
  missionState: 'active' | 'draft' | 'held' | 'completed' | 'cancelled';
  targets: readonly string[]; actions: readonly string[]; credentialRoles: readonly string[];
  remainingCents: number; availableConcurrency: number; lifecycleStates: readonly string[];
}
export interface EffectDecision { allowed: boolean; code: EffectDecisionCode; requestHash: string; expiresAt: string }

function validRequest(request: EffectRequest): boolean {
  return [request.workspaceId, request.missionId, request.workPackageId, request.target, request.action, request.credentialRole]
    .every((v) => typeof v === 'string' && v.length > 0 && v.length <= 2048)
    && Number.isSafeInteger(request.costCents) && request.costCents >= 0
    && Number.isSafeInteger(request.concurrency) && request.concurrency > 0
    && Number.isFinite(Date.parse(request.expiresAt));
}

/** Exact-list checks intentionally avoid wildcards and inference from tool names. */
export function decideEffect(request: EffectRequest, admission: EffectAdmission, nowMs = Date.now()): EffectDecision {
  const requestHash = hashBountyContract('effect-request', request);
  const result = (code: EffectDecisionCode): EffectDecision => ({ allowed: code === 'ALLOW', code, requestHash, expiresAt: request.expiresAt });
  if (!validRequest(request)) return result('INVALID_REQUEST');
  if (Date.parse(request.expiresAt) <= nowMs) return result('EXPIRED');
  if (admission.missionState !== 'active') return result('MISSION_INACTIVE');
  if (!admission.targets.includes(request.target)) return result('SCOPE_DENIED');
  if ((DENIED_EFFECT_ACTIONS as readonly string[]).includes(request.action) || !admission.actions.includes(request.action)) return result('ACTION_DENIED');
  if (!admission.credentialRoles.includes(request.credentialRole)) return result('ROLE_DENIED');
  if (request.costCents > admission.remainingCents || request.concurrency > admission.availableConcurrency) return result('BUDGET_DENIED');
  if (!admission.lifecycleStates.includes('prepared')) return result('LIFECYCLE_DENIED');
  return result('ALLOW');
}
