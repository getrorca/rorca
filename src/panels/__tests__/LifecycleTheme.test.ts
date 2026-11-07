/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const tokensCss = source('src/styles/tokens.css');
const indexCss = source('src/styles/index.css');
const lifecycleSources = [
  'src/panels/LifecycleCell.tsx',
  'src/panels/LifecycleExplorer.tsx',
  'src/panels/LifecycleMatrix.tsx',
  'src/panels/LifecycleMetrics.tsx',
  'src/panels/LifecyclePanel.tsx',
  'src/panels/LifecycleToolbar.tsx',
  'src/components/LifecycleBadges.tsx',
  'src/components/LifecycleEvidenceInspector.tsx',
  'src/components/LifecycleGovernedActionDialog.tsx',
  'src/components/LifecycleHashChip.tsx',
  'src/components/LifecycleLivenessBadge.tsx',
  'src/components/LifecyclePhaseView.tsx',
  'src/components/LifecycleSpecReviewTab.tsx',
  'src/components/LifecycleTraceability.tsx',
].map(source).join('\n');

function declarations(block: string): string[] {
  return [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]).sort();
}

describe('Lifecycle token and theme regression contract', () => {
  it('defines the same complete design-token surface in light and dark themes', () => {
    const light = tokensCss.match(/:root,\s*\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)?.[1];
    const dark = tokensCss.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(light).toBeTruthy();
    expect(dark).toBeTruthy();
    const lightThemeTokens = declarations(light ?? '').filter((token) => !token.startsWith('--motion-'));
    expect(declarations(dark ?? '')).toEqual(lightThemeTokens);
    expect(light).toContain('--accent-contrast:');
    expect(dark).toContain('--accent-contrast:');
  });

  it('keeps lifecycle styling tokenized and rejects hardcoded palette regressions', () => {
    const lifecycleCss = indexCss.split('/* ─── Lifecycle evidence matrix')[1]
      ?.split('/* ─── ULT-017: Skeleton shimmer animation')[0] ?? '';
    expect(lifecycleCss).toContain('var(--panel)');
    expect(lifecycleCss).toContain('var(--text)');
    expect(lifecycleCss).toContain('var(--status-healthy)');
    expect(lifecycleCss).toContain('var(--status-degraded)');
    expect(lifecycleCss).toContain('var(--status-offline)');
    expect(lifecycleCss).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);

    expect(lifecycleSources).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(lifecycleSources).not.toMatch(/(?:bg|text|border)-(?:red|blue|green|yellow|orange|purple|gray|zinc|slate)-\d{2,3}/);
    expect(lifecycleSources).not.toContain('text-white');
    expect(lifecycleSources).toContain('text-[var(--accent-contrast)]');
  });

  it('retains visible keyboard focus and disables nonessential motion', () => {
    expect(lifecycleSources).toContain('focus-visible:ring-2');
    expect(indexCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition-duration:\s*0\.01ms !important/);
    expect(indexCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*scroll-behavior:\s*auto !important/);
  });
});
