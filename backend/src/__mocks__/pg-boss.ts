/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// Mock for pg-boss — prevents real DB connections in unit tests.
// pg-boss integration tests that need the real implementation are excluded
// via testPathIgnorePatterns in jest.config.ts.

const mockBoss = {
  on: jest.fn().mockReturnThis(),
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  send: jest.fn().mockResolvedValue('mock-job-id'),
  cancel: jest.fn().mockResolvedValue(undefined),
  work: jest.fn().mockResolvedValue(undefined),
  createQueue: jest.fn().mockResolvedValue(undefined),
  getJobById: jest.fn().mockResolvedValue(null),
  fetch: jest.fn().mockResolvedValue(null),
  complete: jest.fn().mockResolvedValue(undefined),
  fail: jest.fn().mockResolvedValue(undefined),
};

const PgBoss = jest.fn().mockImplementation(() => mockBoss);

export default PgBoss;
module.exports = PgBoss;
module.exports.default = PgBoss;
