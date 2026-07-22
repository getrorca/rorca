/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const repositoryRoot = path.resolve(__dirname, '../../..');
const checkerSource = path.join(repositoryRoot, 'scripts', 'check-swagger-coverage.ts');
const tsxBinary = path.join(repositoryRoot, 'backend', 'node_modules', '.bin', 'tsx');

function runChecker(routeSource: string) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-swagger-parity-'));
  const scriptsDir = path.join(fixtureRoot, 'scripts');
  const routesDir = path.join(fixtureRoot, 'backend', 'src', 'routes');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(routesDir, { recursive: true });
  fs.copyFileSync(checkerSource, path.join(scriptsDir, 'check-swagger-coverage.ts'));
  fs.writeFileSync(path.join(routesDir, 'fixture.ts'), routeSource);
  fs.symlinkSync(path.join(repositoryRoot, 'backend', 'node_modules'), path.join(fixtureRoot, 'node_modules'), 'dir');

  try {
    return spawnSync(tsxBinary, [path.join(scriptsDir, 'check-swagger-coverage.ts')], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

const header = `import { Router } from 'express';\nconst router = Router();\n`;

test('Swagger parity fails closed on duplicate Express and OpenAPI method/path keys', () => {
  const duplicateOperation = `
/**
 * @swagger
 * /api/example:
 *   post:
 *     x-rorca-native-api: true
 *     responses:
 *       204: { description: ok }
 */
router.post('/example', (_req, res) => res.status(204).end());
`;
  const result = runChecker(`${header}${duplicateOperation}${duplicateOperation}\nexport default router;\n`);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/duplicate/i);
});

test('Swagger parity accepts every operation in a multi-method block and static route aliases', () => {
  const result = runChecker(`${header}
/**
 * @swagger
 * /api/example:
 *   get:
 *     x-rorca-native-api: true
 *     responses:
 *       204: { description: ok }
 *   post:
 *     x-rorca-native-api: true
 *     responses:
 *       204: { description: ok }
 */
router.get('/example', (_req, res) => res.status(204).end());
router.post('/example', (_req, res) => res.status(204).end());
/**
 * @swagger
 * /api/alias-a:
 *   get:
 *     x-rorca-native-api: true
 *     responses:
 *       204: { description: ok }
 */
/**
 * @swagger
 * /api/alias-b:
 *   get:
 *     x-rorca-native-api: true
 *     responses:
 *       204: { description: ok }
 */
router.get(['/alias-a', '/alias-b'], (_req, res) => res.status(204).end());
export default router;
`);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
});
