/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Tests for the centralized error handler middleware (US-046).
 * Verifies that all AppError subclasses serialize to the standard
 * { error, code, details? } shape and that non-AppError errors return 500
 * without leaking stack traces.
 */
import express, { Router, type Request, type Response } from 'express';
import request from 'supertest';
import { errorHandler } from '../lib/error-handler';
import {
  ValidationError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  UnprocessableError,
  GoneError,
  PayloadTooLargeError,
  TooManyRequestsError,
} from '../lib/errors';

/** Build a minimal test Express app with a single throwing route. */
function buildApp(thrownError: unknown) {
  const app = express();
  const router = Router();

  router.get('/test', (_req: Request, _res: Response) => {
    throw thrownError;
  });

  app.use(router);
  app.use(errorHandler);
  return app;
}

describe('errorHandler middleware', () => {
  describe('AppError subclasses', () => {
    it('serializes ValidationError → 400 with VALIDATION_ERROR code', async () => {
      const res = await request(buildApp(new ValidationError('Name is required'))).get('/test');
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'Name is required', code: 'VALIDATION_ERROR' });
    });

    it('serializes ValidationError with details', async () => {
      const res = await request(buildApp(new ValidationError('Invalid input', { field: 'email' }))).get('/test');
      expect(res.status).toBe(400);
      expect(res.body.details).toEqual({ field: 'email' });
    });

    it('serializes AuthError → 401 with AUTH_ERROR code', async () => {
      const res = await request(buildApp(new AuthError('Token expired'))).get('/test');
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: 'Token expired', code: 'AUTH_ERROR' });
    });

    it('serializes ForbiddenError → 403 with FORBIDDEN code', async () => {
      const res = await request(buildApp(new ForbiddenError('Insufficient permissions'))).get('/test');
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'Insufficient permissions', code: 'FORBIDDEN' });
    });

    it('serializes NotFoundError → 404 with NOT_FOUND code', async () => {
      const res = await request(buildApp(new NotFoundError('Workspace', 'ws-123'))).get('/test');
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Workspace 'ws-123' not found", code: 'NOT_FOUND' });
    });

    it('serializes NotFoundError without id', async () => {
      const res = await request(buildApp(new NotFoundError('Run'))).get('/test');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Run not found');
    });

    it('serializes ConflictError → 409 with CONFLICT code', async () => {
      const res = await request(buildApp(new ConflictError('Email already registered'))).get('/test');
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'Email already registered', code: 'CONFLICT' });
    });

    it('serializes UnprocessableError → 422 with UNPROCESSABLE code', async () => {
      const res = await request(buildApp(new UnprocessableError('Circular dependency detected'))).get('/test');
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'Circular dependency detected', code: 'UNPROCESSABLE' });
    });

    it('serializes GoneError → 410 with GONE code', async () => {
      const res = await request(buildApp(new GoneError('This invite has expired'))).get('/test');
      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({ error: 'This invite has expired', code: 'GONE' });
    });

    it('serializes PayloadTooLargeError → 413 with PAYLOAD_TOO_LARGE code', async () => {
      const res = await request(buildApp(new PayloadTooLargeError('File size exceeds 10MB limit'))).get('/test');
      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({ error: 'File size exceeds 10MB limit', code: 'PAYLOAD_TOO_LARGE' });
    });

    it('serializes TooManyRequestsError → 429 with TOO_MANY_REQUESTS code', async () => {
      const res = await request(buildApp(new TooManyRequestsError('Rate limit exceeded'))).get('/test');
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ error: 'Rate limit exceeded', code: 'TOO_MANY_REQUESTS' });
    });
  });

  describe('non-AppError errors', () => {
    it('returns 500 for plain Error without leaking stack trace in production', async () => {
      const original = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const res = await request(buildApp(new Error('DB connection failed'))).get('/test');
        expect(res.status).toBe(500);
        expect(res.body).toMatchObject({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
        expect(res.body.stack).toBeUndefined();
        expect(res.body.details).toBeUndefined();
      } finally {
        process.env.NODE_ENV = original;
      }
    });

    it('returns 500 for thrown string', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await request(buildApp('something broke' as any)).get('/test');
      expect(res.status).toBe(500);
    });
  });

  describe('unique constraint errors', () => {
    it('maps SQLite UNIQUE constraint to 409', async () => {
      const err = new Error('UNIQUE constraint failed: users.email');
      const res = await request(buildApp(err)).get('/test');
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'Resource already exists', code: 'CONFLICT' });
    });

    it('maps PostgreSQL duplicate key to 409', async () => {
      const err = new Error('duplicate key value violates unique constraint "users_email_key"');
      const res = await request(buildApp(err)).get('/test');
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'Resource already exists', code: 'CONFLICT' });
    });
  });

  describe('Cache-Control header', () => {
    it('sets Cache-Control: no-store on error responses', async () => {
      const res = await request(buildApp(new NotFoundError('Workspace'))).get('/test');
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });
});
