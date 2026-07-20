#!/usr/bin/env node
// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN_ID_PATTERN = /^qrun_[a-f0-9]{24}$/;
const PRODUCTION_LIKE_IDENTITY = /(?:^|[._-])(?:prod(?:uction)?|live|primary|mainline)(?:[._-]|$)/i;
const SAFE_ENV_KEYS = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'CI'];

function fail(message) {
  throw new Error(`[wave-qualification-launcher] ${message}`);
}

function strictlyContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function buildQualificationChildEnv(source, scenarioPath) {
  const runId = source.RORCA_QUALIFICATION_RUN_ID ?? '';
  const databaseUrl = source.RORCA_QUALIFICATION_DATABASE_URL ?? '';
  const marker = source.RORCA_QUALIFICATION_ISOLATION_MARKER ?? '';
  if (!RUN_ID_PATTERN.test(runId)) fail('missing unpredictable qualification run ID');
  if (marker !== `rorca-qualification-owned:${runId}`) fail('missing exact per-run isolation marker');

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    fail('qualification database URL is invalid');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) fail('qualification database URL must use PostgreSQL');
  const token = runId.slice('qrun_'.length);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const role = decodeURIComponent(parsed.username);
  if (database !== `rorca_qtest_${token}_test` || role !== `rorca_qrole_${token}` || !parsed.password) {
    fail('qualification database and role must exactly match the run namespace');
  }
  if (parsed.searchParams.get('application_name') !== `rorca-qualification:${runId}`) {
    fail('qualification application_name does not match the run namespace');
  }
  for (const [label, value] of [['host', parsed.hostname], ['database', database], ['role', role]]) {
    if (PRODUCTION_LIKE_IDENTITY.test(value)) fail(`${label} contains a production-like identity`);
  }

  const result = {
    NODE_ENV: 'test',
    RORCA_QUALIFICATION_RUN_ID: runId,
    RORCA_QUALIFICATION_ISOLATION_MARKER: marker,
    RORCA_QUALIFICATION_DATABASE_URL: databaseUrl,
    RORCA_QUALIFICATION_SCENARIO: scenarioPath,
  };
  for (const key of SAFE_ENV_KEYS) {
    if (source[key]) result[key] = source[key];
  }
  return result;
}

export function resolveQualificationScenario(workspaceRoot, requestedPath) {
  if (!requestedPath) fail('usage: run-wave-qualification.mjs <repo-relative-scenario-module>');
  const root = fs.realpathSync(workspaceRoot);
  const requested = path.resolve(root, requestedPath);
  const scenario = fs.realpathSync(requested);
  if (!strictlyContained(root, scenario)) fail('scenario module must be contained by this checkout');
  if (!fs.statSync(scenario).isFile()) fail('scenario module must be a regular file');
  return scenario;
}

export async function launchQualification({ workspaceRoot, scenarioPath, sourceEnv = process.env }) {
  const root = fs.realpathSync(workspaceRoot);
  const scenario = resolveQualificationScenario(root, scenarioPath);
  const childEnv = buildQualificationChildEnv(sourceEnv, scenario);
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const tsx = fs.realpathSync(path.join(scriptDirectory, '..', 'backend', 'node_modules', '.bin', 'tsx'));
  const runner = fs.realpathSync(path.join(scriptDirectory, '..', 'backend', 'src', 'scripts', 'wave-qualification-runner.ts'));

  return await new Promise((resolve, reject) => {
    const child = spawn(tsx, [runner], {
      cwd: root,
      env: childEnv,
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error('[wave-qualification-launcher] qualification child terminated by signal'));
      else resolve(code ?? 1);
    });
  });
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const exitCode = await launchQualification({
      workspaceRoot: process.cwd(),
      scenarioPath: process.argv[2],
    });
    process.exitCode = exitCode;
  } catch {
    console.error('[wave-qualification-launcher] failed closed before qualification launch');
    process.exitCode = 1;
  }
}
