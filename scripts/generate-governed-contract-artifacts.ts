/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GOVERNED_CONTRACT_SCHEMAS, GOVERNED_CONTRACT_VERSION } from '../backend/src/lib/governed-contracts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'packages/rorca-public-contract/schemas/governed-execution');
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`).join(',')}}`;
  return JSON.stringify(value);
};
const sha = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const validatorSource = 'packages/rorca-public-contract/src/governed-execution.ts';
const semanticValidation = Object.freeze({
  classification: 'structural-only',
  genericJsonSchemaIsAuthoritative: false,
  required: true,
  package: '@rorca/public-contract',
  export: 'parseGovernedExecutionContract',
});
fs.mkdirSync(output, { recursive: true });
const manifest: Array<{ contract: string; file: string; sha256: string }> = [];
for (const [name, schema] of Object.entries(GOVERNED_CONTRACT_SCHEMAS).sort(([a], [b]) => a.localeCompare(b))) {
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' });
  const document = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $comment: 'Structural projection only. Generic JSON Schema validation does not enforce authority or cross-field correlation invariants. Consumers must use @rorca/public-contract parseGovernedExecutionContract before accepting an artifact.',
    title: `Rorca ${name} v1`,
    'x-rorca-semantic-validation': semanticValidation,
    ...jsonSchema,
  };
  const bytes = `${stable(document)}\n`;
  const file = `${name}.schema.json`;
  fs.writeFileSync(path.join(output, file), bytes);
  manifest.push({ contract: name, file, sha256: sha(bytes) });
}
const sourceDirectory = path.join(root, 'backend/src/lib/governed-contracts');
const governedContractSources = fs.readdirSync(sourceDirectory)
  .filter((file) => file.endsWith('.ts'))
  .map((file) => path.posix.join('backend/src/lib/governed-contracts', file));
const sourcePaths = [...governedContractSources, validatorSource].sort();
const sourceSnapshotPrefix = 'source-closure-';
const sourceClosure = sourcePaths.map((source) => {
  const bytes = fs.readFileSync(path.join(root, source));
  const publishedFile = `${sourceSnapshotPrefix}${Buffer.from(source, 'utf8').toString('base64url')}.txt`;
  return {
    source,
    publishedFile,
    sha256: `sha256:${sha(bytes)}`,
    bytes,
  };
});
const expectedSnapshots = new Set(sourceClosure.map(({ publishedFile }) => publishedFile));
for (const file of fs.readdirSync(output).sort()) {
  if (file.startsWith(sourceSnapshotPrefix) && file.endsWith('.txt') && !expectedSnapshots.has(file)) {
    fs.unlinkSync(path.join(output, file));
  }
}
for (const { publishedFile, bytes } of sourceClosure) {
  fs.writeFileSync(path.join(output, publishedFile), bytes);
}
const sourceClosureFiles = sourceClosure.map(({ source, publishedFile, sha256 }) => ({
  source,
  publishedFile,
  sha256,
}));
const sourceClosureDigest = `sha256:${sha(`${stable(sourceClosureFiles)}\n`)}`;
const validatorEntry = sourceClosureFiles.find(({ source }) => source === validatorSource);
if (!validatorEntry) throw new Error(`Validator source is absent from the published source closure: ${validatorSource}`);
const manifestDocument = {
  schemaVersion: 'rorca.governed-contract-schema-manifest.v2',
  contractVersion: GOVERNED_CONTRACT_VERSION,
  sourceDigest: sourceClosureDigest,
  generatedFrom: ['backend/src/lib/governed-contracts', validatorSource],
  deterministic: true,
  jsonSchema: {
    authority: 'structural-only',
    semanticRefinementsEnforced: false,
  },
  semanticValidator: {
    ...semanticValidation,
    source: validatorSource,
    publishedSource: validatorEntry.publishedFile,
    sourceSha256: validatorEntry.sha256,
  },
  sourceClosure: {
    classification: 'published-auditable-source-closure',
    description: 'Published auditable TypeScript source closure for the governed validator. It does not bind or attest the package compiled JavaScript output.',
    compiledOutputBound: false,
    digestAlgorithm: 'sha256 of stable JSON source-closure files array followed by LF',
    digest: sourceClosureDigest,
    files: sourceClosureFiles,
  },
  contracts: manifest,
};
fs.writeFileSync(path.join(output, 'manifest.json'), `${stable(manifestDocument)}\n`);
console.log(JSON.stringify({ output, contracts: manifest.length, sourceDigest: manifestDocument.sourceDigest }));
