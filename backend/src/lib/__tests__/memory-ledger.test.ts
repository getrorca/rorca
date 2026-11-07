/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseMemoryFile,
  serializeEntry,
  serializeMemoryFile,
  append,
  query,
  recent,
  deleteEntry,
  updateEntry,
  readMemory,
  logRejected,
  readRejected,
  getContextSnippet,
  buildSynthesisPrompt,
  parseSynthesisResponse,
  type MemoryEntry,
} from '../memory-ledger';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-ledger-test-'));
  fs.mkdirSync(path.join(tmpDir, '.rorca', 'memory'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const sampleEntry: MemoryEntry = {
  date: '2026-02-28',
  category: 'Architecture',
  title: 'Use virtual context routing',
  rule: 'Context is assembled virtually at runtime — no physical file scatter.',
  context: 'micromatch handles glob matching for path-based scoping.',
  source: 'CIE-004',
};

describe('parseMemoryFile', () => {
  it('parses a well-formed MEMORY.md', () => {
    const content = `# Memory Ledger

## 2026-02-28 [Architecture] Use virtual context routing
> Rule: Context is assembled virtually at runtime.
> Context: micromatch handles glob matching.
> Source: CIE-004

## 2026-02-28 [Gotcha] Backend requires restart
> Rule: tsx has no hot-reload.
> Context: Changes are not picked up automatically.
> Source: v2-platform
`;

    const entries = parseMemoryFile(content);
    expect(entries).toHaveLength(2);
    expect(entries[0].date).toBe('2026-02-28');
    expect(entries[0].category).toBe('Architecture');
    expect(entries[0].title).toBe('Use virtual context routing');
    expect(entries[0].rule).toBe('Context is assembled virtually at runtime.');
    expect(entries[1].category).toBe('Gotcha');
    expect(entries[1].title).toBe('Backend requires restart');
  });

  it('returns empty array for empty content', () => {
    expect(parseMemoryFile('')).toHaveLength(0);
  });

  it('handles entries with missing optional fields', () => {
    const content = `## 2026-02-28 [Decision] Choose SQLite
> Rule: Use SQLite for single-user local tool.
`;
    const entries = parseMemoryFile(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].context).toBe('');
    expect(entries[0].source).toBe('');
  });
});

describe('serializeEntry', () => {
  it('produces correct format', () => {
    const output = serializeEntry(sampleEntry);
    expect(output).toContain('## 2026-02-28 [Architecture] Use virtual context routing');
    expect(output).toContain('> Rule: Context is assembled virtually');
    expect(output).toContain('> Context: micromatch handles');
    expect(output).toContain('> Source: CIE-004');
  });
});

describe('serializeMemoryFile', () => {
  it('produces a complete file with header', () => {
    const output = serializeMemoryFile([sampleEntry]);
    expect(output).toMatch(/^# Memory Ledger/);
    expect(output).toContain('## 2026-02-28');
  });

  it('produces header only for empty array', () => {
    expect(serializeMemoryFile([])).toBe('# Memory Ledger\n');
  });
});

describe('append', () => {
  it('appends an entry to MEMORY.md', () => {
    const entries = append(tmpDir, sampleEntry);
    expect(entries).toHaveLength(1);

    const onDisk = readMemory(tmpDir);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].title).toBe(sampleEntry.title);
  });

  it('appends multiple entries in order', () => {
    append(tmpDir, sampleEntry);
    append(tmpDir, { ...sampleEntry, title: 'Second entry', category: 'Gotcha' });

    const entries = readMemory(tmpDir);
    expect(entries).toHaveLength(2);
    expect(entries[1].title).toBe('Second entry');
  });
});

describe('query', () => {
  it('filters by category', () => {
    append(tmpDir, sampleEntry);
    append(tmpDir, { ...sampleEntry, title: 'A gotcha', category: 'Gotcha' });
    append(tmpDir, { ...sampleEntry, title: 'Another arch', category: 'Architecture' });

    const arch = query(tmpDir, 'Architecture');
    expect(arch).toHaveLength(2);

    const gotchas = query(tmpDir, 'Gotcha');
    expect(gotchas).toHaveLength(1);
  });
});

describe('recent', () => {
  it('returns last N entries', () => {
    for (let i = 0; i < 5; i++) {
      append(tmpDir, { ...sampleEntry, title: `Entry ${i}` });
    }

    const last3 = recent(tmpDir, 3);
    expect(last3).toHaveLength(3);
    expect(last3[0].title).toBe('Entry 2');
    expect(last3[2].title).toBe('Entry 4');
  });

  it('returns all if fewer than N exist', () => {
    append(tmpDir, sampleEntry);
    const result = recent(tmpDir, 20);
    expect(result).toHaveLength(1);
  });
});

