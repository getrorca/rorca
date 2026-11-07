/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Tests for the PR description template renderer (pr-template.ts).
 */

import { renderPrTemplate, DEFAULT_PR_TEMPLATE, PrTemplateData } from '../lib/github/pr-template';

const baseData: PrTemplateData = {
  spec: {
    title: 'my-spec',
    brief: 'A brief description of the spec.',
  },
  run: {
    id: 7,
    storiesPassed: 5,
    storiesTotal: 6,
    storiesFailed: 0,
    storiesSkipped: 1,
    tokensInput: 10000,
    tokensOutput: 2500,
    tokensTotal: 12500,
    costUsd: '$0.13',
    duration: '3m 42s',
    agentType: 'claude',
    model: 'claude-opus-4-6',
    diffStats: '3 files changed, 42 insertions(+), 5 deletions(-)',
    diffSummary: '- Added the requested feature\n- Preserved existing behavior',
  },
};

describe('renderPrTemplate', () => {
  it('substitutes all recognized variables', () => {
    const tpl = '{{spec.title}} | {{run.storiesPassed}}/{{run.storiesTotal}} | {{run.duration}} | {{run.agentType}} | {{run.model}}';
    const result = renderPrTemplate(tpl, baseData);
    expect(result).toBe('my-spec | 5/6 | 3m 42s | claude | claude-opus-4-6');
  });

  it('leaves unrecognized variables as-is with no error', () => {
    const tpl = 'Known: {{spec.title}} Unknown: {{typo}} Also unknown: {{run.nonexistent}}';
    const result = renderPrTemplate(tpl, baseData);
    expect(result).toBe('Known: my-spec Unknown: {{typo}} Also unknown: {{run.nonexistent}}');
  });

  it('falls back to DEFAULT_PR_TEMPLATE when template is empty string', () => {
    const result = renderPrTemplate('', baseData);
    expect(result).toContain('## Summary');
    expect(result).toContain('A brief description of the spec.');
    expect(result).not.toContain('{{spec.brief}}');
  });

  it('falls back to DEFAULT_PR_TEMPLATE when template is null', () => {
    const result = renderPrTemplate(null, baseData);
    expect(result).toContain('## Summary');
    expect(result).not.toContain('{{spec.brief}}');
  });

  it('falls back to DEFAULT_PR_TEMPLATE when template is undefined', () => {
    const result = renderPrTemplate(undefined, baseData);
    expect(result).toContain('## Summary');
  });

  it('falls back to DEFAULT_PR_TEMPLATE when template is whitespace-only', () => {
    const result = renderPrTemplate('   \n  ', baseData);
    expect(result).toContain('## Summary');
  });

  it('renders the full default template without any unreplaced variables', () => {
    const result = renderPrTemplate(DEFAULT_PR_TEMPLATE, baseData);
    // No {{...}} should remain after rendering with known data
    expect(result).not.toMatch(/\{\{[^}]+\}\}/);
    // Check key sections are populated
    expect(result).toContain('A brief description of the spec.');
    expect(result).toContain('5/6 stories passed');
    expect(result).toContain('$0.13');
    expect(result).toContain('claude');
    expect(result).toContain('3 files changed');
  });

  it('does not crash on nested/malformed braces like {{{bad}}}', () => {
    const tpl = '{{{spec.title}}} and {{spec.title}}';
    expect(() => renderPrTemplate(tpl, baseData)).not.toThrow();
    const result = renderPrTemplate(tpl, baseData);
    // The inner {{spec.title}} gets replaced, leaving {my-spec}
    expect(result).toContain('my-spec');
  });

  it('handles number formatting for token counts', () => {
    const tpl = '{{run.tokensInput}} / {{run.tokensOutput}} / {{run.tokensTotal}}';
    const result = renderPrTemplate(tpl, baseData);
    // toLocaleString() output — just check numbers are present
    expect(result).toContain('10,000');
    expect(result).toContain('2,500');
    expect(result).toContain('12,500');
  });

  it('substitutes costUsd verbatim from data', () => {
    const tpl = '{{run.costUsd}}';
    const result = renderPrTemplate(tpl, baseData);
    expect(result).toBe('$0.13');
  });
});
