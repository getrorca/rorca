/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export const HERMES_DISPATCH_OUTCOME_VERSION = 'rorca-dispatch-outcome.v1' as const;

export type HermesDispatchDisposition =
  | 'queued'
  | 'already_queued'
  | 'running'
  | 'pending_publication'
  | 'terminal_success'
  | 'terminal_failure'
  | 'conflict'
  | 'refused';

export interface HermesDispatchOutcome {
  schemaVersion: typeof HERMES_DISPATCH_OUTCOME_VERSION;
  disposition: HermesDispatchDisposition;
  accepted: boolean;
  newlyQueued: boolean;
  replayed: boolean;
  runId: number | null;
  runStatus: string | null;
  retryable: boolean;
  reasonCode: string;
}

const SUCCESS_STATUSES = new Set(['done', 'completed', 'passed', 'success']);
const FAILURE_STATUSES = new Set(['failed', 'cancelled', 'partial_failure', 'manual_review_required', 'refused']);

export function dispatchOutcome(input: {
  disposition: HermesDispatchDisposition;
  runId?: number | null;
  runStatus?: string | null;
  replayed?: boolean;
  retryable?: boolean;
  reasonCode: string;
}): HermesDispatchOutcome {
  const accepted = !['conflict', 'refused'].includes(input.disposition);
  return {
    schemaVersion: HERMES_DISPATCH_OUTCOME_VERSION,
    disposition: input.disposition,
    accepted,
    newlyQueued: input.disposition === 'queued' && input.replayed !== true,
    replayed: input.replayed === true,
    runId: input.runId ?? null,
    runStatus: input.runStatus ?? null,
    retryable: input.retryable ?? ['pending_publication', 'conflict'].includes(input.disposition),
    reasonCode: input.reasonCode,
  };
}

export function replayDispositionForRunStatus(status: string): HermesDispatchDisposition {
  if (status === 'queued') return 'already_queued';
  if (['running', 'paused', 'pi_native', 'starting'].includes(status)) return 'running';
  if (SUCCESS_STATUSES.has(status)) return 'terminal_success';
  if (FAILURE_STATUSES.has(status)) return 'terminal_failure';
  return 'pending_publication';
}
