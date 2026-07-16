/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeSpec, GeneratedSpec } from '../spec-writer';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-spec-writer-'));
}

function makeSpec(slug = 'test-feature'): GeneratedSpec {
  return {
    title: 'Test Feature',
    slug,
    stories: [
      {
        id: 'US-001',
        title: 'First story',
        description: 'Do the first thing',
        acceptanceCriteria: ['AC-1', 'AC-2'],
        dependsOn: [],
      },
      {
        id: 'US-002',
        title: 'Second story',
        description: 'Do the second thing',
        acceptanceCriteria: ['AC-3'],
        dependsOn: ['US-001'],
      },
    ],
    diagrams: {
      storyDeps: {
        mermaid: 'graph LR\n  US-001 --> US-002',
        ascii: 'US-001\n  └─ US-002',
      },
      architecture: {
        mermaid: 'graph TD\n  A-->B',
        ascii: 'A -> B',
      },
    },
  };
}

describe('writeSpec', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates specPath and diagramsPath files', () => {
    const spec = makeSpec();
    const result = writeSpec(tmpDir, spec);

    expect(fs.existsSync(result.specPath)).toBe(true);
    expect(fs.existsSync(result.diagramsPath)).toBe(true);
    expect(result.id).toBe('test-feature');
    expect(result.specPath).toContain('test-feature.json');
    expect(result.diagramsPath).toContain('test-feature-diagrams.md');
  });

  it('writes JSON with userStories array (not stories) and passes:false on each', () => {
    const spec = makeSpec();
    const result = writeSpec(tmpDir, spec);
    const json = JSON.parse(fs.readFileSync(result.specPath, 'utf8'));

    expect(json.id).toBe('test-feature');
    expect(json.slug).toBe('test-feature');
    expect(json.title).toBe('Test Feature');
    expect(json.userStories).toBeDefined();
    expect(json.stories).toBeUndefined();
    expect(json.userStories).toHaveLength(2);
    expect(json.userStories[0].passes).toBe(false);
    expect(json.userStories[1].passes).toBe(false);
    expect(json.userStories[0].id).toBe('US-001');
    expect(json.userStories[1].dependsOn).toEqual(['US-001']);
  });

  it('writes diagrams markdown with mermaid code blocks', () => {
    const spec = makeSpec();
    const result = writeSpec(tmpDir, spec);
    const md = fs.readFileSync(result.diagramsPath, 'utf8');

    expect(md).toContain('# Test Feature — Diagrams');
    expect(md).toContain('```mermaid');
    expect(md).toContain('graph LR');
    expect(md).toContain('## storyDeps');
    expect(md).toContain('## architecture');
  });

  it('throws when slug already exists (no silent overwrite)', () => {
    const spec = makeSpec();
    writeSpec(tmpDir, spec);

    expect(() => writeSpec(tmpDir, spec)).toThrow('test-feature');
  });

  it('creates nested directories if they do not exist', () => {
    const deepDir = path.join(tmpDir, 'some', 'nested', 'workspace');
    const spec = makeSpec();
    const result = writeSpec(deepDir, spec);

    expect(fs.existsSync(result.specPath)).toBe(true);
    expect(result.specPath).toContain(path.join('some', 'nested', 'workspace', 'forge', 'specs', 'pending'));
  });
});
