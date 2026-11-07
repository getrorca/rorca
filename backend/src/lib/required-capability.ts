/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { z } from 'zod';
import { assertAuthorityRedactedValue } from './authority-redaction';

export const REQUIRED_CAPABILITY_SCHEMA_VERSION = 'rorca.required-capability.v1' as const;
export const REQUIRED_CAPABILITY_SET_SCHEMA_VERSION = 'rorca.required-capability-set.v1' as const;

const semanticId = z.string().trim().min(1).max(256)
  .regex(/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)+$/, 'must be a lowercase namespaced identifier');
const scopeValue = z.string().trim().min(1).max(1024)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, 'contains unsupported scope characters')
  .refine((value) => !value.includes('//') && !value.split('/').some((segment) => segment === '.' || segment === '..'), {
    message: 'must be a canonical resource scope without empty or traversal segments',
  });

export const CapabilityEvidenceRequirementSchema = z.object({
  kind: semanticId,
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  required: z.boolean().default(true),
}).strict();
export type CapabilityEvidenceRequirement = z.infer<typeof CapabilityEvidenceRequirementSchema>;

export const RequiredCapabilityDeclarationSchema = z.object({
  schemaVersion: z.literal(REQUIRED_CAPABILITY_SCHEMA_VERSION),
  capabilityId: semanticId,
  bindingReference: z.string().trim().min(1).max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'contains unsupported binding-reference characters'),
  bindingGeneration: z.number().int().positive().safe(),
  scope: z.object({
    environment: z.string().trim().min(1).max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'contains unsupported environment-scope characters'),
    resource: scopeValue,
  }).strict(),
  requestedMode: semanticId,
  evidenceRequirements: z.array(CapabilityEvidenceRequirementSchema).max(100),
  constraints: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type RequiredCapabilityDeclaration = z.infer<typeof RequiredCapabilityDeclarationSchema>;

export const RequiredCapabilitySetSchema = z.object({
  schemaVersion: z.literal(REQUIRED_CAPABILITY_SET_SCHEMA_VERSION),
  declarations: z.array(RequiredCapabilityDeclarationSchema).max(1000),
}).strict();
export type RequiredCapabilitySet = z.infer<typeof RequiredCapabilitySetSchema>;

export function parseRequiredCapabilityDeclarations(value: unknown, field: string): RequiredCapabilityDeclaration[] {
  const result = z.array(RequiredCapabilityDeclarationSchema).max(1000).safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const location = issue?.path.length ? `${field}.${issue.path.join('.')}` : field;
    throw new TypeError(`${location}: ${issue?.message ?? 'invalid required-capability declaration'}`);
  }
  assertAuthorityRedactedValue(result.data);
  return result.data;
}
