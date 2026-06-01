/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockIsGraphAvailable = jest.fn();
const mockResetGraphAvailability = jest.fn();

jest.mock('../knowledge-graph', () => ({
  isGraphAvailable: (...args: unknown[]) => mockIsGraphAvailable(...args),
  resetGraphAvailability: (...args: unknown[]) => mockResetGraphAvailability(...args),
}));

describe('age-guard', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('checkAge delegates to the canonical graph availability check', async () => {
    mockIsGraphAvailable.mockResolvedValue(true);
    const { checkAge } = require('../age-guard');

    await expect(checkAge()).resolves.toBe(true);
    expect(mockIsGraphAvailable).toHaveBeenCalledTimes(1);
  });

  test('invalidateAgeCache resets the canonical graph availability cache', () => {
    const { invalidateAgeCache } = require('../age-guard');

    invalidateAgeCache();
    expect(mockResetGraphAvailability).toHaveBeenCalledTimes(1);
  });
});

export {};
