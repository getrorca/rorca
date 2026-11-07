#!/usr/bin/env node
/**
 * Production wrapper for the macOS Always-On reboot/login smoke.
 *
 * DANGER: the reboot-now action can invoke a real privileged shutdown command.
 * Tests import the library with an explicit mocked runtime instead of invoking
 * this production wrapper.
 */
import { fileURLToPath } from 'node:url';
import { createProductionRuntime, execute } from './always-on-reboot-smoke-lib.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const runtime = createProductionRuntime(scriptPath);

execute(process.argv.slice(2), runtime)
  .then((result) => {
    if (Number.isInteger(result?.exitCode)) process.exitCode = result.exitCode;
  })
  .catch((error) => {
    console.error(`[rorca-reboot-smoke] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