describe('deleteEntry', () => {
  it('removes an entry by date + title', () => {
    append(tmpDir, sampleEntry);
    append(tmpDir, { ...sampleEntry, title: 'Keep this' });

    const removed = deleteEntry(tmpDir, sampleEntry.date, sampleEntry.title);
    expect(removed).toBe(true);

    const remaining = readMemory(tmpDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe('Keep this');
  });

  it('returns false for non-existent entry', () => {
    expect(deleteEntry(tmpDir, '2099-01-01', 'Nope')).toBe(false);
  });
});

describe('updateEntry', () => {
  it('updates rule and category', () => {
    append(tmpDir, sampleEntry);

    const result = updateEntry(tmpDir, sampleEntry.date, sampleEntry.title, {
      rule: 'Updated rule',
      category: 'Convention',
    });

    expect(result).not.toBeNull();
    const entries = readMemory(tmpDir);
    expect(entries[0].rule).toBe('Updated rule');
    expect(entries[0].category).toBe('Convention');
  });

  it('returns null for non-existent entry', () => {
    expect(updateEntry(tmpDir, '2099-01-01', 'Nope', { rule: 'x' })).toBeNull();
  });
});

describe('rejected entries', () => {
  it('logs and reads rejected entries', () => {
    logRejected(tmpDir, sampleEntry, 'prop-1');

    const rejected = readRejected(tmpDir);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].proposalId).toBe('prop-1');
    expect(rejected[0].rejectedAt).toBeDefined();
  });
});

describe('getContextSnippet', () => {
  it('returns formatted snippet for injection', () => {
    append(tmpDir, sampleEntry);
    const snippet = getContextSnippet(tmpDir, 20);
    expect(snippet).toContain('# Memory Ledger');
    expect(snippet).toContain('[Architecture]');
    expect(snippet).toContain('> Rule:');
  });

  it('returns empty string when no entries exist', () => {
    expect(getContextSnippet(tmpDir)).toBe('');
  });
});

describe('buildSynthesisPrompt', () => {
  it('includes story results and existing entries', () => {
    const prompt = buildSynthesisPrompt(
      [{ id: 'US-001', title: 'Add login', status: 'pass' }],
      [sampleEntry],
    );
    expect(prompt).toContain('US-001');
    expect(prompt).toContain('Add login');
    expect(prompt).toContain('[Architecture]');
    expect(prompt).toContain('JSON array');
  });

  it('surfaces structured run findings (US-009) with prioritization instructions', () => {
    const prompt = buildSynthesisPrompt(
      [{ id: 'US-001', title: 'Add login', status: 'pass' }],
      [sampleEntry],
      {
        runStatus: 'done',
        diffs: '',
        walEvents: '',
        errorMessages: '',
        findings: '- [decision] Decision: use hash-based routing\n- [risk] Story US-002 passed only after 3 retries (capture_candidate)',
      },
    );
    expect(prompt).toContain('## Run Findings (structured feed-forward)');
    expect(prompt).toContain('- [decision] Decision: use hash-based routing');
    expect(prompt).toContain('prioritize them');
    expect(prompt).toContain('`decision` and `convention` should normally produce entries');
  });

  it('omits the findings section when no findings context is provided', () => {
    const prompt = buildSynthesisPrompt(
      [{ id: 'US-001', title: 'Add login', status: 'pass' }],
      [sampleEntry],
      { runStatus: 'done', diffs: '', walEvents: '', errorMessages: '' },
    );
    expect(prompt).not.toContain('Run Findings (structured feed-forward)');
  });
});

describe('parseSynthesisResponse', () => {
  it('parses valid JSON array from response', () => {
    const response = `Here are the proposed entries:
\`\`\`json
[
  {
    "category": "Convention",
    "title": "Always validate input",
    "rule": "Use zod schemas for all API input validation.",
    "context": "Prevents runtime type errors.",
    "source": "US-001"
  }
]
\`\`\``;

    const entries = parseSynthesisResponse(response);
    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe('Convention');
    expect(entries[0].title).toBe('Always validate input');
  });

  it('returns empty array for invalid response', () => {
    expect(parseSynthesisResponse('No JSON here')).toHaveLength(0);
  });

  it('filters invalid categories', () => {
    const response = `[{"category": "InvalidCat", "title": "X", "rule": "Y", "context": "", "source": ""}]`;
    expect(parseSynthesisResponse(response)).toHaveLength(0);
  });
});
