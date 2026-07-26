/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(path.resolve(__dirname, '..', 'pg-boss.ts'), 'utf8');
const worker = fs.readFileSync(path.resolve(__dirname, '..', '..', 'worker.ts'), 'utf8');

test('every fixed worker schedule has an idempotently created pg-boss queue', () => {
  for (const queue of ['queue-snapshot-prune', 'integration:health-check']) {
    expect(worker).toContain(`boss.schedule('${queue}'`);
    expect(source).toContain(`boss.createQueue('${queue}'`);
  }
});
