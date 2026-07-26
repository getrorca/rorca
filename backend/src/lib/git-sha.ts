/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Canonical Git/GitHub commit identity: exactly 40 lowercase hexadecimal bytes. */

import { z } from 'zod';

export const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const GIT_SHA_PATTERN_CASE_INSENSITIVE = /^[0-9a-f]{40}$/i;

export const GitShaSchema = z.string()
  .regex(GIT_SHA_PATTERN, 'Git commit SHA must be 40 lowercase hex characters');

export type GitSha = z.infer<typeof GitShaSchema>;

export function isGitSha(value: unknown): value is string {
  return typeof value === 'string' && GIT_SHA_PATTERN_CASE_INSENSITIVE.test(value);
}

export function normalizeGitSha(value: unknown): GitSha | null {
  if (!isGitSha(value)) return null;
  return value.toLowerCase() as GitSha;
}
