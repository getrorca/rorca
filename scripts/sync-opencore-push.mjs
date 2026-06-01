#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawnSync } from 'node:child_process';

function usage() {
  return [
    'Usage: node scripts/sync-opencore-push.mjs [--base <git-ref>] [--head <git-ref>] [--opencore <path>] [--allow-review] [--dry-run-only] [--yes] [--allow-dirty-source]',
    '',
    'Flow:',
    '  1. Run OSS export preflight in this repo',
    '  2. Run OpenCore import dry-run in ../rorca-opencore',
    '  3. Ask for confirmation',
    '  4. Apply the cherry-pick into OpenCore',
    '',
    'Examples:',
    '  npm run sync:push',
    '  npm run sync:push -- --base HEAD~2 --head HEAD',
    '  npm run sync:push -- --allow-review --dry-run-only',
    '  npm run sync:push -- --yes',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    base: 'HEAD~1',
    head: 'HEAD',
    opencore: '../rorca-opencore',
    allowReview: false,
    dryRunOnly: false,
    yes: false,
    allowDirtySource: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--base':
        options.base = argv[++i];
        break;
      case '--head':
        options.head = argv[++i];
        break;
      case '--opencore':
        options.opencore = argv[++i];
        break;
      case '--allow-review':
        options.allowReview = true;
        break;
      case '--dry-run-only':
        options.dryRunOnly = true;
        break;
      case '--yes':
      case '-y':
        options.yes = true;
        break;
      case '--allow-dirty-source':
        options.allowDirtySource = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

async function confirm(prompt) {
  if (!input.isTTY || !output.isTTY) {
    return false;
  }
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function repoDirty(cwd) {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error) throw result.error;
  return (result.stdout || '').trim().length > 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }

  const sourceRepo = process.cwd();
  const opencoreRepo = path.resolve(sourceRepo, options.opencore);

  if (repoDirty(sourceRepo) && !options.allowDirtySource) {
    throw new Error('Source repo has uncommitted changes. sync:push only operates on committed ranges. Commit first or pass --allow-dirty-source if you intentionally want to sync an older committed range.');
  }

  if (!fs.existsSync(path.join(opencoreRepo, '.git'))) {
    throw new Error(`OpenCore repo not found at ${opencoreRepo}`);
  }
  if (!fs.existsSync(path.join(opencoreRepo, 'package.json'))) {
    throw new Error(`OpenCore package.json not found at ${opencoreRepo}`);
  }

  const splitArgs = ['run', 'split:check', '--', '--base', options.base, '--head', options.head];
  if (options.allowReview) splitArgs.push('--allow-review');

  console.log('==> Step 1/3: OSS export preflight');
  const splitStatus = runCommand('npm', splitArgs, sourceRepo);
  if (splitStatus !== 0) {
    process.exit(splitStatus);
  }

  const dryRunArgs = [
    'run',
    'sync:oss',
    '--',
    '--source',
    sourceRepo,
    '--range',
    `${options.base}..${options.head}`,
    '--dry-run',
  ];
  if (options.allowReview) dryRunArgs.push('--allow-review');

  console.log('\n==> Step 2/3: OpenCore dry-run import');
  const dryRunStatus = runCommand('npm', dryRunArgs, opencoreRepo);
  if (dryRunStatus !== 0) {
    process.exit(dryRunStatus);
  }

  if (options.dryRunOnly) {
    console.log('\nDry-run pipeline succeeded. No OpenCore commits were applied.');
    process.exit(0);
  }

  let shouldApply = options.yes;
  if (!shouldApply) {
    shouldApply = await confirm('\nApply these commits to OpenCore now? [y/N] ');
  }

  if (!shouldApply) {
    console.log('Aborted before apply. No OpenCore changes were made.');
    process.exit(0);
  }

  const applyArgs = [
    'run',
    'sync:oss',
    '--',
    '--source',
    sourceRepo,
    '--range',
    `${options.base}..${options.head}`,
  ];
  if (options.allowReview) applyArgs.push('--allow-review');

  console.log('\n==> Step 3/3: Apply import into OpenCore');
  const applyStatus = runCommand('npm', applyArgs, opencoreRepo);
  if (applyStatus !== 0) {
    process.exit(applyStatus);
  }

  console.log('\nOpenCore sync applied successfully.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
