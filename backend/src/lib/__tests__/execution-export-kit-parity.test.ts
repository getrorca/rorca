/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildPrompt } from '../execution-engine';

const story = {
  id: 'KIT-001',
  title: 'Consume the canonical kit',
  description: 'Implement exactly the bound requirements.',
  acceptanceCriteria: ['The provider receives the exact kit bytes.'],
  dependsOn: [],
} as Parameters<typeof buildPrompt>[0];

const kit = [
  '## Bound Rorca Export Kit',
  'Manifest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '=== REQUIREMENTS ===',
  'Exact PRD bytes',
  '=== DESIGN ===',
  'Exact SDD bytes',
  '=== DELIVERY ===',
  'Exact PLAN bytes',
].join('\n');

describe('execution export-kit provider parity', () => {
  it.each(['claude', 'opencode', 'codex'] as const)('injects the exact package into %s', (provider) => {
    const prompt = buildPrompt(
      story,
      'impl',
      process.cwd(),
      undefined,
      provider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      kit,
    );

    expect(prompt).toContain(kit);
    expect(prompt.split(kit)).toHaveLength(2);
  });

  it('keeps package bytes identical across Claude, OpenCode, and Codex prompt assembly', () => {
    const prompts = (['claude', 'opencode', 'codex'] as const).map((provider) => buildPrompt(
      story,
      'impl',
      process.cwd(),
      undefined,
      provider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      kit,
    ));
    const packageSlices = prompts.map((prompt) => prompt.slice(prompt.indexOf(kit), prompt.indexOf(kit) + kit.length));
    expect(new Set(packageSlices)).toEqual(new Set([kit]));
  });
});
