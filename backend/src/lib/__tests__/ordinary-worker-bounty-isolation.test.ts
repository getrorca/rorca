/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'fs';
import path from 'path';

describe('ordinary worker bounty isolation', () => {
  test('ordinary pipeline startup does not resolve or register bounty effects', () => {
    const workerSource = fs.readFileSync(path.join(__dirname, '../../worker.ts'), 'utf8');

    expect(workerSource).not.toContain('registerBountyEffectWorkers');
    expect(workerSource).not.toContain('resolveBountyFeaturePolicy');
    expect(workerSource).not.toMatch(/boss\.work\(['"]bounty:/);
  });
});
