/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PR-006: Zod validation middleware factories for Express routes.
 *
 * Usage:
 *   router.post('/foo', validateBody(MySchema), (req, res) => { ... });
 *   router.get('/bar/:id', validateParams(ParamsSchema), (req, res) => { ... });
 *   router.get('/baz', validateQuery(QuerySchema), (req, res) => { ... });
 *
 * On failure returns 400 with { error: firstIssueMessage, details: zodError.issues }.
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

/**
 * Validate req.body against a Zod schema.
 * Returns 422 with 'Validation failed' and details on failure.
 */
export function validateBody<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(422).json({
        error: 'Validation failed',
        details: result.error.issues,
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

/**
 * Validate req.query against a Zod schema.
 * Returns 422 with structured Zod issues on failure.
 */
export function validateQuery<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      res.status(400).json({
        error: firstIssue?.message || 'Validation failed',
        details: result.error.issues,
      });
      return;
    }
    req.query = result.data as any;
    next();
  };
}

/**
 * Validate req.params against a Zod schema.
 * Returns 422 with structured Zod issues on failure.
 */
export function validateParams<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      res.status(400).json({
        error: firstIssue?.message || 'Validation failed',
        details: result.error.issues,
      });
      return;
    }
    req.params = result.data as any;
    next();
  };
}
