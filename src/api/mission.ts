/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Mission OS read-model clients.
 *
 * Every response is parsed against the strict shared Zod contracts at the
 * boundary. A payload that does not match the published contract throws
 * {@link MissionContractError}; callers must render that as an honest
 * "contract violation" state and never fall back to partial client-side
 * inference of permission, liveness, readiness, or completion.
 */

import { z } from 'zod';
import { apiFetch } from '../lib/apiFetch';
import { isoTimestamp } from '../../shared/contracts/primitives';
import {
  ActionEnvelopeV1Schema,
  DeliveryCaseSummaryV1Schema,
  RunControlProjectionV1Schema,
  type DeliveryCaseSummaryV1,
  type RunControlProjectionV1,
} from '../../shared/contracts/mission';
import type { ApiOptions } from './types';

/** Response envelope for GET /api/workspaces/:workspaceId/attention. */
export const WorkspaceAttentionV1Schema = z.object({
  items: z.array(ActionEnvelopeV1Schema).max(100),
  generatedAt: isoTimestamp,
}).strict();
export type WorkspaceAttentionV1 = z.infer<typeof WorkspaceAttentionV1Schema>;

/** Thrown when a backend payload fails strict contract validation. */
export class MissionContractError extends Error {
  readonly endpoint: string;
  readonly issues: string[];

  constructor(endpoint: string, issues: string[]) {
    super(`The server response for ${endpoint} did not match the published contract.`);
    this.name = 'MissionContractError';
    this.endpoint = endpoint;
    this.issues = issues;
  }
}

function parseAtBoundary<S extends z.ZodType>(schema: S, endpoint: string, payload: unknown): z.infer<S> {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`);
    throw new MissionContractError(endpoint, issues);
  }
  return result.data;
}

/** Deterministically ranked, server-authored attention items for one workspace. */
export async function getWorkspaceAttention(
  workspaceId: string,
  opts?: ApiOptions,
): Promise<WorkspaceAttentionV1> {
  const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/attention`;
  const payload = await apiFetch<unknown>(endpoint, { signal: opts?.signal });
  return parseAtBoundary(WorkspaceAttentionV1Schema, endpoint, payload);
}

/** Exact-revision delivery case projection for one spec. */
export async function getDeliveryCaseSummary(
  workspaceId: string,
  specId: string,
  opts?: ApiOptions,
): Promise<DeliveryCaseSummaryV1> {
  const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/delivery-cases/${encodeURIComponent(specId)}`;
  const payload = await apiFetch<unknown>(endpoint, { signal: opts?.signal });
  return parseAtBoundary(DeliveryCaseSummaryV1Schema, endpoint, payload);
}

/** Semantic run-control projection (waves, lanes, cost, evidence freshness). */
export async function getRunControlProjection(
  workspaceId: string,
  specId: string,
  runId: number | string,
  opts?: ApiOptions,
): Promise<RunControlProjectionV1> {
  const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/delivery-cases/${encodeURIComponent(specId)}/runs/${encodeURIComponent(String(runId))}/control`;
  const payload = await apiFetch<unknown>(endpoint, { signal: opts?.signal });
  return parseAtBoundary(RunControlProjectionV1Schema, endpoint, payload);
}
