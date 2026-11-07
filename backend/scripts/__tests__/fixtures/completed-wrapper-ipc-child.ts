/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { runJestInvocation } from '../../lib/complete-jest-orchestrator';

// Reproduce the handle that retained completed shard wrappers in production.
process.on('message', () => {});

void runJestInvocation(['--shard=1/8'], {
  complete() {
    throw new Error('unexpected complete route');
  },
  focused() {
    return 0;
  },
}).then(() => {
  // Always release a regressed channel so the parent test cannot hang. The
  // sentinel exit makes the retained-handle regression observable instead.
  if (process.connected) {
    process.exitCode = 97;
    process.disconnect();
  }
}, (error) => {
  console.error(error);
  process.exitCode = 98;
  if (process.connected) process.disconnect();
});
