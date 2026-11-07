/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { isDeepStrictEqual } from 'node:util';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import controlsArtifact from '../ssdlc/catalog/controls.json';
import publishedControlSchema from '../ssdlc/schema/control-schema.json';
import { type ControlRecord } from '../ssdlc/schema/control-schema';

/** Recursively freeze provider records so this query adapter cannot become a catalog writer. */
function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

const validatePublishedControl: ValidateFunction = new Ajv2020({ allErrors: true, strict: true })
  .compile(publishedControlSchema);

function parsePublishedControl(input: unknown): Readonly<ControlRecord> {
  if (!validatePublishedControl(input)) {
    const detail = validatePublishedControl.errors
      ?.map(({ instancePath, message }) => `${instancePath || '/'} ${message ?? 'is invalid'}`)
      .join('; ');
    throw new TypeError(`Invalid US-001 ControlRecord: ${detail ?? 'schema validation failed'}`);
  }

  // AJV validates the published US-001 contract. Clone without normalization so lexical
  // provider changes (including whitespace) cannot compare equal to the US-008 artifact.
  return freeze(structuredClone(input) as ControlRecord);
}

function parseProviderArtifact(input: unknown): readonly Readonly<ControlRecord>[] {
  if (!Array.isArray(input)) throw new TypeError('The US-008 control catalog artifact must be an array');

  const controls = input.map(parsePublishedControl);
  const ids = controls.map(({ controlId }) => controlId);
  if (new Set(ids).size !== ids.length) {
    throw new TypeError('The US-008 control catalog artifact contains duplicate controlId values');
  }
  return freeze(controls);
}

// The imported US-008 artifact is the sole source of records and identities for this adapter.
const canonicalControls = parseProviderArtifact(controlsArtifact);
const canonicalById = new Map(canonicalControls.map((control) => [control.controlId, control]));

/** Resolve one exact US-001 control identity from the canonical US-008 artifact. */
export function resolveAssuranceControl(controlId: string): Readonly<ControlRecord> {
  const control = canonicalById.get(controlId);
  if (!control) throw new TypeError(`Unknown US-001 controlId: ${controlId}`);
  return control;
}

/** Resolve compilation control identities without defining an assurance-owned reference shape. */
export function resolveAssuranceControls(controlIds: readonly string[]): readonly Readonly<ControlRecord>[] {
  return freeze(controlIds.map(resolveAssuranceControl));
}

/**
 * Validate record-shaped AAV compiler input with US-001, then require every record to match
 * the corresponding canonical US-008 provider record. The canonical records are returned.
 */
export function validateAssuranceCompilationInput(input: unknown): readonly Readonly<ControlRecord>[] {
  const supplied = parseProviderArtifact(input);
  return freeze(supplied.map((record) => {
    const canonical = resolveAssuranceControl(record.controlId);
    if (!isDeepStrictEqual(record, canonical)) {
      throw new TypeError(`US-008 provider record mismatch for controlId: ${record.controlId}`);
    }
    return canonical;
  }));
}
