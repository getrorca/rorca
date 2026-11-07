/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
const json = (relativePath) => JSON.parse(read(relativePath));

const packageFiles = [
  'package.json',
  'backend/package.json',
  'packages/rorca-capture/package.json',
  'packages/rorca-cli/package.json',
  'packages/rorca-pi-extension/package.json',
  'packages/rorca-public-contract/package.json',
];
const SCRIPT_TARGET_PATTERN = /(?:^|\s)((?:(?:\.\.\/)+)?(?:backend\/|packages\/|scripts\/|src\/|test\/|tests\/|bin\/|forge\/|extensions\/)[A-Za-z0-9_./*-]+\.(?:json|mjs|cjs|tsx|js|ts))(?=$|[\s"';&|])/g;

function assertScriptTargetsExist(packageFile, scripts) {
  const packageDirectory = path.dirname(path.join(repositoryRoot, packageFile));
  const targetPattern = SCRIPT_TARGET_PATTERN;
  for (const [name, command] of Object.entries(scripts)) {
    let commandDirectory = packageDirectory;
    for (const segment of command.split(/\s*&&\s*/)) {
      const directoryChange = segment.trim().match(/^cd\s+([^\s]+)$/);
      if (directoryChange) {
        commandDirectory = path.resolve(commandDirectory, directoryChange[1]);
        continue;
      }
      const explicitRoot = segment.match(/(?:^|\s)--root\s+([^\s]+)/);
      const targetDirectory = explicitRoot
        ? path.resolve(commandDirectory, explicitRoot[1])
        : commandDirectory;
      for (const match of segment.matchAll(targetPattern)) {
        const target = match[1];
        const absoluteTarget = path.resolve(targetDirectory, target);
        if (!target.includes('*')) {
          assert.ok(existsSync(absoluteTarget), `${packageFile} script ${name} references missing ${target}`);
          continue;
        }
        const directory = path.dirname(absoluteTarget);
        const suffix = path.basename(target).replace('*', '');
        assert.ok(
          existsSync(directory) && readdirSync(directory).some((entry) => entry.endsWith(suffix)),
          `${packageFile} script ${name} wildcard resolves no files: ${target}`,
        );
      }
    }
  }
}

test('every package script with a repository file target resolves it', () => {
  for (const packageFile of packageFiles) {
    assertScriptTargetsExist(packageFile, json(packageFile).scripts ?? {});
  }
  assert.equal(json('package.json').scripts['auth:test'], undefined, 'dead auth:test advertisement must stay removed');
});
test('script target parsing preserves the complete .json extension', () => {
  const command = 'npx tsc -p packages/rorca-capture/tsconfig.json --noEmit';
  const targets = [...command.matchAll(SCRIPT_TARGET_PATTERN)].map((match) => match[1]);
  assert.deepEqual(targets, ['packages/rorca-capture/tsconfig.json']);
});

test('CI has required PR and main gates for every formerly dead corpus', () => {
  const workflow = read('.forgejo/workflows/ci.yml');
  assert.match(workflow, /push:\s*\n\s*branches: \[main\]/);
  assert.match(workflow, /pull_request:\s*\n\s*branches: \[main\]/);
  for (const job of [
    'canonical-typecheck',
    'backend-tests',
    'golden-tests',
    'pg-boss-integration',
    'populated-upgrade',
    'canonical-gate-tests',
    'workspace-tests',
    'public-contract-tests',
    'wave-qualification',
    'top-level-e2e',
  ]) {
    assert.match(workflow, new RegExp(`^  ${job}:$`, 'm'), `missing mandatory CI job ${job}`);
  }
  assert.match(workflow, /run: npm run test:wave-qualification\s*$/m);
  assert.match(workflow, /run: npm run qualify:wave:ci\s*$/m);
  assert.match(workflow, /run: cd backend && npm test\s*$/m, 'backend gate must run the complete corpus');
  assert.doesNotMatch(workflow, /Backend PR-critical tests|context-pipeline-e2e\.test\.ts/);
});

