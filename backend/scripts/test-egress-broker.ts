/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { ensureAutonomousModelEgress, closeAutonomousModelEgressForTests } from '../src/lib/autonomous-model-egress';

async function main(): Promise<void> {
  process.env.RORCA_AUTONOMOUS_EGRESS_RUN_ID = '999999';
  process.env.RORCA_AUTONOMOUS_EGRESS_AUTHORITY_HASH = `sha256:${'a'.repeat(64)}`;
  try {
    const sock = await ensureAutonomousModelEgress(process.env, 'darwin-local-pi');
    console.log('SOCKET OK:', sock);
    console.log('path len:', sock.length);
    await closeAutonomousModelEgressForTests();
    console.log('PASS');
  } catch (e) {
    console.log('ERR:', e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}

void main();
