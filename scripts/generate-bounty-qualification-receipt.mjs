#!/usr/bin/env node
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const planPath = 'config/bounty-qualification.v1.json';
const matrixPath = 'docs/security/hackbot/bounty-qualification-matrix.v1.json';
const evidencePath = 'tests/fixtures/bounty-qualification/evidence-results.v1.json';
const defaultOutput = 'tests/fixtures/bounty-qualification/qualification-receipt.v1.json';
const outputPath = resolve(root, process.argv[2] ?? defaultOutput);

const json = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const plan = json(planPath);
const matrix = json(matrixPath);
const evidence = json(evidencePath);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function walk(path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) throw new Error(`Qualification input does not exist: ${path}`);
  if (statSync(absolute).isFile()) return [relative(root, absolute)];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
    walk(relative(root, resolve(absolute, entry.name))),
  );
}

function group(label, paths) {
  const files = [...new Set(paths.flatMap(walk))].sort();
  if (files.length === 0) throw new Error(`Qualification input group is empty: ${label}`);
  return sha(canonical({ label, files: files.map((path) => ({ path, sha256: sha(readFileSync(resolve(root, path))) })) }));
}

const migrationFiles = readdirSync(resolve(root, 'backend/src/db/pg-migrations'))
  .filter((name) => name.includes('bounty') && name.endsWith('.sql'))
  .map((name) => `backend/src/db/pg-migrations/${name}`);
const brokerFiles = [
  'backend/src/lib/bounty-operation-ledger.ts', 'backend/src/lib/bounty-effect-boundary.ts',
  'backend/src/lib/bounty-credential-broker.ts', 'backend/src/lib/bounty-durable-credential-broker.ts',
  'backend/src/lib/bounty-callback-broker.ts', 'backend/src/lib/bounty-production-caido.ts',
  'backend/src/lib/bounty-production-services.ts',
];
const adapterFiles = [
  'backend/src/lib/bounty-caido-adapter.ts', 'backend/src/lib/bounty-evidence-gateway.ts',
  'backend/src/lib/bounty-production-caido.ts', 'backend/src/lib/bounty-production-services.ts',
  'backend/src/routes/bounty-credentials.ts',
];
const promptFiles = ['config/hackbot/skills'];
const routerFiles = [
  'backend/src/lib/bounty-work-package-router.ts', 'backend/src/lib/bounty-mission-orchestrator.ts',
  'backend/src/routes/bounty-work-packages.ts',
];
const oracleFiles = ['backend/src/lib/bounty-finding-validation.ts', 'backend/src/lib/bounty-finding-admission.ts'];
const runtimeFiles = [
  'backend/src/lib/bounty-isolated-runtime.ts', 'backend/src/lib/bounty-isolated-worker-lane.ts',
  'backend/src/lib/bounty-worker-boundary.ts', 'backend/src/bounty-worker.ts', 'Dockerfile.bounty-worker',
  'backend/src/lib/bounty-local-fixture-launch.ts', 'backend/src/lib/bounty-controller.ts', 'backend/src/routes/bounty.ts',
];
const policyFiles = [
  'backend/src/lib/bounty-feature-policy.ts', 'backend/src/lib/bounty-effect-policy.ts',
  'backend/src/lib/bounty-scope.ts', 'backend/src/lib/bounty-approvals.ts',
  'backend/src/lib/bounty-release-promotion.ts', 'backend/src/lib/bounty-promotion-store.ts',
];
const configFiles = [
  planPath, matrixPath, 'config/hackbot',
  'docs/security/hackbot/hackbot-requirements-trace.v1.json', 'docs/bounty-qualification-runbook.md',
  'scripts/generate-bounty-qualification-receipt.mjs', 'backend/src/lib/bounty-qualification.ts',
];
const presentationFiles = [
  'backend/src/lib/bounty-presentation-contract.ts', 'backend/src/routes/bounty-presentation.ts',
  'src/api/bountyMissionControl.ts', 'src/panels/MissionControlPanel.tsx',
];
const bountySourceFiles = [
  ...readdirSync(resolve(root, 'backend/src/lib')).filter((name) => /^bounty-.*\.ts$/.test(name)).map((name) => `backend/src/lib/${name}`),
  ...readdirSync(resolve(root, 'backend/src/routes')).filter((name) => /^bounty.*\.ts$/.test(name)).map((name) => `backend/src/routes/${name}`),
];
const qualificationTestFiles = [
  'backend/src/lib/__tests__', 'backend/src/routes/__tests__', 'backend/src/db/__tests__',
].flatMap((directory) => readdirSync(resolve(root, directory))
  .filter((name) => name.includes('bounty') && name.endsWith('.test.ts'))
  .map((name) => `${directory}/${name}`));
