/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020';
import {
  MISSION_STAGE_BY_PHASE,
  PHASES,
  parseControl,
  validateControl,
} from '../control-schema';

const fixtureDirectory = join(__dirname, '..', '__fixtures__');
const loadJson = (fileName: string): unknown => JSON.parse(readFileSync(join(fixtureDirectory, fileName), 'utf8'));
const clone = <T>(value: T): T => structuredClone(value);

const validControl = loadJson('valid-control.json') as Record<string, unknown>;
const schema = JSON.parse(readFileSync(join(__dirname, '..', 'control-schema.json'), 'utf8')) as object;
const validateJsonSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

test('accepts canonical provider and assurance compiler consumer fixtures', () => {
  assert.deepEqual(parseControl(validControl), validControl);
  assert.deepEqual(validateControl(validControl), []);
  assert.equal(validateJsonSchema(validControl), true);

  const consumerFixture = loadJson('assurance-compiler-control.json');
  assert.deepEqual(parseControl(consumerFixture), consumerFixture);
  assert.deepEqual(validateControl(consumerFixture), []);
  assert.equal(validateJsonSchema(consumerFixture), true);
});

test('exports the canonical ordered phase to Mission stage projection', () => {
  assert.deepEqual(PHASES, [
    'planning', 'requirements', 'design', 'development', 'testing', 'deployment', 'maintenance',
  ]);
  assert.deepEqual(MISSION_STAGE_BY_PHASE, {
    planning: 'planning',
    requirements: 'requirements',
    design: 'design',
    development: 'development',
    testing: 'testing',
    deployment: 'deployment',
    maintenance: 'maintenance',
  });
});

test('rejects malformed identity, source, and strict semver fields with useful paths', () => {
  const cases: Array<{ mutate: (record: Record<string, unknown>) => void; path: string }> = [
    { mutate: (record) => { record.schemaVersion = 'rorca.ssdlc-control-record.v2'; }, path: 'schemaVersion' },
    { mutate: (record) => { delete record.controlId; }, path: 'controlId' },
    { mutate: (record) => { record.sourceStrength = 'unverified'; }, path: 'sourceStrength' },
    { mutate: (record) => { record.version = '1.0'; }, path: 'version' },
    {
      mutate: (record) => {
        (record.sourceReferences as Array<Record<string, unknown>>)[0] = { citation: 'missing Genesis identity' };
      },
      path: 'sourceReferences.0.genesisEvidenceId',
    },
  ];

  for (const { mutate, path } of cases) {
    const invalid = clone(validControl);
    mutate(invalid);
    assert.ok(validateControl(invalid).some((error) => error.path.includes(path)), `missing error path ${path}`);
    assert.equal(validateJsonSchema(invalid), false, `JSON Schema accepted invalid ${path}`);
  }
});

test('validates every structured evidence matcher field and rejects untyped requirements', () => {
  const requiredFields = [
    'classification', 'allowedSourceTypes', 'requiredBindings', 'minimumTrust', 'evidenceDepth', 'freshness',
  ];

  for (const field of requiredFields) {
    const invalid = clone(validControl);
    delete ((invalid.requiredEvidence as Array<Record<string, unknown>>)[0])[field];
    assert.ok(validateControl(invalid).some((error) => error.path.includes(`requiredEvidence.0.${field}`)));
    assert.equal(validateJsonSchema(invalid), false);
  }

  const invalidEvidenceCases: Array<{ field: string; value: unknown }> = [
    { field: 'classification', value: 'informal-note' },
    { field: 'allowedSourceTypes', value: [] },
    { field: 'requiredBindings', value: { subject: false, release: false } },
    { field: 'minimumTrust', value: 'unknown' },
    { field: 'evidenceDepth', value: 'shallow' },
    { field: 'freshness', value: { maxAgeSeconds: 0 } },
  ];

  for (const { field, value } of invalidEvidenceCases) {
    const invalid = clone(validControl);
    ((invalid.requiredEvidence as Array<Record<string, unknown>>)[0])[field] = value;
    assert.ok(
      validateControl(invalid).some((error) => error.path.includes(`requiredEvidence.0.${field}`)),
      `runtime validator accepted invalid evidence field ${field}`,
    );
    assert.equal(validateJsonSchema(invalid), false, `JSON Schema accepted invalid evidence field ${field}`);
  }

  const untyped = clone(validControl);
  untyped.requiredEvidence = ['run the tests'];
  assert.ok(validateControl(untyped).some((error) => error.path.includes('requiredEvidence.0')));
  assert.equal(validateJsonSchema(untyped), false);
});
