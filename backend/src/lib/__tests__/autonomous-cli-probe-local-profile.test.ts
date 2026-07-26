/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { probeAutonomousCliSync } from '../autonomous-cli-probe';
import { RorcaExecutionSandboxError } from '../ordinary-local-pi-profile';

const originalPiBin = process.env.PI_BIN;

afterEach(() => {
  if (originalPiBin === undefined) delete process.env.PI_BIN;
  else process.env.PI_BIN = originalPiBin;
});

test('Darwin local discovery refuses arbitrary commands rather than becoming a generic local shell', () => {
  process.env.PI_BIN = process.execPath;
  const result = probeAutonomousCliSync(process.execPath, ['--help'], {
    sandboxMode: 'darwin-local-pi',
  });

  expect(result.status).toBeNull();
  expect(result.error).toBeInstanceOf(RorcaExecutionSandboxError);
  expect((result.error as RorcaExecutionSandboxError).code).toBe('unsupported_sandbox_mode');
});
