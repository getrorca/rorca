import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  // chokidar v5 is ESM-only; replace it with an auto-mock for all tests
  moduleNameMapper: {
    '^chokidar$': '<rootDir>/src/__mocks__/chokidar.js',
  },
};

export default config;
