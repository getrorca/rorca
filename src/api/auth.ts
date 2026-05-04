/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { apiFetch } from '../lib/apiFetch';
import type { ApiOptions, AuthUser, LoginResponse } from './types';

export function login(
  email: string,
  password: string,
  opts?: ApiOptions,
): Promise<LoginResponse> {
  return apiFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: opts?.signal,
  });
}

export function register(
  email: string,
  password: string,
  displayName: string,
  opts?: ApiOptions,
): Promise<LoginResponse> {
  return apiFetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName }),
    signal: opts?.signal,
  });
}

export function getMe(opts?: ApiOptions): Promise<{ user: AuthUser }> {
  return apiFetch('/api/auth/me', { signal: opts?.signal });
}

export function logout(opts?: ApiOptions): Promise<{ message: string }> {
  return apiFetch('/api/auth/logout', {
    method: 'POST',
    signal: opts?.signal,
  });
}
