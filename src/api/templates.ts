/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { apiFetch } from '../lib/apiFetch';
import type { ApiOptions, PaginatedResponse, Template } from './types';

export function listTemplates(opts?: ApiOptions): Promise<PaginatedResponse<Template>> {
  return apiFetch('/api/templates', { signal: opts?.signal });
}

export function getTemplate(
  id: string,
  opts?: ApiOptions,
): Promise<Template> {
  return apiFetch(`/api/templates/${id}`, { signal: opts?.signal });
}

export function createTemplate(
  body: { specId: string; name: string; description?: string },
  opts?: ApiOptions,
): Promise<Template> {
  return apiFetch('/api/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
}

export function deleteTemplate(
  id: string,
  opts?: ApiOptions,
): Promise<{ ok: true }> {
  return apiFetch(`/api/templates/${id}`, {
    method: 'DELETE',
    signal: opts?.signal,
  });
}

export function useTemplate(
  id: string,
  opts?: ApiOptions,
): Promise<{ ok: true }> {
  return apiFetch(`/api/templates/${id}/use`, {
    method: 'POST',
    signal: opts?.signal,
  });
}

export function rateTemplate(
  id: string,
  rating: number,
  opts?: ApiOptions,
): Promise<{ avgRating: number; ratingCount: number; userRating: number }> {
  return apiFetch(`/api/templates/${id}/rate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating }),
    signal: opts?.signal,
  });
}
