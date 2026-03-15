/**
 * jest.pool-cleanup.ts — Global afterEach pool cleanup
 *
 * Prevents PostgreSQL connection exhaustion when test files use
 * jest.resetModules() + require('../../server') in beforeEach.
 *
 * Each jest.resetModules() + require('../../server') creates a fresh
 * pg Pool. Without closing it in afterEach, N tests = N open connections.
 * With PG_POOL_SIZE=1 and 748+ tests across 54 test files, we'd exceed
 * PostgreSQL's default max_connections=100 long before the suite completes.
 *
 * This global afterEach calls closePool() on the currently cached db/index
 * module (the one freshly loaded by the last require('../../server') call)
 * so connections are released before the next test's beforeEach opens a new one.
 */

afterEach(async () => {
  try {
    // require() returns the currently cached db/index module, which holds
    // the pool created by the most recent jest.resetModules() + require('../../server').
    // Calling closePool() ends all its connections before the next test creates a new one.
    const dbMod = require('./src/db/index');
    if (typeof dbMod.closePool === 'function') {
      await dbMod.closePool();
    }
  } catch {
    // Pool may already be closed, not initialized, or module may not be cached — ignore.
  }
});
