/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * V2-094: Centralized Express error handler middleware.
 *
 * Catches all errors (thrown AppError subclasses + unhandled exceptions)
 * and formats them into the standard { error, code?, details? } shape.
 *
 * Stack traces are included only when NODE_ENV=development.
 */

import type { Request, Response, NextFunction } from 'express';
import { AppError, MalformedJsonError, PayloadTooLargeError } from './errors';
import { logger } from './logger';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Error responses must not be cached — prevents browser from serving stale 4xx
  // from a previous backend state (e.g., cached "workspace not found" after rename).
  res.set('Cache-Control', 'no-store');

  // Known AppError subclass — use its status code and structured body
  if (err instanceof AppError) {
    const body = err.toJSON();
    if (process.env.NODE_ENV === 'development') {
      (body as Record<string, unknown>).stack = err.stack;
    }
    res.status(err.statusCode).json(body);
    return;
  }

  // Normalize body-parser failures into the same stable public envelope as
  // route-thrown AppErrors. Parser failures occur before route validation.
  const parserError = err as Error & { type?: string; status?: number; statusCode?: number; limit?: number };
  if (parserError.type === 'entity.too.large' || parserError.status === 413 || parserError.statusCode === 413) {
    const normalized = new PayloadTooLargeError('Request body exceeds the configured limit');
    res.status(normalized.statusCode).json(normalized.toJSON());
    return;
  }
  if (parserError.type === 'entity.parse.failed' && parserError.status === 400) {
    const normalized = new MalformedJsonError();
    res.status(normalized.statusCode).json(normalized.toJSON());
    return;
  }

  // Express reports malformed percent-encoded path parameters as URIError(400).
  // Preserve that client rejection instead of converting malformed routing input
  // into an internal error response.
  if (err instanceof URIError && (err as URIError & { status?: number }).status === 400) {
    res.status(400).json({
      error: 'Malformed request path encoding',
      code: 'MALFORMED_PATH',
    });
    return;
  }

  // SQLite unique constraint — map to 409 Conflict
  if (err.message?.includes('UNIQUE constraint failed')) {
    res.status(409).json({
      error: 'Resource already exists',
      code: 'CONFLICT',
    });
    return;
  }

  // PostgreSQL unique constraint — map to 409 Conflict
  if (err.message?.includes('duplicate key value violates unique constraint')) {
    res.status(409).json({
      error: 'Resource already exists',
      code: 'CONFLICT',
    });
    return;
  }

  // Unhandled / unexpected errors — 500
  logger.error({ err, stack: err.stack }, '[ErrorHandler] Unhandled error');
  const body: Record<string, unknown> = {
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  };
  if (process.env.NODE_ENV === 'development') {
    body.stack = err.stack;
    body.details = { originalMessage: err.message };
  }
  res.status(500).json(body);
}