test('golden, pg-boss, and Playwright harnesses cannot bypass owned dependencies', () => {
  const golden = read('backend/scripts/run-golden-tests.js');
  assert.match(golden, /run-isolated-jest\.ts/);
  assert.doesNotMatch(golden, /node_modules\/.bin\/jest/);

  const pgBoss = read('backend/jest.pg-boss.config.ts');
  for (const suite of ['cancel', 'concurrency', 'dlq', 'integration', 'load', 'restart', 'scheduler', 'zero-downtime']) {
    assert.match(pgBoss, new RegExp(`pg-boss-${suite}\\.test\\.ts`));
  }

  const playwright = read('playwright.config.ts');
  assert.match(playwright, /testDir: '\.'/);
  assert.match(playwright, /tests\/\*\*\/\*\.spec\.ts/);
  assert.match(playwright, /e2e\/\*\*\/\*\.spec\.ts/);
  assert.match(playwright, /e2e\/\*\*\/\*\.test\.ts/);
  assert.match(playwright, /testIgnore: \['test\/e2e\/first-run\.test\.ts'\]/);
  const playwrightFixture = read('scripts/setup-playwright-fixture.mjs');
  assert.match(playwrightFixture, /\/api\/auth\/csrf-token/);
  assert.match(playwrightFixture, /'x-csrf-token': csrfToken/);
  assert.match(playwrightFixture, /cookie: `_csrf=\$\{csrfToken\}`/);

  const workflow = read('.forgejo/workflows/ci.yml');
  const contractWorkflow = read('.forgejo/workflows/contract-check.yml');
  const smokeWorkflow = read('.forgejo/workflows/smoke-test.yml');
  // No database credential may be committed: the bootstrap password comes from
  // the CI secret, and the split-principal role passwords are generated per run.
  assert.match(workflow, /POSTGRES_PASSWORD: \$\{\{ secrets\.CI_POSTGRES_PASSWORD \}\}/);
  assert.match(workflow, /Generate ephemeral database credentials/);
  assert.doesNotMatch(
    workflow,
    /postgres:\/\/[A-Za-z0-9_.-]+:[^@\s$]+@/,
    'CI workflows must not embed an inline database password',
  );
  assert.match(workflow, /RORCA_API_URL: http:\/\/127\.0\.0\.1:3030/, 'capture tests must satisfy the explicit CI endpoint contract');
  assert.match(workflow, /options: --init/, 'process lifecycle qualification requires a PID 1 that reaps orphans');
  assert.match(workflow, /--cap-drop ALL[\s\S]*--cap-add SYS_ADMIN[\s\S]*--security-opt systempaths=unconfined/);
  for (const databaseWorkflow of [workflow, contractWorkflow]) {
    assert.match(databaseWorkflow, /docker\/postgres\/bootstrap-roles\.sh/);
    assert.match(databaseWorkflow, /CREATE EXTENSION IF NOT EXISTS vector/);
    assert.doesNotMatch(databaseWorkflow, /-\s+5432:5432/, 'self-hosted CI must not reserve a shared host PostgreSQL port');
  }
  assert.doesNotMatch(smokeWorkflow, /bun-version: latest/, 'CI toolchains must not depend on unauthenticated latest-release discovery');
  assert.equal([...smokeWorkflow.matchAll(/bun-version: 1\.3\.9/g)].length, 2);
});

test('contract freshness runs for pull requests and main pushes', () => {
  const workflow = read('.forgejo/workflows/contract-check.yml');
  assert.match(workflow, /push:\s*\n\s*branches: \[main\]/);
  assert.match(workflow, /pull_request:\s*\n\s*branches: \[main\]/);
  assert.match(workflow, /npm run build:contract/);
  assert.match(workflow, /git diff --exit-code/);
});

test('CI workflows never reuse a role name as that role password', () => {
  const relativeDir = '.forgejo/workflows';
  const roleAsPassword = /postgres:\/\/rorca_([a-z_]+):rorca_\1@/;
  const workflowDir = path.join(repositoryRoot, relativeDir);
  for (const file of readdirSync(workflowDir)) {
    if (!file.endsWith('.yml')) continue;
    const text = read(path.join(relativeDir, file));
    assert.doesNotMatch(
      text,
      roleAsPassword,
      path.join(relativeDir, file) + ' reuses a role name as its password; use a distinct CI-only value '
        + 'so a published workflow cannot hand out a live credential',
    );
  }
});
