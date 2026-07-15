/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * V2-094: Standardized API Error Classes
 *
 * All error responses follow: { error: string, code?: string, details?: object }
 * Throw these from route handlers — the centralized error middleware catches them.
 */

export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }

  /** Serialize to the standard API error response shape. */
  toJSON(): { error: string; code?: string; details?: Record<string, unknown> } {
    const body: { error: string; code?: string; details?: Record<string, unknown> } = {
      error: this.message,
    };
    if (this.code) body.code = this.code;
    if (this.details) body.details = this.details;
    return body;
  }
}

/** 400 — invalid input, missing required fields */
export class ValidationError extends AppError {
  readonly statusCode = 400 as const;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', details);
  }
}

/** 401 — authentication failure, invalid/expired token */
export class AuthError extends AppError {
  readonly statusCode = 401 as const;

  constructor(message = 'Authentication required') {
    super(message, 'AUTH_ERROR');
  }
}

/** 403 — insufficient permissions */
export class ForbiddenError extends AppError {
  readonly statusCode = 403 as const;

  constructor(message = 'Insufficient permissions') {
    super(message, 'FORBIDDEN');
  }
}

/** 402 — paid plan or license required */
export class PaymentRequiredError extends AppError {
  readonly statusCode = 402 as const;

  constructor(message = 'Paid plan required', details?: Record<string, unknown>) {
    super(message, 'PLAN_REQUIRED', details);
  }
}

/** 403 — route reserved for local/operator admin */
export class AdminRequiredError extends AppError {
  readonly statusCode = 403 as const;

  constructor(message = 'Admin access required') {
    super(message, 'ADMIN_REQUIRED');
  }
}

/** 403 — invalid CSRF token or missing CSRF proof */
export class CsrfError extends AppError {
  readonly statusCode = 403 as const;

  constructor(message = 'CSRF validation failed') {
    super(message, 'CSRF_INVALID');
  }
}

/** 404 — resource not found */
export class NotFoundError extends AppError {
  readonly statusCode = 404 as const;

  constructor(resource: string, id?: string) {
    // If the message already looks like a complete sentence (ends with "not found"),
    // use it verbatim. Otherwise build "Resource 'id' not found" or "Resource not found".
    let msg: string;
    if (resource.toLowerCase().endsWith('not found')) {
      msg = resource;
    } else {
      msg = id ? `${resource} '${id}' not found` : `${resource} not found`;
    }
    super(msg, 'NOT_FOUND');
  }
}

/** 404 — dependency or runtime capability missing */
export class DependencyNotFoundError extends AppError {
  readonly statusCode = 404 as const;

  constructor(message: string, code = 'NOT_FOUND', details?: Record<string, unknown>) {
    super(message, code, details);
  }

  override toJSON(): { error: string; code?: string; details?: Record<string, unknown> } & Record<string, unknown> {
    return {
      error: this.message,
      ...(this.code ? { code: this.code } : {}),
      ...(this.details ?? {}),
    };
  }
}

/** 410 — resource is gone (expired links, used tokens, etc.) */
export class GoneError extends AppError {
  readonly statusCode = 410 as const;

  constructor(message: string) {
    super(message, 'GONE');
  }
}

/** 413 — payload too large */
export class PayloadTooLargeError extends AppError {
  readonly statusCode = 413 as const;

  constructor(message = 'Payload too large') {
    super(message, 'PAYLOAD_TOO_LARGE');
  }
}

/** 429 — too many requests */
export class TooManyRequestsError extends AppError {
  readonly statusCode = 429 as const;

  constructor(message = 'Too many requests') {
    super(message, 'TOO_MANY_REQUESTS');
  }
}

/** 409 — conflict (duplicate, already exists, active run) */
export class ConflictError extends AppError {
  readonly statusCode = 409 as const;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFLICT', details);
  }
}

/** 422 — unprocessable entity (valid syntax but semantic error) */
export class UnprocessableError extends AppError {
  readonly statusCode = 422 as const;

  constructor(message: string, code?: string, details?: Record<string, unknown>) {
    super(message, code ?? 'UNPROCESSABLE', details);
  }
}

/** 503 — service unavailable (upstream down, circuit breaker open) */
export class ServiceUnavailableError extends AppError {
  readonly statusCode = 503 as const;

  constructor(message = 'Service temporarily unavailable') {
    super(message, 'SERVICE_UNAVAILABLE');
  }
}
