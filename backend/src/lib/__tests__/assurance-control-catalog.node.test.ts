/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020';
import controlsArtifact from '../../ssdlc/catalog/controls.json';
import publishedSchema from '../../ssdlc/schema/control-schema.json';
import consumerArtifact from '../../ssdlc/catalog/__fixtures__/aav-consumer.json';
import {
  resolveAssuranceControl,
  resolveAssuranceControls,
  validateAssuranceCompilationInput,
} from '../assurance-control-catalog';

const clone = <T>(value: T): T => structuredClone(value);
const validatePublishedShape = new Ajv2020({ allErrors: true, strict: true }).compile(publishedSchema);

test('loads the actual US-001 schema and resolves the US-008 consumer artifact from the sole catalog', () => {
  assert.equal(consumerArtifact.catalogRef, '../controls.json');
  assert.ok(controlsArtifact.every((control) => validatePublishedShape(control)));

  const resolved = resolveAssuranceControls(consumerArtifact.controlIds);
  assert.deepEqual(resolved, controlsArtifact);
  assert.ok(resolved.every((control) => Object.isFrozen(control)));
  assert.ok(resolved.every((control) => control.requiredEvidence.every((requirement) => (
    requirement.allowedSourceTypes.length > 0
      && typeof requirement.requiredBindings.subject === 'boolean'
      && typeof requirement.requiredBindings.release === 'boolean'
  ))));
});

test('rejects unknown controlId values rather than manufacturing assurance controls', () => {
  assert.throws(
    () => resolveAssuranceControl('CTRL-NOT-IN-US-001'),
    /Unknown US-001 controlId: CTRL-NOT-IN-US-001/,
  );

  const unknown = clone(controlsArtifact[0]) as Record<string, unknown>;
  unknown.controlId = 'CTRL-NOT-IN-US-001';
  assert.equal(validatePublishedShape(unknown), true, 'generic US-001 shape remains valid');
  assert.throws(() => validateAssuranceCompilationInput([unknown]), /Unknown US-001 controlId/);
});

test('rejects provider-version mismatch and malformed US-001 evidence shape', () => {
  const wrongProviderVersion = clone(controlsArtifact[0]);
  wrongProviderVersion.version = '2.0.0';
  assert.equal(validatePublishedShape(wrongProviderVersion), true, 'provider version remains valid SemVer');
  assert.throws(
    () => validateAssuranceCompilationInput([wrongProviderVersion]),
    /US-008 provider record mismatch/,
  );

  const wrongSchemaVersion = clone(controlsArtifact[0]) as Record<string, unknown>;
  wrongSchemaVersion.schemaVersion = 'rorca.ssdlc-control-record.v2';
  assert.equal(validatePublishedShape(wrongSchemaVersion), false);
  assert.throws(() => validateAssuranceCompilationInput([wrongSchemaVersion]), /schemaVersion/);

  const malformed = clone(controlsArtifact[0]) as Record<string, unknown>;
  delete ((malformed.requiredEvidence as Array<Record<string, unknown>>)[0]).requiredBindings;
  assert.equal(validatePublishedShape(malformed), false);
  assert.throws(() => validateAssuranceCompilationInput([malformed]), /requiredBindings/);
});

test('rejects changed provider records even when their generic US-001 shape is still valid', () => {
  const changed = clone(controlsArtifact[0]);
  changed.objective = 'A consumer-incompatible objective change.';
  assert.equal(validatePublishedShape(changed), true);
  assert.throws(() => validateAssuranceCompilationInput([changed]), /US-008 provider record mismatch/);

  const lexicallyChanged = clone(controlsArtifact[0]);
  lexicallyChanged.objective = ` ${lexicallyChanged.objective} `;
  assert.equal(validatePublishedShape(lexicallyChanged), true);
  assert.throws(
    () => validateAssuranceCompilationInput([lexicallyChanged]),
    /US-008 provider record mismatch/,
    'schema-valid provider text must not be normalized before contract comparison',
  );

  const { schemaVersion, ...rest } = clone(controlsArtifact[0]);
  const reordered = { ...rest, schemaVersion };
  assert.deepEqual(validateAssuranceCompilationInput([reordered]), [controlsArtifact[0]]);
});
