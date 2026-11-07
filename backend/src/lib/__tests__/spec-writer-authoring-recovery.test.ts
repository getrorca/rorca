/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSpecDiagramsDocument,
  buildSpecDocument,
  writeSpec,
  writeSpecDiagramArtifact,
  type GeneratedSpec,
} from '../spec-writer';

const spec: GeneratedSpec = {
  slug: 'recoverable-authoring',
  title: 'Recoverable authoring',
  stories: [{
    id: 'US-001', title: 'Persist exactly', description: 'Persist exact material.',
    acceptanceCriteria: ['Exact replay is material-bound.'], dependsOn: [],
  }],
  diagrams: { storyDeps: { mermaid: 'graph TD\n  A-->B', ascii: 'A -> B' } },
  source: 'hermes-chatops-skill-first',
  authoring: {
    state: 'validated',
    mutationReceipt: {
      receiptId: '11111111-1111-4111-8111-111111111111',
      requestHash: 'sha256:' + 'a'.repeat(64),
      idempotencyKey: 'persist:recovery',
      state: 'claimed',
    },
  },
};

describe('spec writer authoring crash boundaries', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-authoring-writer-'));
    delete process.env.RORCA_AUTHORING_FAILPOINT;
  });

  afterEach(() => {
    delete process.env.RORCA_AUTHORING_FAILPOINT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('publishes deterministic material builders apart from generated timestamps', () => {
    const first = buildSpecDocument(spec, 'first');
    const second = buildSpecDocument(spec, 'second');
    expect({ ...first, generatedAt: undefined }).toEqual({ ...second, generatedAt: undefined });
    expect(buildSpecDiagramsDocument(spec, 'first').replace('first', '<time>'))
      .toBe(buildSpecDiagramsDocument(spec, 'second').replace('second', '<time>'));
  });

  test('repairs a crash after spec publication but before diagram publication without rewriting the spec', () => {
    process.env.RORCA_AUTHORING_FAILPOINT = 'persist_after_spec_file_before_diagram';
    expect(() => writeSpec(root, spec)).toThrow('[authoring-failpoint] persist_after_spec_file_before_diagram');

    const specPath = path.join(root, 'forge/specs/pending/recoverable-authoring.json');
    const diagramPath = path.join(root, 'forge/specs/pending/recoverable-authoring-diagrams.md');
    expect(fs.existsSync(specPath)).toBe(true);
    expect(fs.existsSync(diagramPath)).toBe(false);
    const before = fs.readFileSync(specPath, 'utf8');

    delete process.env.RORCA_AUTHORING_FAILPOINT;
    expect(writeSpecDiagramArtifact(root, spec)).toBe(diagramPath);
    expect(fs.readFileSync(specPath, 'utf8')).toBe(before);
    expect(fs.readFileSync(diagramPath, 'utf8')).toContain('graph TD');
  });
});
