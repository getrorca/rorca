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

function sourceSection(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Unable to locate source section from ${start} to ${end}`);
  }
  return source.slice(startIndex, endIndex);
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

  test('portfolio, phase, traceability, and inspector reads share one repeatable-read snapshot', () => {
    const source = fs.readFileSync(path.join(srcRoot, 'lib', 'ssdlc-lifecycle-read.ts'), 'utf8');
    const snapshotHelper = sourceSection(source, 'async function withLifecycleReadSnapshot', 'interface WorkspaceRow');
    const buildBundlesRead = sourceSection(source, 'async function buildBundles(', 'function missingPlanItem');
    const portfolioRead = sourceSection(source, 'export async function getLifecyclePortfolio', 'async function loadOne');
    const loadOneRead = sourceSection(source, 'async function loadOne', 'function traceabilityBlocker');
    const traceabilityRead = sourceSection(source, 'export async function getLifecycleSpec', 'export async function getLifecycleCoverageByPhase');
    const phaseRead = sourceSection(source, 'export async function getLifecyclePhase', 'export interface LifecycleRawReferenceDescriptor');
    const inspectorRead = sourceSection(source, 'export async function getLifecycleEvidence', 'export function assertLifecyclePortfolioFilters');

    expect(source.match(/SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/g)).toHaveLength(1);
    expect(snapshotHelper).toMatch(/return transaction\(async \(client\) => \{[\s\S]*?SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY[\s\S]*?set_config\('rorca\.workspace_id',\$1,TRUE\)[\s\S]*?return read\(clientReadDb\(client\), client\)/);

    // Portfolio and traceability enter directly; phase and inspector enter through loadOne.
    expect(portfolioRead.match(/\bwithLifecycleReadSnapshot\s*\(/g) ?? []).toHaveLength(1);
    expect(traceabilityRead.match(/\bwithLifecycleReadSnapshot\s*\(/g) ?? []).toHaveLength(1);
    expect(loadOneRead.match(/\bwithLifecycleReadSnapshot\s*\(/g) ?? []).toHaveLength(1);
    expect(phaseRead).not.toMatch(/\bwithLifecycleReadSnapshot\s*\(/);
    expect(inspectorRead).not.toMatch(/\bwithLifecycleReadSnapshot\s*\(/);

    expect(portfolioRead).toMatch(/return withLifecycleReadSnapshot\(input\.workspaceId, async \(db, client\)[\s\S]*?loadCandidates\(ws, input\.search, db,[\s\S]*?loadLatestReconciliations\([\s\S]*?db,\s*client\)/);
    expect(loadOneRead).toMatch(/db\?: LifecycleReadDb[\s\S]*?if \(!db\) return withLifecycleReadSnapshot\(input\.workspaceId, \(snapshotDb\) => loadOne\(input, snapshotDb\)\)[\s\S]*?workspace\(input\.workspaceId, db\)[\s\S]*?loadCandidates\(ws, undefined, db, \[specId\]\)[\s\S]*?buildBundles\(ws, \[candidate\], undefined, db\)/);
    expect(traceabilityRead).toMatch(/withLifecycleReadSnapshot\(input\.workspaceId, async \(db, client\)[\s\S]*?loadOne\(input, db\)/);
    expect(phaseRead).toMatch(/const loaded = await loadOne\(input\)/);
    expect(inspectorRead).toMatch(/const loaded = await loadOne\(\{/);
    for (const loader of ['loadCandidates', 'loadEvidence', 'loadDecisions', 'loadRuns', 'loadLearnCandidates']) {
      expect(source).toMatch(new RegExp(`function ${loader}\\([^)]*\\bdb: LifecycleReadDb`));
    }
    for (const loader of ['loadEvidence', 'loadDecisions', 'loadRuns', 'loadLearnCandidates']) {
      expect(buildBundlesRead).toMatch(new RegExp(`${loader}\\([^\\n]+, db\\)`));
    }
  });

  test('migrations do not hand-manage any pgboss table or schema', () => {
    const migrationDirectory = path.join(srcRoot, 'db', 'pg-migrations');
    const migrations = sourceFiles(migrationDirectory, (name) => name.endsWith('.sql'));
    for (const file of migrations) {
      const executableSql = withoutSqlComments(fs.readFileSync(file, 'utf8'));
      expect(executableSql).not.toMatch(/\b(?:CREATE|ALTER|DROP|TRUNCATE)\s+(?:TABLE|SCHEMA)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?"?pgboss(?:_[a-z0-9_]+)?"?(?:\s|\.|;)/i);
      expect(executableSql).not.toMatch(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|[a-z_][a-z0-9_$]*)\s+ON\s+(?:ONLY\s+)?"?pgboss(?:_[a-z0-9_]+)?"?\./i);
      expect(executableSql).not.toMatch(/\b(?:ALTER|DROP)\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?"?pgboss(?:_[a-z0-9_]+)?"?\./i);
      expect(executableSql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?pgboss\./i);
    }
  });

  test('only the canonical lifecycle assurance owners access the centralized queue', () => {
    const lifecycleLibraries = sourceFiles(path.join(srcRoot, 'lib'), (name) => (
      /^(?:ssdlc-|lifecycle-|story-closeout)/.test(name) && name.endsWith('.ts')
    ));
    const sources = new Map(lifecycleLibraries.map((file) => [
      path.basename(file),
      fs.readFileSync(file, 'utf8'),
    ] as const));
    const queueOwnership = /from ['"][^'"]*pg-boss(?:\.js)?['"]|\b(?:getBoss|initBoss)\s*\(|\bboss\.(?:createQueue|send|work|schedule)\s*\(/;
    const canonicalOwners = [
      'ssdlc-evidence-subscriber.ts',
      'ssdlc-lifecycle-orchestrator.ts',
    ];

    expect([...sources]
      .filter(([, source]) => queueOwnership.test(source))
      .map(([name]) => name)
      .sort()).toEqual([...canonicalOwners].sort());

    const subscriber = sources.get('ssdlc-evidence-subscriber.ts')!;
    expect(subscriber).toContain("from './pg-boss'");
    expect(subscriber).toContain('registerLifecycleAssuranceWorker(boss)');

    const orchestrator = sources.get('ssdlc-lifecycle-orchestrator.ts')!;
    expect(orchestrator).toMatch(/export const LIFECYCLE_ASSURANCE_QUEUE\s*=\s*['"]pipeline:lifecycle-assurance['"]\s+as const/);
    expect(orchestrator).toMatch(/\.send\(\s*LIFECYCLE_ASSURANCE_QUEUE\b/);
    expect(orchestrator).toMatch(/\bboss\.work\(\s*LIFECYCLE_ASSURANCE_QUEUE\b/);
    expect(orchestrator).not.toMatch(/\.(?:createQueue|send|work|schedule)\((?!\s*LIFECYCLE_ASSURANCE_QUEUE\b)/);

    const combined = [...sources.values()].join('\n');
    expect(combined).not.toMatch(/\bcompileWaves\s*\(/);
    expect(combined).not.toMatch(/\bdetectExecutionModeFromSpec\s*\(/);
    expect(combined).not.toMatch(/from ['"].*(?:worker|execution-engine)['"]/);
  });
});
