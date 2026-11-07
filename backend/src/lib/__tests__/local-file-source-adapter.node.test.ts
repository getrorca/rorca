/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ValidationError } from '../errors';
import { resolveLocalFileSource } from '../local-file-source-adapter';
import { SourceCitationV1Schema, SourceRefV1Schema } from '../source-contracts';

const fixtures: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'rorca-local-source-'));
  fixtures.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('resolveLocalFileSource', () => {
  it('normalizes and hashes Markdown while citing exact heading sections and line ranges', async () => {
    const root = await fixture();
    await mkdir(path.join(root, 'docs'));
    const markdown = '# Mission\r\nOverview\r\n## Inputs\r\nUse facts.\r\n## Result\r\nShip it.\r\n';
    await writeFile(path.join(root, 'docs', 'mission.md'), markdown);

    const result = await resolveLocalFileSource(root, 'docs/mission.md');

    assert.equal(result.sourceRef.kind, 'local_file');
    assert.equal(result.sourceRef.locator, 'docs/mission.md');
    assert.equal(result.sourceRef.title, 'Mission');
    assert.equal(
      result.sourceRef.contentHash,
      `sha256:${createHash('sha256').update(markdown.replace(/\r\n/g, '\n')).digest('hex')}`,
    );
    assert.deepEqual(result.sourceRef.selectedSections, ['# Mission', '## Inputs', '## Result']);
    assert.deepEqual(
      result.sections.map(({ heading, startLine, endLine }) => ({ heading, startLine, endLine })),
      [
        { heading: '# Mission', startLine: 1, endLine: 2 },
        { heading: '## Inputs', startLine: 3, endLine: 4 },
        { heading: '## Result', startLine: 5, endLine: 7 },
      ],
    );
    assert.match(result.citations[1].rationale, /## Inputs, lines 3-4/);
    assert.equal(result.citations[1].excerptHash, `sha256:${createHash('sha256').update('## Inputs\nUse facts.').digest('hex')}`);
    assert.doesNotThrow(() => SourceRefV1Schema.parse(result.sourceRef));
    result.citations.forEach((citation) => assert.doesNotThrow(() => SourceCitationV1Schema.parse(citation)));
    assert.deepEqual(result.truncations, []);
  });

  it('extracts indented ATX headings and ignores headings inside correctly bounded code fences', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'fences.md'), [
      '  # Visible',
      '````markdown',
      '## Not a section',
      '```',
      '### Still fenced',
      '````',
      '## Result',
      'done',
    ].join('\n'));

    const result = await resolveLocalFileSource(root, 'fences.md');

    assert.deepEqual(result.sourceRef.selectedSections, ['# Visible', '## Result']);
    assert.deepEqual(
      result.sections.map(({ heading, startLine, endLine }) => ({ heading, startLine, endLine })),
      [
        { heading: '# Visible', startLine: 1, endLine: 6 },
        { heading: '## Result', startLine: 7, endLine: 8 },
      ],
    );
  });

  it('rejects traversal, absolute paths, missing files, and symlinks escaping the workspace', async () => {
    const root = await fixture();
    const outside = await fixture();
    const outsideFile = path.join(outside, 'outside.md');
    await writeFile(outsideFile, '# Outside');
    await symlink(outsideFile, path.join(root, 'escape.md'));

    const invalid = [
      '../outside.md',
      '%2e%2e/outside.md',
      outsideFile,
      'C:\\outside.md',
      'mission.md?revision=1',
      'mission.md#scope',
      'missing.md',
      'escape.md',
    ];
    for (const candidate of invalid) {
      await assert.rejects(
        resolveLocalFileSource(root, candidate),
        (error: unknown) => error instanceof ValidationError && error.code === 'VALIDATION_ERROR',
      );
    }
  });

  it('bounds oversized sections and reports every truncation explicitly', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'large.md'), `# Large\n${'🙂'.repeat(20)}`);

    const result = await resolveLocalFileSource(root, 'large.md', { maxSectionBytes: 20 });

    assert.equal(Buffer.byteLength(result.sections[0].content, 'utf8') <= 20, true);
    assert.equal(result.truncations.length, 1);
    assert.deepEqual(result.truncations[0], {
      section: '# Large',
      startLine: 1,
      endLine: 2,
      originalBytes: 88,
      returnedBytes: 20,
      omittedBytes: 68,
      reason: 'section_byte_limit',
    });
    assert.equal(result.citations[0].excerptHash, `sha256:${createHash('sha256').update(result.sections[0].content).digest('hex')}`);
  });

  it('rejects binary and malformed UTF-8 files as non-text evidence', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'binary.txt'), Buffer.from([0x41, 0x00, 0x42]));
    await writeFile(path.join(root, 'controls.txt'), Buffer.from([0x47, 0x49, 0x46, 0x01, 0x02]));
    await writeFile(path.join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
    await writeFile(path.join(root, 'delete-control.txt'), Buffer.from([0x74, 0x65, 0x78, 0x74, 0x7f]));

    await assert.rejects(resolveLocalFileSource(root, 'binary.txt'), ValidationError);
    await assert.rejects(resolveLocalFileSource(root, 'controls.txt'), ValidationError);
    await assert.rejects(resolveLocalFileSource(root, 'invalid.txt'), ValidationError);
    await assert.rejects(resolveLocalFileSource(root, 'delete-control.txt'), ValidationError);
  });

  it('treats heading-less text as user evidence without persistence hooks', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'notes.txt'), 'mission notes');

    const result = await resolveLocalFileSource(root, 'notes.txt');

    assert.deepEqual(result.sourceRef.selectedSections, ['Document']);
    assert.equal(result.sections[0].content, 'mission notes');
    assert.deepEqual(result.knowledgePolicy, {
      classification: 'user_supplied_source_evidence',
      genesisCapture: 'explicit_action_required',
    });
    assert.equal(Object.keys(result).some((key) => /memoryCandidate|genesisEntry/i.test(key)), false);
  });
});
