/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { CANONICAL_PHASE_IDS } from '../ssdlc-contracts';
import { swaggerSpec } from '../swagger';

const paths = (swaggerSpec as {
  paths: Record<string, Record<string, {
    parameters?: Array<{ name?: string; schema?: { enum?: string[] } }>;
    requestBody?: { content?: { 'application/json'?: { schema?: { properties?: Record<string, { enum?: string[] }> } } } };
  }>>;
}).paths;

function parameterEnum(pathname: string, method: string, name: string): string[] | undefined {
  return paths[pathname]?.[method]?.parameters?.find((parameter) => parameter.name === name)?.schema?.enum;
}

test('lifecycle OpenAPI exposes only the exact seven canonical phases', () => {
  const canonical = [...CANONICAL_PHASE_IDS];
  expect(parameterEnum('/api/lifecycle', 'get', 'phase')).toEqual(canonical);
  expect(parameterEnum('/api/lifecycle/specs/{specId}/phases/{phaseId}', 'get', 'phaseId')).toEqual(canonical);
  expect(paths['/api/lifecycle/specs/{specId}/advice']?.post
    ?.requestBody?.content?.['application/json']?.schema?.properties?.phaseId?.enum).toEqual(canonical);
});
