import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export default defineConfig({
  resolve: {
    alias: {
      '../../../../backend/src/lib/context-safety.js': path.join(root, 'backend/src/lib/context-safety.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/rorca-pi-extension/vscode-extension/__tests__/**/*.test.ts'],
    pool: 'forks',
    maxWorkers: 1,
  },
});
