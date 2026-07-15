/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';

const srcRoot = path.resolve(__dirname, '..', '..');

function sourceFiles(directory: string, predicate: (name: string) => boolean): string[] {
  return fs.readdirSync(directory)
    .filter(predicate)
    .map((name) => path.join(directory, name));
}

function withoutSqlComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '');
}

describe('lifecycle dependency and infrastructure boundaries', () => {
  test('lifecycle routes never write SSE responses directly', () => {
    const routes = sourceFiles(path.join(srcRoot, 'routes'), (name) => /^lifecycle.*\.ts$/.test(name));
    expect(routes.length).toBeGreaterThan(0);

    for (const file of routes) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source).not.toMatch(/\bres\.(?:write|writeHead|end)\s*\(/);
      expect(source).not.toMatch(/text\/event-stream/);
    }

    const mutations = fs.readFileSync(path.join(srcRoot, 'lib', 'lifecycle-mutations.ts'), 'utf8');
    expect(mutations).toContain("from './sse-hub'");
  });

  test('migrations do not hand-manage any pgboss table or schema', () => {
    const migrationDirectory = path.join(srcRoot, 'db', 'pg-migrations');
    const migrations = sourceFiles(migrationDirectory, (name) => name.endsWith('.sql'));
    for (const file of migrations) {
      const executableSql = withoutSqlComments(fs.readFileSync(file, 'utf8'));
      expect(executableSql).not.toMatch(/\b(?:CREATE|ALTER|DROP|TRUNCATE)\s+(?:TABLE|SCHEMA|INDEX)[\s\S]{0,160}\bpgboss\b/i);
      expect(executableSql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?pgboss\./i);
    }
  });

  test('lifecycle libraries do not create another queue, scheduler, execution loop, or mode detector', () => {
    const lifecycleLibraries = sourceFiles(path.join(srcRoot, 'lib'), (name) => (
      /^(?:ssdlc-|lifecycle-|story-closeout)/.test(name) && name.endsWith('.ts')
    ));
    const combined = lifecycleLibraries.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

    expect(combined).not.toMatch(/from ['"]pg-boss['"]/);
    expect(combined).not.toMatch(/\b(?:createQueue|boss\.send|boss\.work)\s*\(/);
    expect(combined).not.toMatch(/\bcompileWaves\s*\(/);
    expect(combined).not.toMatch(/\bdetectExecutionModeFromSpec\s*\(/);
    expect(combined).not.toMatch(/from ['"].*(?:worker|execution-engine)['"]/);
  });
});
