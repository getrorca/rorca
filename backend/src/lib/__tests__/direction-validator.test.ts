/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { validateDirectionYaml, getPreviewWarnings } from '../direction-validator';

// --- YAML parse errors ---

test('invalid YAML returns yamlError with line/column', () => {
  const result = validateDirectionYaml(1, 'foo: [unclosed\n  bar: baz');
  expect(result.valid).toBe(false);
  expect(result.yamlError).toBeDefined();
  expect(result.yamlError!.line).toBeGreaterThan(0);
  expect(result.yamlError!.message).toBeTruthy();
});

test('YAML tab indentation error returns yamlError', () => {
  const result = validateDirectionYaml(1, 'foo:\n\tbar: baz');
  expect(result.valid).toBe(false);
  expect(result.yamlError).toBeDefined();
});

// --- L1/L2 (no required fields) ---

test('L1 valid with mapping YAML', () => {
  const result = validateDirectionYaml(1, 'quality: high\nstyle: concise');
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
});

test('L1 valid with plain text YAML', () => {
  const result = validateDirectionYaml(1, 'just plain text');
  expect(result.valid).toBe(true);
});

test('L2 valid with any structure', () => {
  const result = validateDirectionYaml(2, 'auth_pattern: jwt\napi_convention: REST');
  expect(result.valid).toBe(true);
});

// --- L3 schema validation ---

test('L3 valid with all required fields', () => {
  const yaml = `name: MyProject
type: web-app
stack:
  - React
  - Node.js
purpose: Ship v2 of the dashboard
key_modules:
  - auth
  - billing`;
  const result = validateDirectionYaml(3, yaml);
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
});

test('L3 with extra fields still passes (passthrough)', () => {
  const yaml = `name: MyProject
type: web-app
stack: [React]
purpose: Ship v2
key_modules: [auth]
extra_field: should be allowed`;
  const result = validateDirectionYaml(3, yaml);
  expect(result.valid).toBe(true);
});

test('L3 missing all required fields returns errors with paths', () => {
  const result = validateDirectionYaml(3, 'goal: ship v2');
  expect(result.valid).toBe(false);
  expect(result.errors.length).toBeGreaterThanOrEqual(5);
  const paths = result.errors.map(e => e.path);
  expect(paths).toContain('name');
  expect(paths).toContain('type');
  expect(paths).toContain('stack');
  expect(paths).toContain('purpose');
  expect(paths).toContain('key_modules');
});

test('L3 with stack as string returns error', () => {
  const yaml = `name: MyProject
type: web-app
stack: not-an-array
purpose: Ship v2
key_modules: [auth]`;
  const result = validateDirectionYaml(3, yaml);
  expect(result.valid).toBe(false);
  expect(result.errors.some(e => e.path === 'stack')).toBe(true);
});

test('L3 with key_modules as string returns error', () => {
  const yaml = `name: MyProject
type: web-app
stack: [React]
purpose: Ship v2
key_modules: not-an-array`;
  const result = validateDirectionYaml(3, yaml);
  expect(result.valid).toBe(false);
  expect(result.errors.some(e => e.path === 'key_modules')).toBe(true);
});

test('L3 with scalar YAML returns error about mapping', () => {
  const result = validateDirectionYaml(3, 'just a string');
  expect(result.valid).toBe(false);
  expect(result.errors[0].message).toContain('YAML mapping');
});

test('L3 with empty YAML returns error about mapping', () => {
  const result = validateDirectionYaml(3, '');
  expect(result.valid).toBe(false);
  expect(result.errors[0].message).toContain('YAML mapping');
});

// --- Preview warnings ---

test('getPreviewWarnings flags empty L1', () => {
  const warnings = getPreviewWarnings({});
  expect(warnings.some(w => w.code === 'EMPTY_L1')).toBe(true);
});

test('getPreviewWarnings flags missing L3 for workspace', () => {
  const warnings = getPreviewWarnings({ workspaceId: 'ws-1' });
  expect(warnings.some(w => w.code === 'MISSING_L3')).toBe(true);
});

test('getPreviewWarnings does not flag missing L3 without workspace', () => {
  const warnings = getPreviewWarnings({});
  expect(warnings.some(w => w.code === 'MISSING_L3')).toBe(false);
});

test('getPreviewWarnings flags domain mismatch', () => {
  const warnings = getPreviewWarnings({
    l1Content: 'quality: high',
    workspaceId: 'ws-1',
    l3Content: 'name: test',
    domain: 'frontend',
    workspaceDomains: ['backend', 'infra'],
  });
  expect(warnings.some(w => w.code === 'DOMAIN_MISMATCH')).toBe(true);
});

test('getPreviewWarnings no domain mismatch when domain matches', () => {
  const warnings = getPreviewWarnings({
    l1Content: 'quality: high',
    workspaceId: 'ws-1',
    l3Content: 'name: test',
    domain: 'backend',
    workspaceDomains: ['backend', 'infra'],
  });
  expect(warnings.some(w => w.code === 'DOMAIN_MISMATCH')).toBe(false);
});

test('getPreviewWarnings returns empty array when fully configured', () => {
  const warnings = getPreviewWarnings({
    l1Content: 'quality: high',
    l3Content: 'name: test',
    workspaceId: 'ws-1',
  });
  expect(warnings).toEqual([]);
});
