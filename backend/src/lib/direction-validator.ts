/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as yaml from 'js-yaml';
import { z } from 'zod';

// --- Per-layer Zod schemas ---

const l1Schema = z.object({}).passthrough();

const l2Schema = z.object({}).passthrough();

const l3Schema = z.object({
  name: z.string({ error: 'name is required and must be a string' }),
  type: z.string({ error: 'type is required and must be a string' }),
  stack: z.array(z.any(), { error: 'stack is required and must be an array' }),
  purpose: z.string({ error: 'purpose is required and must be a string' }),
  key_modules: z.array(z.any(), { error: 'key_modules is required and must be an array' }),
}).passthrough();

const layerSchemas: Record<number, z.ZodTypeAny> = {
  1: l1Schema,
  2: l2Schema,
  3: l3Schema,
};

// --- Validation types ---

export interface ValidationError {
  path: string;
  message: string;
}

export interface YamlParseError {
  line: number | null;
  column: number | null;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  yamlError?: YamlParseError;
  errors: ValidationError[];
}

// --- Core validation function ---

export function validateDirectionYaml(layer: number, contentYaml: string): ValidationResult {
  // 1. Parse YAML
  let parsed: unknown;
  try {
    parsed = yaml.load(contentYaml);
  } catch (err: unknown) {
    const yamlErr = err as yaml.YAMLException;
    return {
      valid: false,
      yamlError: {
        line: yamlErr.mark?.line != null ? yamlErr.mark.line + 1 : null, // yaml.js uses 0-based lines
        column: yamlErr.mark?.column != null ? yamlErr.mark.column + 1 : null,
        message: yamlErr.reason || yamlErr.message,
      },
      errors: [],
    };
  }

  // 2. If parsed result is a plain string or null, it's valid YAML but not a mapping
  if (parsed === null || parsed === undefined || typeof parsed === 'string' || typeof parsed === 'number') {
    // For L3, this is invalid since we need an object with required fields
    if (layer === 3) {
      return {
        valid: false,
        errors: [{ path: '', message: 'L3 content must be a YAML mapping (object), not a scalar or empty value' }],
      };
    }
    // For L1/L2, plain text content is acceptable
    return { valid: true, errors: [] };
  }

  // 3. Schema validation
  const schema = layerSchemas[layer];
  if (!schema) {
    return { valid: true, errors: [] };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const errors: ValidationError[] = result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : issue.path[0]?.toString() || '',
      message: issue.message,
    }));
    return { valid: false, errors };
  }

  return { valid: true, errors: [] };
}

// --- Preview warnings ---

export interface PreviewWarning {
  code: string;
  message: string;
}

export function getPreviewWarnings(opts: {
  l1Content?: string;
  l2Content?: string;
  l3Content?: string;
  workspaceId?: string;
  domain?: string;
  workspaceDomains?: string[]; // parsed from JSON array in workspaces.domains
}): PreviewWarning[] {
  const warnings: PreviewWarning[] = [];

  // Empty layer warnings
  if (!opts.l1Content?.trim()) {
    warnings.push({
      code: 'EMPTY_L1',
      message: 'L1 (Global Standards) is empty — spec generation will have no global engineering guidance',
    });
  }

  if (opts.workspaceId && !opts.l3Content?.trim()) {
    warnings.push({
      code: 'MISSING_L3',
      message: 'L3 (Project Context) is missing for this workspace — specs won\'t include project-specific context',
    });
  }

  if (opts.l2Content && !opts.l2Content.trim()) {
    warnings.push({
      code: 'EMPTY_L2',
      message: 'L2 (Domain Profile) is set but empty',
    });
  }

  // Domain mismatch: requested L2 domain not in workspace's domains list
  if (opts.domain && opts.workspaceDomains && opts.workspaceDomains.length > 0
      && !opts.workspaceDomains.includes(opts.domain)) {
    warnings.push({
      code: 'DOMAIN_MISMATCH',
      message: `L2 domain '${opts.domain}' is not in workspace domains [${opts.workspaceDomains.join(', ')}]`,
    });
  }

  return warnings;
}
