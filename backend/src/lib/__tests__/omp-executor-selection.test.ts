/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { isOmpSandboxQualified, qualifiedDefaultExecutor } from '../omp-executor-selection';

const available = (version = '17.1.0') => () => ({
  ompInstalled: true,
  ompVersion: version,
  ompBinPath: '/qualified/omp',
});

describe('MIG-001 qualified OMP default', () => {
  test('requires both the deployment qualification marker and a qualified binary', () => {
    expect(isOmpSandboxQualified({ RORCA_OMP_SANDBOX_QUALIFIED: 'true' }, available())).toBe(true);
    expect(isOmpSandboxQualified({}, available())).toBe(false);
    expect(isOmpSandboxQualified({ RORCA_OMP_SANDBOX_QUALIFIED: 'true' }, available('16.9.0'))).toBe(false);
    expect(isOmpSandboxQualified({ RORCA_OMP_SANDBOX_QUALIFIED: 'true' }, () => ({ ompInstalled: false, ompVersion: null, ompBinPath: null }))).toBe(false);
  });

  test('defaults only qualified runs to OMP and otherwise retains the configured fallback', () => {
    expect(qualifiedDefaultExecutor('claude', true)).toBe('omp');
    expect(qualifiedDefaultExecutor('pi', false)).toBe('claude');
    expect(qualifiedDefaultExecutor('omp', false)).toBe('claude');
  });
});
