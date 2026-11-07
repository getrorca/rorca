/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  AppError,
  ValidationError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  UnprocessableError,
  CheckpointCorruptionError,
  RetentionBudgetExhaustedError,
  TranscriptPersistenceError,
  RawArchiveWriteError,
  RawArchiveIntegrityError,
} from '../errors';
import { errorHandler } from '../error-handler';
import type { Request, Response, NextFunction } from 'express';

// ──────────────────────────────────────────────
// Error class unit tests
// ──────────────────────────────────────────────

describe('Error classes', () => {
  test('ValidationError has 400 status and per-field details', () => {
    const err = new ValidationError('Invalid input', {
      email: 'Email is required',
      name: 'Name too short',
    });
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Invalid input');
    expect(err.details).toEqual({ email: 'Email is required', name: 'Name too short' });
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });

  test('AuthError defaults to "Authentication required"', () => {
    const err = new AuthError();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('AUTH_ERROR');
    expect(err.message).toBe('Authentication required');
  });

  test('AuthError accepts custom message', () => {
    const err = new AuthError('Token expired');
    expect(err.message).toBe('Token expired');
  });

  test('ForbiddenError has 403 status', () => {
    const err = new ForbiddenError();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
  });

  test('NotFoundError builds message from resource and id', () => {
    const err = new NotFoundError('Workspace', 'ws-123');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe("Workspace 'ws-123' not found");
  });

  test('NotFoundError without id', () => {
    const err = new NotFoundError('Spec');
    expect(err.message).toBe('Spec not found');
  });

  test('ConflictError has 409 status and optional details', () => {
    const err = new ConflictError('Run already active', { activeRunId: 123 });
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('CONFLICT');
    expect(err.details).toEqual({ activeRunId: 123 });
  });

  test('UnprocessableError has 422 status and supports details', () => {
    const err = new UnprocessableError('Hook failed', undefined, { hookCommand: 'lint', exitCode: 1 });
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('UNPROCESSABLE');
    expect(err.details).toEqual({ hookCommand: 'lint', exitCode: 1 });
  });

  test('PTY checkpoint errors preserve integrity and retention failure codes', () => {
    const corruption = new CheckpointCorruptionError('checksum mismatch', { checkpointId: 'cp-1' });
    expect(corruption).toBeInstanceOf(AppError);
    expect(corruption.statusCode).toBe(422);
    expect(corruption.code).toBe('CHECKPOINT_CORRUPTION');
    expect(corruption.details).toEqual({ checkpointId: 'cp-1' });

    const exhausted = new RetentionBudgetExhaustedError(undefined, { maxBytes: 1024 });
    expect(exhausted).toBeInstanceOf(AppError);
    expect(exhausted.statusCode).toBe(507);
    expect(exhausted.code).toBe('RETENTION_BUDGET_EXHAUSTED');
    expect(exhausted.details).toEqual({ maxBytes: 1024 });
  });

  test('PTY evidence errors distinguish transcript availability, raw writes, and integrity', () => {
    const transcript = new TranscriptPersistenceError(undefined, { generationId: 'gen-1' });
    expect(transcript.statusCode).toBe(503);
    expect(transcript.code).toBe('TRANSCRIPT_PERSISTENCE_FAILED');

    const write = new RawArchiveWriteError(undefined, { segmentIndex: 2 });
    expect(write.statusCode).toBe(507);
    expect(write.code).toBe('RAW_ARCHIVE_WRITE_FAILED');

    const integrity = new RawArchiveIntegrityError(undefined, { segmentIndex: 2 });
    expect(integrity.statusCode).toBe(422);
    expect(integrity.code).toBe('RAW_ARCHIVE_INTEGRITY_FAILED');
    expect(integrity).toBeInstanceOf(AppError);
  });

  test('toJSON produces standard { error, code?, details? } shape', () => {
    const err = new ValidationError('Bad input', { field: 'missing' });
    expect(err.toJSON()).toEqual({
      error: 'Bad input',
      code: 'VALIDATION_ERROR',
      details: { field: 'missing' },
    });
  });

  test('toJSON omits code/details when not set', () => {
    const err = new NotFoundError('Item');
    const json = err.toJSON();
    expect(json).toEqual({ error: 'Item not found', code: 'NOT_FOUND' });
    expect(json).not.toHaveProperty('details');
  });
});

// ──────────────────────────────────────────────
// Error handler middleware tests
// ──────────────────────────────────────────────

function mockRes(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

const mockReq = {} as Request;
const mockNext = jest.fn() as NextFunction;

describe('errorHandler middleware', () => {
  const origEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = origEnv;
    jest.clearAllMocks();
  });

  test('handles AppError subclass with correct status and body', () => {
    const res = mockRes();
    const err = new NotFoundError('Workspace', 'ws-1');

    process.env.NODE_ENV = 'production';
    errorHandler(err, mockReq, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: "Workspace 'ws-1' not found",
      code: 'NOT_FOUND',
    });
  });

  test('includes stack trace in development mode', () => {
    const res = mockRes();
    const err = new ValidationError('Bad', { email: 'required' });

    process.env.NODE_ENV = 'development';
    errorHandler(err, mockReq, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.error).toBe('Bad');
    expect(body.stack).toBeDefined();
    expect(body.details).toEqual({ email: 'required' });
  });

  test('does not include stack in production', () => {
    const res = mockRes();
    const err = new AuthError('Invalid token');

    process.env.NODE_ENV = 'production';
    errorHandler(err, mockReq, res, mockNext);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body).not.toHaveProperty('stack');
  });

  test('catches UNIQUE constraint as 409 Conflict', () => {
    const res = mockRes();
    const err = new Error('UNIQUE constraint failed: workspaces.id');

    process.env.NODE_ENV = 'production';
    errorHandler(err, mockReq, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Resource already exists',
      code: 'CONFLICT',
    });
  });

  test('unknown errors return 500 with generic message in production', () => {
    const res = mockRes();
    const err = new Error('something broke');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    process.env.NODE_ENV = 'production';
    errorHandler(err, mockReq, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.error).toBe('Internal server error');
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body).not.toHaveProperty('stack');
    expect(body).not.toHaveProperty('details');

    spy.mockRestore();
  });

  test('unknown errors expose details in development', () => {
    const res = mockRes();
    const err = new Error('something broke');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    process.env.NODE_ENV = 'development';
    errorHandler(err, mockReq, res, mockNext);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.error).toBe('Internal server error');
    expect(body.stack).toBeDefined();
    expect(body.details).toEqual({ originalMessage: 'something broke' });

    spy.mockRestore();
  });
});
