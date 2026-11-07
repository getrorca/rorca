/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryRoot = path.resolve(packageRoot, '../..');
const schemaDirectory = path.join(packageRoot, 'schemas/governed-execution');
const digest = (bytes: string | Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`).join(',')}}`;
  return JSON.stringify(value);
};
const completionContracts: Record<string, true> = {
  'completion-obligation-set': true,
  'attempt-task-plan': true,
  'completion-result-proposal': true,
  'completion-gate-decision': true,
  'completion-continuation-directive': true,
  'completion-progress-entry': true,
  'completion-final-report': true,
};
const wave3StreamContracts: Record<string, true> = {
  'run-stream-envelope': true,
  'runtime-neutral-observation': true,
  'runtime-telemetry-batch': true,
};
const semanticValidator = {
  classification: 'structural-only',
  genericJsonSchemaIsAuthoritative: false,
  required: true,
  package: '@rorca/public-contract',
  export: 'parseGovernedExecutionContract',
};

test('published manifest and JSON projections require the package semantic validator', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(schemaDirectory, 'manifest.json'), 'utf8')) as {
    schemaVersion: string;
    deterministic: boolean;
    sourceDigest: string;
    jsonSchema: { authority: string; semanticRefinementsEnforced: boolean };
    semanticValidator: typeof semanticValidator & {
      source: string;
      publishedSource: string;
      sourceSha256: string;
    };
    sourceClosure: {
      classification: string;
      description: string;
      compiledOutputBound: boolean;
      digestAlgorithm: string;
      digest: string;
      files: Array<{ source: string; publishedFile: string; sha256: string }>;
    };
    contracts: Array<{ contract: string; file: string; sha256: string }>;
  };

  assert.equal(manifest.schemaVersion, 'rorca.governed-contract-schema-manifest.v2');
  assert.equal(manifest.deterministic, true);
  assert.deepEqual(manifest.jsonSchema, {
    authority: 'structural-only',
    semanticRefinementsEnforced: false,
  });
  assert.deepEqual(
    Object.fromEntries(Object.entries(manifest.semanticValidator).filter(
      ([key]) => !['source', 'publishedSource', 'sourceSha256'].includes(key),
    )),
    semanticValidator,
  );

  assert.equal(manifest.sourceClosure.classification, 'published-auditable-source-closure');
  assert.equal(manifest.sourceClosure.compiledOutputBound, false);
  assert.match(manifest.sourceClosure.description, /does not bind or attest.*compiled JavaScript output/i);
  assert.equal(
    manifest.sourceClosure.digestAlgorithm,
    'sha256 of stable JSON source-closure files array followed by LF',
  );
  assert.equal(
    manifest.sourceClosure.digest,
    `sha256:${digest(`${stable(manifest.sourceClosure.files)}\n`)}`,
  );
  assert.equal(manifest.sourceDigest, manifest.sourceClosure.digest);

  const governedSourceDirectory = path.join(repositoryRoot, 'backend/src/lib/governed-contracts');
  const expectedSources = [
    ...fs.readdirSync(governedSourceDirectory)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => path.posix.join('backend/src/lib/governed-contracts', file)),
    'packages/rorca-public-contract/src/governed-execution.ts',
  ].sort();
  assert.deepEqual(manifest.sourceClosure.files.map(({ source }) => source), expectedSources);
  assert.equal(
    new Set(manifest.sourceClosure.files.map(({ publishedFile }) => publishedFile)).size,
    manifest.sourceClosure.files.length,
  );

  for (const source of manifest.sourceClosure.files) {
    assert.equal(path.isAbsolute(source.source), false);
    assert.equal(source.source.split('/').includes('..'), false);
    const originalBytes = fs.readFileSync(path.join(repositoryRoot, source.source));
    const publishedBytes = fs.readFileSync(path.join(schemaDirectory, source.publishedFile));
    assert.deepEqual(publishedBytes, originalBytes, `${source.publishedFile} does not snapshot ${source.source}`);
    assert.equal(source.sha256, `sha256:${digest(publishedBytes)}`, `${source.publishedFile} digest drifted`);
  }
  assert.deepEqual(
    fs.readdirSync(schemaDirectory)
      .filter((file) => file.startsWith('source-closure-') && file.endsWith('.txt'))
      .sort(),
    manifest.sourceClosure.files.map(({ publishedFile }) => publishedFile).sort(),
    'published directory contains an unlisted stale source snapshot',
  );

  const validatorEntry = manifest.sourceClosure.files.find(
    ({ source }) => source === manifest.semanticValidator.source,
  );
  assert.ok(validatorEntry);
  assert.equal(manifest.semanticValidator.publishedSource, validatorEntry.publishedFile);
  assert.equal(manifest.semanticValidator.sourceSha256, validatorEntry.sha256);

  const publishedCompletionContracts = manifest.contracts
    .filter(({ contract }) => Object.hasOwn(completionContracts, contract))
    .map(({ contract }) => contract)
    .sort();
  assert.deepEqual(publishedCompletionContracts, Object.keys(completionContracts).sort());
  const publishedWave3Contracts = manifest.contracts
    .filter(({ contract }) => Object.hasOwn(wave3StreamContracts, contract))
    .map(({ contract }) => contract)
    .sort();
  assert.deepEqual(publishedWave3Contracts, Object.keys(wave3StreamContracts).sort());

  for (const artifact of manifest.contracts) {
    const bytes = fs.readFileSync(path.join(schemaDirectory, artifact.file));
    assert.equal(digest(bytes), artifact.sha256, `${artifact.file} manifest digest drifted`);
    const schema = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    assert.match(String(schema.$comment), /Structural projection only/);
    assert.deepEqual(schema['x-rorca-semantic-validation'], semanticValidator);
  }
});

test('npm package files include every manifest-listed source snapshot', () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const reports = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
  assert.equal(reports.length, 1);
  const packedFiles = new Set(reports[0].files.map(({ path: packedPath }) => packedPath));
  const manifest = JSON.parse(fs.readFileSync(path.join(schemaDirectory, 'manifest.json'), 'utf8')) as {
    sourceClosure: { files: Array<{ publishedFile: string }> };
  };
  for (const { publishedFile } of manifest.sourceClosure.files) {
    assert.equal(
      packedFiles.has(path.posix.join('schemas/governed-execution', publishedFile)),
      true,
      `${publishedFile} is absent from npm package files`,
    );
  }
});
