/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { Request } from 'express';
import type { AuthUser } from '../lib/auth-utils';

export async function getEffectiveUser(req: Request): Promise<AuthUser | null> {
  if (req.user) {
    return { id: req.user.id, email: req.user.email, supabaseId: req.user.supabaseId, role: req.user.role ?? 'admin', plan: req.user.plan };
  }
  return null;
}
