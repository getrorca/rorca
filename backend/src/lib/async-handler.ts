/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Express 4 async error handler.
 *
 * Express 4 does NOT catch rejected promises from async route handlers.
 * This module patches Express's Router.Layer to automatically forward
 * async errors to the centralized error handler middleware.
 *
 * Import this module BEFORE registering any routes in server.ts:
 *   import './lib/async-handler';
 *
 * This is the standard pattern used by express-async-errors and similar
 * libraries. It eliminates the need to wrap every async handler in
 * try/catch or call next(err) manually.
 */

import type { Request, Response, NextFunction } from 'express';
import { AppError } from './errors';

const Layer = require('express/lib/router/layer');

// Idempotency guard — prevent double-patching when jest.resetModules() re-requires this file
if (!(Layer.prototype as any).__asyncPatched) {
  // Replace handle_request entirely instead of wrapping it.
  // The original does `try { fn(req, res, next) } catch (err) { next(err) }`
  // but discards the return value, so async function rejections are never caught.
  // We replicate the original logic but add `.catch(next)` on the returned Promise.
  Layer.prototype.handle_request = function handleRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const fn = this.handle;

    if (fn.length > 3) {
      // Not a standard request handler (error handler has 4 params)
      return next();
    }

    try {
      const result = fn(req, res, next);

      // If the handler returned a Promise (async function), catch rejections
      if (result && typeof result.catch === 'function') {
        result.catch(next);
      }
    } catch (err) {
      next(err);
    }
  };

  (Layer.prototype as any).__asyncPatched = true;
}

/**
 * Route-level catch handler that preserves AppError status codes.
 *
 * Use in route catch blocks instead of bare res.status(500).json():
 *
 *   } catch (error: any) {
 *     handleRouteError(res, error, '[Pipeline] Trigger');
 *   }
 *
 * - AppError subclasses → uses statusCode from the error (400, 404, 409, 422, etc.)
 * - Unknown errors → 500 with generic message, logged as error
 */
export function handleRouteError(
  res: Response,
  error: unknown,
  context?: string,
): void {
  if (error instanceof AppError) {
    res.status(error.statusCode).json(error.toJSON());
    return;
  }
  const err = error as Error;
  if (context) {
    // Dynamic import to avoid circular deps — logger is safe to require synchronously
    try {
      const { logger } = require('./logger');
      logger.error({ err }, `${context} error:`);
    } catch {
      console.error(`${context} error:`, err);
    }
  }
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
}