const sourceFiles = [
  ...bountySourceFiles, ...migrationFiles, ...promptFiles, ...configFiles, ...presentationFiles,
  ...qualificationTestFiles, 'src/api/__tests__/bountyMissionControl.test.ts',
  'src/panels/__tests__/MissionControlPanel.test.tsx', 'src/hackbot-governance-docs.test.ts',
  'scripts/__tests__/bounty-qualification.test.mjs', evidencePath,
];

let sourceSha = process.env.RORCA_BOUNTY_SOURCE_SHA?.trim();
if (!sourceSha) {
  // The checked-in disabled fixture is reproducible across the commit that stores
  // it. Production promotion always supplies RORCA_BOUNTY_SOURCE_SHA explicitly
  // and therefore binds the exact deployed HEAD instead of this fixture identity.
  const fixturePath = resolve(root, defaultOutput);
  sourceSha = existsSync(fixturePath)
    ? JSON.parse(readFileSync(fixturePath, 'utf8')).bindings.sourceSha
    : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
if (!/^[0-9a-f]{40,64}$/.test(sourceSha)) throw new Error('RORCA_BOUNTY_SOURCE_SHA must be a 40-64 character lowercase Git SHA');

const bindings = {
  sourceSha,
  sourceTreeHash: group('source-tree', sourceFiles),
  migrationHash: group('migrations', migrationFiles),
  configHash: group('configuration', configFiles),
  brokerHash: group('broker', brokerFiles),
  adapterHash: group('adapters', adapterFiles),
  promptHash: group('prompts', promptFiles),
  skillHash: group('skills', ['config/hackbot/hackbot-skill-manifest.v1.json', 'config/hackbot/skills']),
  routerHash: group('routers', routerFiles),
  oracleHash: group('oracles', oracleFiles),
  personaHash: group('personas', ['config/hackbot/hackbot-skill-manifest.v1.json']),
  modelHash: group('models', ['backend/src/lib/bounty-isolated-runtime.ts', 'backend/src/lib/bounty-session-audit.ts']),
  runtimeHash: group('runtime', runtimeFiles),
  policyHash: group('policy', policyFiles),
};
const evidenceRoot = sha(canonical({ suites: evidence.suites, controlProofs: evidence.controlProofs, metrics: evidence.metrics }));
bindings.evidenceRoot = evidenceRoot;
const requalificationFingerprint = sha(canonical({
  triggers: plan.requalificationTriggers,
  bindings,
  corpora: plan.corpora.map(({ id, manifestSha256 }) => ({ id, manifestSha256 })),
}));

const unsigned = {
  schemaVersion: 'bounty.qualification-receipt.v1',
  receiptId: sha(canonical({ candidateId: plan.candidateId, sourceSha, sourceTreeHash: bindings.sourceTreeHash })),
  candidateId: plan.candidateId,
  issuedAt: plan.frozenAt,
  immutable: true,
  qualificationMode: plan.qualificationMode,
  release: {
    qualifiedFixture: true,
    featureState: 'disabled',
    enableAvailable: false,
    disposition: matrix.releaseDisposition,
  },
  requalificationTriggers: plan.requalificationTriggers,
  requalificationFingerprint,
  bindings,
  corpora: plan.corpora.map(({ id, class: corpusClass, manifestSha256, itemCount, blinded, immutable, repositoryContentIncluded }) => ({
    id, class: corpusClass, manifestSha256, itemCount, blinded, immutable, repositoryContentIncluded,
  })),
  suiteEvidence: evidence.suites,
  controlProofs: evidence.controlProofs,
  metrics: evidence.metrics,
  traceabilityHash: group('qualification-matrix', [matrixPath]),
};
const receipt = { ...unsigned, receiptHash: sha(canonical(unsigned)) };
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'w' });
console.log(relative(root, outputPath));
