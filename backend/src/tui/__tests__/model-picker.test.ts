/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  buildAgentSwitchPayload,
  buildModelPickerLines,
  findSelectedModelIndex,
  formatActiveAgentLine,
  getPiInstallLines,
  groupPiModels,
  moveModelSelection,
  renderModelRow,
  renderProviderHeader,
} from '../modelPicker';

describe('modelPicker helpers', () => {
  const models = [
    {
      provider: 'openai',
      model: 'chatgpt-4o',
      contextTokens: 128000,
      maxOutTokens: 16000,
      thinking: false,
      images: true,
    },
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      contextTokens: 200000,
      maxOutTokens: 32000,
      thinking: true,
      images: false,
    },
  ];

  test('groups models by provider label and sorts them', () => {
    const groups = groupPiModels(models);

    expect(groups.map((group) => group.label)).toEqual(['ChatGPT Plus/Pro', 'Claude']);
    expect(groups[0].models[0].model).toBe('chatgpt-4o');
    expect(groups[1].models[0].model).toBe('claude-sonnet-4-5');
  });

  test('renders provider headers and aligned rows', () => {
    expect(renderProviderHeader('ChatGPT Plus/Pro', 3)).toBe('── ChatGPT Plus/Pro (3 models) ──');
    expect(renderModelRow(models[0], 16)).toBe('  chatgpt-4o         128k ctx   16k out  think:✗  img:✓');
  });

  test('finds current model and wraps arrow navigation', () => {
    const groups = groupPiModels(models);

    expect(findSelectedModelIndex(groups, 'claude-sonnet-4-5')).toBe(1);
    expect(moveModelSelection(0, -1, 2)).toBe(1);
    expect(moveModelSelection(1, 1, 2)).toBe(0);
  });

  test('builds picker lines with the selected row marked', () => {
    const groups = groupPiModels(models);
    const { lines, selectedLineIndex } = buildModelPickerLines(groups, 1, 18);

    expect(lines[selectedLineIndex]).toMatchObject({
      selected: true,
      text: expect.stringContaining('claude-sonnet-4-5'),
    });
  });

  test('builds agent switch payloads and active line text', () => {
    expect(buildAgentSwitchPayload('pi', 'chatgpt-4o')).toEqual({
      agent: 'pi',
      model: 'chatgpt-4o',
    });
    expect(buildAgentSwitchPayload('codex')).toEqual({ agent: 'codex' });
    expect(formatActiveAgentLine('pi', 'chatgpt-4o')).toBe('Active: pi / chatgpt-4o');
  });

  test('prints all pi install methods with the correct package', () => {
    expect(getPiInstallLines({
      npm: 'npm install -g @mariozechner/pi-coding-agent',
      pnpm: 'pnpm add -g @mariozechner/pi-coding-agent',
      bun: 'bun add -g @mariozechner/pi-coding-agent',
      curl: 'curl -fsSL https://pi.mariozechner.com/install.sh | sh',
    })).toEqual([
      'Pi CLI not installed. Install with one of:',
      'npm:  npm install -g @mariozechner/pi-coding-agent',
      'pnpm: pnpm add -g @mariozechner/pi-coding-agent',
      'bun:  bun add -g @mariozechner/pi-coding-agent',
      'curl: curl -fsSL https://pi.mariozechner.com/install.sh | sh',
    ]);
  });
});
