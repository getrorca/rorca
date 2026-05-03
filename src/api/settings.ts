/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { apiFetch } from '../lib/apiFetch';
import type { ApiOptions } from './types';

// ─── Profile ──────────────────────────────────────────────────────────────────

export function getProfile(
  opts?: ApiOptions,
): Promise<{ id: string; email: string; displayName: string; avatarUrl?: string }> {
  return apiFetch('/api/settings/profile', { signal: opts?.signal });
}

export function updateProfile(
  body: { displayName?: string; avatarUrl?: string },
  opts?: ApiOptions,
): Promise<{ ok: true }> {
  return apiFetch('/api/settings/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
}

export function changePassword(
  body: { currentPassword: string; newPassword: string },
  opts?: ApiOptions,
): Promise<{ ok: true }> {
  return apiFetch('/api/settings/password', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
}

// ─── Display ──────────────────────────────────────────────────────────────────

export function getDisplay(
  opts?: ApiOptions,
): Promise<{ defaultModel: string; itemsPerPage: number }> {
  return apiFetch('/api/settings/display', { signal: opts?.signal });
}

export function updateDisplay(
  body: { defaultModel?: string; itemsPerPage?: number },
  opts?: ApiOptions,
): Promise<{ ok: true; defaultModel: string; itemsPerPage: number }> {
  return apiFetch('/api/settings/display', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
}

// ─── Vault (API keys) ────────────────────────────────────────────────────────

export function addVaultKey(
  body: { provider: string; apiKey: string; label?: string },
  opts?: ApiOptions,
): Promise<{ ok: true }> {
  return apiFetch('/api/vault/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
}

export function deleteVaultKey(
  id: string,
  opts?: ApiOptions,
): Promise<{ ok: true }> {
  return apiFetch(`/api/vault/keys/${id}`, {
    method: 'DELETE',
    signal: opts?.signal,
  });
}
