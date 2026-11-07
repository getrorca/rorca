/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { Request } from 'express';
import { ForbiddenError, ValidationError } from './errors';

export const HERMES_AUTHORITY_MODES = ['service-audit', 'operator-dispatch'] as const;
export type HermesAuthorityMode = typeof HERMES_AUTHORITY_MODES[number];

export const HERMES_ACTIONS = ['intent', 'persist', 'subscription', 'watchdog', 'dispatch'] as const;
export type HermesAction = typeof HERMES_ACTIONS[number];

export interface HermesAuthorityDeclaration {
  action: HermesAction;
  authorityMode: HermesAuthorityMode;
  auditIdentity: string;
}

export const HERMES_AUTHORITY_HEADERS = {
  action: 'X-Rorca-Hermes-Action',
  authorityMode: 'X-Rorca-Hermes-Authority-Mode',
  auditIdentity: 'X-Rorca-Hermes-Audit-Identity',
} as const;

export const HERMES_ACTION_AUTHORITY_MODES: Readonly<Record<HermesAction, HermesAuthorityMode>> = Object.freeze({
  intent: 'service-audit',
  persist: 'operator-dispatch',
  subscription: 'service-audit',
  watchdog: 'operator-dispatch',
  dispatch: 'operator-dispatch',
});

export function configuredHermesAuditIdentity(): string {
  const identity = String(process.env.RORCA_HERMES_SERVICE_EMAIL ?? 'hermes@rorca.internal').trim().toLowerCase();
  if (!identity) {
    throw new ValidationError('Hermes audit identity is not configured', {
      code: 'HERMES_AUDIT_IDENTITY_NOT_CONFIGURED',
    });
  }
  return identity;
}

export function requiredHermesAuthorityMode(action: HermesAction): HermesAuthorityMode {
  return HERMES_ACTION_AUTHORITY_MODES[action];
}

export function declareHermesAuthority(
  action: HermesAction,
  authorityMode: HermesAuthorityMode,
  auditIdentity = configuredHermesAuditIdentity(),
): HermesAuthorityDeclaration {
  const declaration = { action, authorityMode, auditIdentity: auditIdentity.trim().toLowerCase() };
  validateHermesAuthority(declaration);
  return declaration;
}

/** AppError subclasses take (message, details); the response code must be
 *  carried separately. Build errors with their exact API code. */
function authorityError(
  ErrorType: typeof ForbiddenError | typeof ValidationError,
  message: string,
  code: string,
  details?: Record<string, unknown>,
): Error {
  const error = new ErrorType(message, details);
  (error as { code?: string }).code = code;
  return error;
}

export function validateHermesAuthority(declaration: HermesAuthorityDeclaration): void {
  if (!(HERMES_ACTIONS as readonly string[]).includes(declaration.action)
    || !(HERMES_AUTHORITY_MODES as readonly string[]).includes(declaration.authorityMode)
    || declaration.auditIdentity !== configuredHermesAuditIdentity()) {
    throw authorityError(ValidationError, 'Invalid Hermes authority declaration', 'HERMES_AUTHORITY_INVALID');
  }
  const requiredMode = requiredHermesAuthorityMode(declaration.action);
  if (declaration.authorityMode !== requiredMode) {
    throw authorityError(
      ForbiddenError,
      requiredMode === 'operator-dispatch'
        ? 'Hermes mutation requires explicit operator-equivalent dispatch authority'
        : 'Hermes audit action cannot exercise operator-equivalent authority',
      'HERMES_AUTHORITY_MODE_MISMATCH',
      { action: declaration.action, requiredAuthorityMode: requiredMode },
    );
  }
}

function oneHeader(req: Pick<Request, 'headers'>, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function parseHermesAuthority(req: Pick<Request, 'headers'>): HermesAuthorityDeclaration {
  const action = oneHeader(req, HERMES_AUTHORITY_HEADERS.action);
  const authorityMode = oneHeader(req, HERMES_AUTHORITY_HEADERS.authorityMode);
  const auditIdentity = oneHeader(req, HERMES_AUTHORITY_HEADERS.auditIdentity);
  if (!action || !authorityMode || !auditIdentity) {
    throw new ValidationError('Hermes action, authority mode, and audit identity headers are required', {
      code: 'HERMES_AUTHORITY_DECLARATION_REQUIRED',
    });
  }
  const declaration = { action, authorityMode, auditIdentity } as HermesAuthorityDeclaration;
  validateHermesAuthority(declaration);
  return declaration;
}

export function hermesAuthorityHeaders(declaration: HermesAuthorityDeclaration): Record<string, string> {
  validateHermesAuthority(declaration);
  return {
    [HERMES_AUTHORITY_HEADERS.action]: declaration.action,
    [HERMES_AUTHORITY_HEADERS.authorityMode]: declaration.authorityMode,
    [HERMES_AUTHORITY_HEADERS.auditIdentity]: declaration.auditIdentity,
  };
}

export function requireHermesAction(
  declaration: HermesAuthorityDeclaration | undefined,
  action: HermesAction,
  authorityMode?: HermesAuthorityMode,
): void {
  const requiredMode = authorityMode ?? requiredHermesAuthorityMode(action);
  if (!declaration || declaration.action !== action) {
    throw authorityError(
      ForbiddenError,
      'Hermes authority does not permit this action',
      'HERMES_ACTION_AUTHORITY_DENIED',
      { action, requiredAuthorityMode: requiredMode },
    );
  }
  validateHermesAuthority(declaration);
  if (declaration.authorityMode !== requiredMode) {
    throw authorityError(
      ForbiddenError,
      'Hermes authority does not permit this action',
      'HERMES_ACTION_AUTHORITY_DENIED',
      { action, requiredAuthorityMode: requiredMode },
    );
  }
}
