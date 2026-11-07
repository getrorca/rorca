/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockGetDatabaseCapability = jest.fn();

jest.mock('../db-strategy', () => ({
  getDatabaseCapability: (...args: unknown[]) => mockGetDatabaseCapability(...args),
}));

describe('age-guard', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('checkAge delegates to the canonical database capability helper', async () => {
    mockGetDatabaseCapability.mockResolvedValue({
      extensions: { age: true, vector: true, pgcrypto: false },
      graphMode: 'full',
    });
    const { checkAge } = require('../age-guard');

    await expect(checkAge()).resolves.toBe(true);
    expect(mockGetDatabaseCapability).toHaveBeenCalledTimes(1);
  });

  test('invalidateAgeCache clears the cached capability probe', async () => {
    mockGetDatabaseCapability.mockResolvedValue({
      extensions: { age: false, vector: false, pgcrypto: false },
      graphMode: 'lite',
    });
    const { checkAge, invalidateAgeCache } = require('../age-guard');

    await expect(checkAge()).resolves.toBe(false);
    invalidateAgeCache();
    await expect(checkAge()).resolves.toBe(false);
    expect(mockGetDatabaseCapability).toHaveBeenCalledTimes(2);
  });
});

export {};
