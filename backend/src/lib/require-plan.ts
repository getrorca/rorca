/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Request, Response, NextFunction } from 'express';

/**
 * OSS edition: local-first, no billing gate.
 * Keep the middleware shape so existing route wiring does not need to change.
 */
export function requirePlan(_feature: string) {
  return async (_req: Request, _res: Response, next: NextFunction): Promise<void> => {
    next();
  };
}
