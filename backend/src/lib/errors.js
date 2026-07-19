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
export class AppError extends Error {
    code;
    details;
    constructor(message, code, details) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        this.details = details;
    }
    /** Serialize to the standard API error response shape. */
    toJSON() {
        const body = {
            error: this.message,
        };
        if (this.code)
            body.code = this.code;
        if (this.details)
            body.details = this.details;
        return body;
    }
}
/** 400 — invalid input, missing required fields */
export class ValidationError extends AppError {
    statusCode = 400;
    constructor(message, details) {
        super(message, 'VALIDATION_ERROR', details);
    }
}
/** 401 — authentication failure, invalid/expired token */
export class AuthError extends AppError {
    statusCode = 401;
    constructor(message = 'Authentication required') {
        super(message, 'AUTH_ERROR');
    }
}
/** 403 — insufficient permissions */
export class ForbiddenError extends AppError {
    statusCode = 403;
    constructor(message = 'Insufficient permissions', details) {
        super(message, 'FORBIDDEN', details);
    }
}
/** 402 — paid plan or license required */
export class PaymentRequiredError extends AppError {
    statusCode = 402;
    constructor(message = 'Paid plan required', details) {
        super(message, 'PLAN_REQUIRED', details);
    }
}
/** 403 — route reserved for local/operator admin */
export class AdminRequiredError extends AppError {
    statusCode = 403;
    constructor(message = 'Admin access required') {
        super(message, 'ADMIN_REQUIRED');
    }
}
/** 403 — invalid CSRF token or missing CSRF proof */
export class CsrfError extends AppError {
    statusCode = 403;
    constructor(message = 'CSRF validation failed') {
        super(message, 'CSRF_INVALID');
    }
}
/** 404 — resource not found */
export class NotFoundError extends AppError {
    statusCode = 404;
    constructor(resource, id) {
        // If the message already looks like a complete sentence (ends with "not found"),
        // use it verbatim. Otherwise build "Resource 'id' not found" or "Resource not found".
        let msg;
        if (resource.toLowerCase().endsWith('not found')) {
            msg = resource;
        }
        else {
            msg = id ? `${resource} '${id}' not found` : `${resource} not found`;
        }
        super(msg, 'NOT_FOUND');
    }
}
/** 404 — dependency or runtime capability missing */
export class DependencyNotFoundError extends AppError {
    statusCode = 404;
    constructor(message, code = 'NOT_FOUND', details) {
        super(message, code, details);
    }
    toJSON() {
        return {
            error: this.message,
            ...(this.code ? { code: this.code } : {}),
            ...(this.details ?? {}),
        };
    }
}
/** 410 — resource is gone (expired links, used tokens, etc.) */
export class GoneError extends AppError {
    statusCode = 410;
    constructor(message) {
        super(message, 'GONE');
    }
}
/** 413 — payload too large */
export class PayloadTooLargeError extends AppError {
    statusCode = 413;
    constructor(message = 'Payload too large') {
        super(message, 'PAYLOAD_TOO_LARGE');
    }
}
/** 429 — too many requests */
export class TooManyRequestsError extends AppError {
    statusCode = 429;
    constructor(message = 'Too many requests') {
        super(message, 'TOO_MANY_REQUESTS');
    }
}
/** 409 — conflict (duplicate, already exists, active run) */
export class ConflictError extends AppError {
    statusCode = 409;
    constructor(message, details) {
        super(message, 'CONFLICT', details);
    }
}
/** 422 — unprocessable entity (valid syntax but semantic error) */
export class UnprocessableError extends AppError {
    statusCode = 422;
    constructor(message, code, details) {
        super(message, code ?? 'UNPROCESSABLE', details);
    }
}
/** 422 — a durable PTY checkpoint failed integrity/version validation */
export class CheckpointCorruptionError extends AppError {
    statusCode = 422;
    constructor(message = 'PTY checkpoint is corrupt', details) {
        super(message, 'CHECKPOINT_CORRUPTION', details);
    }
}
/** 507 — a terminal state cannot be serialized inside its configured bound */
export class RetentionBudgetExhaustedError extends AppError {
    statusCode = 507;
    constructor(message = 'PTY retention budget exhausted', details) {
        super(message, 'RETENTION_BUDGET_EXHAUSTED', details);
    }
}
/** 503 — service unavailable (upstream down, circuit breaker open) */
export class ServiceUnavailableError extends AppError {
    statusCode = 503;
    constructor(message = 'Service temporarily unavailable') {
        super(message, 'SERVICE_UNAVAILABLE');
    }
}
