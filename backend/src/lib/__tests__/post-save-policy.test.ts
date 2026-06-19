/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  POST_SAVE_POLICY_PRESET_IDS,
  resolvePostSavePolicy,
} from '../post-save-policy';
import { ValidationError } from '../errors';

describe('resolvePostSavePolicy', () => {
  test('normalizes omitted postSave to best_effort', () => {
    const resolved = resolvePostSavePolicy();

    expect(resolved.effectivePolicy).toMatchObject({
      version: 'v1',
      presetId: 'best_effort',
      context: 'capture',
      enrich: 'enqueue',
      skills: 'match',
      memory: 'synthesize',
      onFailure: 'continue',
    });
    expect(resolved.legacyOptions).toEqual({ enrich: true, matchSkills: true, memorySynthesis: true });
  });

  test('normalizes legacy postSave booleans', () => {
    expect(resolvePostSavePolicy(false).legacyOptions).toEqual({
      enrich: false,
      matchSkills: false,
      memorySynthesis: false,
    });

    expect(resolvePostSavePolicy({ enrich: false, matchSkills: true, memorySynthesis: false }).effectivePolicy).toMatchObject({
      presetId: 'best_effort',
      enrich: 'skip',
      skills: 'match',
      memory: 'skip',
    });
  });

  test('normalizes stable preset ids', () => {
    expect(POST_SAVE_POLICY_PRESET_IDS).toEqual([
      'fast_import',
      'best_effort',
      'skill_first_strict',
      'enterprise_governed',
      'repair_only',
    ]);

    const resolved = resolvePostSavePolicy('skill_first_strict');
    expect(resolved.effectivePolicy).toMatchObject({ presetId: 'skill_first_strict', onFailure: 'fail' });
    expect(resolved.legacyOptions).toEqual({ enrich: true, matchSkills: true, memorySynthesis: true });
  });

  test('normalizes explicit policy objects', () => {
    const resolved = resolvePostSavePolicy({
      version: 'v1',
      presetId: 'enterprise_governed',
      context: 'skip',
      enrich: 'skip',
      skills: 'match',
      memory: 'skip',
      onFailure: 'fail',
    });

    expect(resolved.effectivePolicy).toEqual({
      version: 'v1',
      presetId: 'enterprise_governed',
      context: 'skip',
      enrich: 'skip',
      skills: 'match',
      memory: 'skip',
      onFailure: 'fail',
    });
    expect(resolved.legacyOptions).toEqual({ enrich: false, matchSkills: true, memorySynthesis: false });
  });

  test('rejects invalid preset ids and enum values with ValidationError details', () => {
    expect(() => resolvePostSavePolicy('slow_and_loose')).toThrow(ValidationError);

    try {
      resolvePostSavePolicy({ presetId: 'best_effort', skills: 'maybe' });
      throw new Error('expected validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toMatchObject({
        field: 'postSave.skills',
        value: 'maybe',
        allowedValues: 'match,skip',
      });
    }
  });
});
