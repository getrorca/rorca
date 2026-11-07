/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  compileCanonicalAssurancePlan,
  type CanonicalAssuranceCompilation,
} from '../canonical-assurance-plan';

function hash(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
async function compile(
  workspacePath: string,
  content: Record<string, unknown>,
  specSlug = 'canonical-assurance',
  location: 'pending' | 'approved' = 'pending',
): Promise<CanonicalAssuranceCompilation> {
  const canonicalSpecPath = `forge/specs/${location}/${specSlug}.json`;
  const absoluteSpecPath = path.join(workspacePath, ...canonicalSpecPath.split('/'));
  fs.mkdirSync(path.dirname(absoluteSpecPath), { recursive: true });
  fs.writeFileSync(absoluteSpecPath, JSON.stringify(content));
  return compileCanonicalAssurancePlan({
    workspaceId: 'workspace-assurance-plan',
    workspacePath,
    specSlug,
    specHash: hash(JSON.stringify(content)),
    canonicalSpecPath,
    content,
    tags: [],
  });
}


function bindingKind(
  compilation: CanonicalAssuranceCompilation,
  controlId: string,
): CanonicalAssuranceCompilation['profile']['controlInstances'][number]['mechanismBindings'][number] {
  const instance = compilation.profile.controlInstances.find((candidate) => candidate.controlId === controlId);
  const binding = instance?.mechanismBindings[0];
  if (!binding) throw new Error(`Missing active control binding ${controlId}`);
  return binding;
}

test('binds discovered commands only to compatible control objectives and preserves unavailable categories', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-assurance-plan-'));
  try {
    fs.writeFileSync(path.join(workspacePath, 'package.json'), JSON.stringify({
      scripts: {
        test: 'jest --runInBand',
        security: 'npm audit',
      },
      devDependencies: { jest: '30.0.0' },
    }));

    const compilation = await compile(workspacePath, {
      title: 'Compatible repository mechanisms',
      userStories: [{
        id: 'ASSURANCE-001',
        title: 'Bind compatible controls',
        acceptanceCriteria: ['Generic checks cannot satisfy incompatible objectives'],
      }],
    }, 'compatible-mechanisms');

    expect(bindingKind(compilation, 'CTRL-DEVELOPMENT-TRACE-UNIT')).toMatchObject({
      kind: 'command',
      mechanismId: expect.stringContaining('command:unit:'),
    });
    expect(bindingKind(compilation, 'CTRL-TESTING-REQ-REGRESSION')).toMatchObject({
      kind: 'command',
      mechanismId: expect.stringContaining('command:unit:'),
    });
    expect(bindingKind(compilation, 'CTRL-TESTING-THREAT-AUTHZ-SECRETS')).toMatchObject({
      kind: 'command',
      mechanismId: expect.stringContaining('command:security:'),
    });

    for (const controlId of [
      'CTRL-TESTING-QUALITY-ATTRIBUTES',
      'CTRL-DEPLOYMENT-READINESS-PARITY',
      'CTRL-TESTING-ACCEPTANCE',
    ]) {
      expect(bindingKind(compilation, controlId)).toMatchObject({
        kind: 'repository-path',
        mechanismId: 'repository-path:canonical-spec:compatible-mechanisms',
        locator: 'forge/specs/pending/compatible-mechanisms.json',
      });
    }
    const commandCriterion = compilation.profile.controlInstances
      .find((instance) => instance.controlId === 'CTRL-DEVELOPMENT-TRACE-UNIT')?.criteria[0];
    expect(commandCriterion).toMatchObject({ evaluator: 'exit-code', expected: '0' });
    expect(compilation.repositoryContext.availableCategories).toEqual(['unit', 'security']);
    expect(compilation.repositoryContext.unavailableCategories).toEqual(expect.arrayContaining([
      'performance', 'build', 'package', 'smoke', 'integration', 'e2e',
    ]));
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('hashes the bytes of every inspected mechanism artifact into repository identity', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-assurance-bytes-'));
  try {
    fs.writeFileSync(path.join(workspacePath, 'package.json'), JSON.stringify({
      scripts: { test: 'jest --runInBand' },
      devDependencies: { jest: '30.0.0' },
    }));
    const configPath = path.join(workspacePath, 'jest.config.ts');
    fs.writeFileSync(configPath, 'export default { testMatch: ["**/*.test.ts"] };');
    const content = { title: 'Byte identity' };
    const first = await compile(workspacePath, content);
    const firstConfig = first.repositoryContext.inspectedArtifacts
      .find((artifact) => artifact.path === 'jest.config.ts');

    expect(firstConfig).toMatchObject({
      state: 'hashed',
      contentHash: hash('export default { testMatch: ["**/*.test.ts"] };'),
    });

    fs.writeFileSync(configPath, 'export default { testMatch: ["**/*.unit.test.ts"] };');
    const second = await compile(workspacePath, content);
    expect(second.repositoryContext.mechanisms).toEqual(first.repositoryContext.mechanisms);
    expect(second.repositoryContext.hash).not.toBe(first.repositoryContext.hash);
    expect(second.repositoryContext.inspectedArtifacts
      .find((artifact) => artifact.path === 'jest.config.ts')).toMatchObject({
      state: 'hashed',
      contentHash: hash('export default { testMatch: ["**/*.unit.test.ts"] };'),
    });
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('enforces catalog exception policy without fabricating exclusion authority', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-assurance-exception-'));
  try {
    const forbidden = {
      assurance: {
        specTaskOverrides: [{
          controlId: 'CTRL-TESTING-THREAT-AUTHZ-SECRETS',
          action: 'exclude',
          requirementId: 'REQ-SEC-001',
          exception: {
            approvalReference: 'DEC-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            justification: 'Caller cannot override a forbidden catalog exception.',
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
          },
        }],
      },
    };
    await expect(compile(workspacePath, forbidden)).rejects.toMatchObject({
      code: 'PLAN_COMPILATION_FAILED',
      message: expect.stringContaining('cannot be excluded'),
    });

    const allowedWithoutGovernance = {
      assurance: {
        specTaskOverrides: [{
          controlId: 'CTRL-PLANNING-NEED-SCOPE',
          action: 'exclude',
          requirementId: 'REQ-INTAKE-001',
        }],
      },
    };
    await expect(compile(workspacePath, allowedWithoutGovernance)).rejects.toMatchObject({
      code: 'PLAN_COMPILATION_FAILED',
      message: expect.stringContaining('governed approval reference'),
    });

    const approvalOnly = structuredClone(allowedWithoutGovernance);
    (approvalOnly.assurance.specTaskOverrides[0] as Record<string, unknown>).exception = {
      approvalReference: 'DEC-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    await expect(compile(workspacePath, approvalOnly)).rejects.toMatchObject({
      message: expect.stringContaining('requires a justification'),
    });

    const withoutExpiry = structuredClone(approvalOnly);
    ((withoutExpiry.assurance.specTaskOverrides[0] as Record<string, unknown>).exception as Record<string, unknown>)
      .justification = 'A governed short-lived exception covers this exact spec revision.';
    await expect(compile(workspacePath, withoutExpiry)).rejects.toMatchObject({
      message: expect.stringContaining('requires an expiry'),
    });

    const overlong = structuredClone(withoutExpiry);
    ((overlong.assurance.specTaskOverrides[0] as Record<string, unknown>).exception as Record<string, unknown>)
      .expiresAt = new Date(Date.now() + 20 * 24 * 60 * 60 * 1_000).toISOString();
    await expect(compile(workspacePath, overlong)).rejects.toMatchObject({
      message: expect.stringContaining('within 14 days'),
    });

    const syntacticallyValidButUnverified = structuredClone(withoutExpiry);
    ((syntacticallyValidButUnverified.assurance.specTaskOverrides[0] as Record<string, unknown>).exception as Record<string, unknown>)
      .expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
    await expect(compile(workspacePath, syntacticallyValidButUnverified)).rejects.toMatchObject({
      message: expect.stringContaining('verified governed decision receipt'),
    });
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});
