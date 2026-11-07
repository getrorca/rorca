/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { ensureMcpToken } from '../../lib/mcp-auth';

const tempPiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pi-auth-route-'));
const originalNodeEnv = process.env.NODE_ENV;
const originalPiDir = process.env.PI_CODING_AGENT_DIR;
const originalHome = process.env.HOME;
const originalOperatorCapability = process.env.RORCA_OPERATOR_CAPABILITY_SHA256;
process.env.NODE_ENV = 'test';
process.env.PI_CODING_AGENT_DIR = tempPiDir;
process.env.HOME = tempPiDir;
ensureMcpToken();
const operatorCapability = 'pi-auth-test-operator';
process.env.RORCA_OPERATOR_CAPABILITY_SHA256 = createHash('sha256').update(operatorCapability).digest('hex');

const app = require('../../server').default;

describe('mounted Pi provider authentication surface', () => {
  afterAll(() => {
    fs.rmSync(tempPiDir, { recursive: true, force: true });
    if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiDir;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOperatorCapability === undefined) delete process.env.RORCA_OPERATOR_CAPABILITY_SHA256;
    else process.env.RORCA_OPERATOR_CAPABILITY_SHA256 = originalOperatorCapability;
  });

  test('serves the documented provider list at the production mount path', async () => {
    const response = await request(app)
      .get('/api/pi/auth/providers')
      .set('x-rorca-operator-capability', operatorCapability);

    expect(response.status).toBe(200);
    expect(response.body.authFilePath).toBe(path.join(tempPiDir, 'auth.json'));
    expect(response.body.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'anthropic' }),
      expect.objectContaining({ id: 'openai' }),
      expect.objectContaining({ id: 'openrouter' }),
    ]));
  });

  test('denies an ordinary authenticated bearer access to host-wide credentials', async () => {
    const token = await getAuthToken(undefined, {
      email: 'pi-auth-non-operator@example.test',
      role: 'user',
    });
    const response = await request(app)
      .put('/api/pi/auth/providers/openai')
      .set('Authorization', `Bearer ${token}`)
      .send({ apiKey: 'must-not-write' });
    expect(response.status).toBe(403);
    expect(fs.existsSync(path.join(tempPiDir, 'auth.json'))).toBe(false);
  });
});
