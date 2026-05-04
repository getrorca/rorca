/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { apiFetch } from '../lib/apiFetch';
import type { ApiOptions, DirectionLayer, DirectionModel } from './types';

export function getLayer(
  layer: number,
  workspaceId: string,
  opts?: ApiOptions,
): Promise<DirectionLayer> {
  return apiFetch(`/api/direction?layer=${layer}&workspaceId=${workspaceId}`, {
    signal: opts?.signal,
  });
}

export function getAllLayers(
  workspaceId: string,
  opts?: ApiOptions,
): Promise<{ layers: Record<string, DirectionLayer> }> {
  return apiFetch(`/api/direction/all?workspaceId=${workspaceId}`, { signal: opts?.signal });
}

export function upsertLayer(
  body: { layer: number; workspaceId?: string; domainId?: string; contentYaml: string; preferredModel?: string },
  opts?: ApiOptions,
): Promise<{ ok: true }> {
  return apiFetch('/api/direction', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
}

export function listModels(opts?: ApiOptions): Promise<{ models: DirectionModel[] }> {
  return apiFetch('/api/direction/models', { signal: opts?.signal });
}

export function preview(
  workspaceId: string,
  opts?: ApiOptions,
): Promise<{ synthesized: string; schemaTableCount: number; gitCommitCount: number; warnings: string[] }> {
  return apiFetch(`/api/direction/preview?workspaceId=${workspaceId}`, { signal: opts?.signal });
}

export function synthesize(
  body: { workspaceId: string; brief?: string },
  opts?: ApiOptions,
): Promise<{ synthesized: string }> {
  return apiFetch('/api/direction/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
}
