/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as net from 'node:net';
import {
  closeAutonomousModelEgressForTests,
  ensureAutonomousModelEgress,
} from '../autonomous-model-egress';

async function request(socketPath: string, authority: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    let output = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.on('data', chunk => { output += chunk; });
    socket.on('end', () => resolve(output));
    socket.on('error', reject);
  });
}

afterEach(async () => {
  await closeAutonomousModelEgressForTests();
});

test('non-isolated local development starts no trusted model egress broker', async () => {
  await expect(ensureAutonomousModelEgress({
    NODE_ENV: 'development', RORCA_AUTONOMOUS_ISOLATION: 'local-dev',
  })).resolves.toBeNull();
});

test.each(['', 'localhost', '127.0.0.1', '*.example.com', 'not-a-host', 'api.github.com']) (
  'isolated broker rejects missing/non-exact/public host configuration %p',
  async (host) => {
    await expect(ensureAutonomousModelEgress({
      NODE_ENV: 'production',
      RORCA_AUTONOMOUS_ISOLATION: 'linux-bwrap',
      RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS: host,
    })).rejects.toThrow(/required|exact public DNS name/);
  },
);

test('broker denies GitHub, localhost, IP literals, non-443 ports, and non-CONNECT without external calls', async () => {
  const socket = await ensureAutonomousModelEgress({
    NODE_ENV: 'production',
    RORCA_AUTONOMOUS_ISOLATION: 'linux-bwrap',
    RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS: 'model-api.example.invalid',
  });
  expect(socket).toBeTruthy();
  for (const authority of ['api.github.com:443', 'localhost:3030', '127.0.0.1:5432', 'model-api.example.invalid:80']) {
    await expect(request(socket!, authority)).resolves.toContain('403 Forbidden');
  }
  const nonConnect = await new Promise<string>((resolve, reject) => {
    const client = net.connect({ path: socket! });
    let output = '';
    client.setEncoding('utf8');
    client.on('connect', () => client.write('GET http://model-api.example.invalid/ HTTP/1.1\r\n\r\n'));
    client.on('data', chunk => { output += chunk; });
    client.on('end', () => resolve(output));
    client.on('error', reject);
  });
  expect(nonConnect).toContain('405 Method Not Allowed');
});
