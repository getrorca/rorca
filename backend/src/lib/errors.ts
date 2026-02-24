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

  constructor(message: string, details?: Record<string, string>) {
    super(message, 'VALIDATION_ERROR', details as Record<string, unknown> | undefined);
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

/** 404 — resource not found */
export class NotFoundError extends AppError {
  readonly statusCode = 404 as const;

  constructor(resource: string, id?: string) {
    const msg = id ? `${resource} '${id}' not found` : `${resource} not found`;
    super(msg, 'NOT_FOUND');
  }
}

/** 409 — conflict (duplicate, already exists, active run) */
export class ConflictError extends AppError {
  readonly statusCode = 409 as const;

  constructor(message: string) {
    super(message, 'CONFLICT');
  }
}

/** 422 — unprocessable entity (valid syntax but semantic error) */
export class UnprocessableError extends AppError {
  readonly statusCode = 422 as const;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'UNPROCESSABLE', details);
  }
}
