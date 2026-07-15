/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Wire compatibility accepted at the frontend run API boundary.
 *
 * Persisted database rows are snake_case. Some API revisions also expose
 * camelCase compatibility fields either on the run or on the detail response.
 * Components must consume only the canonical camelCase pair produced here.
 */
export interface RunEngineWireFields {
  agent_type?: string | null;
  agent_model?: string | null;
  agentType?: string | null;
  agentModel?: string | null;
}

export interface CanonicalRunEngineFields {
  agentType: string | null;
  agentModel: string | null;
}

export type NormalizedPipelineRun<T extends RunEngineWireFields> = T & CanonicalRunEngineFields;

function nonBlankString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Normalize one run as it crosses the API boundary.
 *
 * Precedence is deliberate: persisted snake_case provenance wins over
 * compatibility aliases. The optional compatibility object is used by the run
 * detail endpoint, which historically returned camelCase fields at top level.
 * No engine is inferred when every source is absent.
 */
export function normalizePipelineRunDto<T extends RunEngineWireFields>(
  run: T,
  compatibility: RunEngineWireFields = {},
): NormalizedPipelineRun<T> {
  return {
    ...run,
    agentType: nonBlankString(run.agent_type)
      ?? nonBlankString(run.agentType)
      ?? nonBlankString(compatibility.agentType)
      ?? nonBlankString(compatibility.agent_type),
    agentModel: nonBlankString(run.agent_model)
      ?? nonBlankString(run.agentModel)
      ?? nonBlankString(compatibility.agentModel)
      ?? nonBlankString(compatibility.agent_model),
  };
}

export function normalizePipelineRunDetailResponse<
  TResponse extends RunEngineWireFields & { run: RunEngineWireFields },
>(response: TResponse): Omit<TResponse, 'run'> & {
  run: NormalizedPipelineRun<TResponse['run']>;
} {
  return {
    ...response,
    run: normalizePipelineRunDto(response.run, response),
  };
}

export function normalizePipelineRunListResponse<
  TResponse extends { items: RunEngineWireFields[] },
>(response: TResponse): Omit<TResponse, 'items'> & {
  items: Array<NormalizedPipelineRun<TResponse['items'][number]>>;
} {
  return {
    ...response,
    items: response.items.map((run) => normalizePipelineRunDto(run)),
  };
}
