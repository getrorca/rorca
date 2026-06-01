#!/usr/bin/env node

const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const updateGolden = args.includes('--update-golden');
const forwardedArgs = args.filter((arg) => arg !== '--update-golden');
const env = { ...process.env };

if (updateGolden) {
  env.RORCA_UPDATE_GOLDEN = '1';
}

const result = spawnSync(
  process.execPath,
  ['node_modules/.bin/jest', '--testPathPattern=golden', ...forwardedArgs],
  {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  },
);

process.exit(result.status ?? 1);
