/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { PiModel } from '../lib/pi-detector';
import type { AgentType } from '../lib/config';

export interface ProviderGroup {
  provider: string;
  label: string;
  models: PiModel[];
}

export interface ModelPickerLine {
  text: string;
  selected?: boolean;
  isHeader?: boolean;
  modelIndex?: number;
}

export interface PiInstallMethods {
  npm: string;
  pnpm: string;
  bun: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'ChatGPT Plus/Pro',
  chatgpt: 'ChatGPT Plus/Pro',
  codex: 'ChatGPT Plus/Pro',
  anthropic: 'Claude',
  claude: 'Claude',
  google: 'Gemini',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
};

function titleCase(input: string): string {
  return input
    .split(/[\s/_-]+/)
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(' ');
}

export function getProviderLabel(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return PROVIDER_LABELS[normalized] ?? titleCase(provider);
}

export function groupPiModels(models: PiModel[]): ProviderGroup[] {
  const grouped = new Map<string, ProviderGroup>();

  for (const model of models) {
    const key = model.provider.trim().toLowerCase();
    const existing = grouped.get(key);
    if (existing) {
      existing.models.push(model);
      continue;
    }

    grouped.set(key, {
      provider: model.provider,
      label: getProviderLabel(model.provider),
      models: [model],
    });
  }

  return [...grouped.values()]
    .map((group) => ({
      ...group,
      models: [...group.models].sort((a, b) => a.model.localeCompare(b.model)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function renderProviderHeader(label: string, count: number): string {
  return `── ${label} (${count} models) ──`;
}

export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return '0';
  }

  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}m`;
  }

  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k`;
  }

  return String(tokens);
}

function truncate(input: string, width: number): string {
  if (input.length <= width) {
    return input;
  }

  return `${input.slice(0, Math.max(0, width - 1))}…`;
}

export function renderModelRow(model: PiModel, width = 24): string {
  const name = truncate(model.model, width).padEnd(width, ' ');
  const context = `${formatTokenCount(model.contextTokens)}`.padStart(5, ' ');
  const output = `${formatTokenCount(model.maxOutTokens)}`.padStart(4, ' ');
  const thinking = model.thinking ? '✓' : '✗';
  const images = model.images ? '✓' : '✗';
  return `  ${name}  ${context} ctx  ${output} out  think:${thinking}  img:${images}`;
}

export function flattenModels(groups: ProviderGroup[]): PiModel[] {
  return groups.flatMap((group) => group.models);
}

export function findSelectedModelIndex(groups: ProviderGroup[], activeModel: string | null): number {
  if (!activeModel) {
    return 0;
  }

  const models = flattenModels(groups);
  const index = models.findIndex((model) => model.model === activeModel);
  return index >= 0 ? index : 0;
}

export function moveModelSelection(currentIndex: number, delta: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return (currentIndex + delta + total) % total;
}

export function buildModelPickerLines(
  groups: ProviderGroup[],
  selectedIndex: number,
  rowWidth = 24,
): { lines: ModelPickerLine[]; selectedLineIndex: number } {
  const lines: ModelPickerLine[] = [];
  let modelIndex = 0;
  let selectedLineIndex = 0;

  for (const group of groups) {
    lines.push({ text: renderProviderHeader(group.label, group.models.length), isHeader: true });
    for (const model of group.models) {
      const selected = modelIndex === selectedIndex;
      if (selected) {
        selectedLineIndex = lines.length;
      }
      lines.push({
        text: renderModelRow(model, rowWidth),
        selected,
        modelIndex,
      });
      modelIndex += 1;
    }
  }

  return { lines, selectedLineIndex };
}

export function getVisibleModelPickerLines(
  lines: ModelPickerLine[],
  selectedLineIndex: number,
  maxLines: number,
): ModelPickerLine[] {
  if (lines.length <= maxLines) {
    return lines;
  }

  const before = Math.floor(maxLines / 2);
  const start = Math.max(0, Math.min(selectedLineIndex - before, lines.length - maxLines));
  return lines.slice(start, start + maxLines);
}

export function formatActiveAgentLine(agent: string, model: string | null): string {
  return `Active: ${agent} / ${model ?? 'default'}`;
}

export function buildAgentSwitchPayload(agent: AgentType, model?: string | null): { agent: AgentType; model?: string | null } {
  return model === undefined ? { agent } : { agent, model };
}

export function getPiInstallLines(methods: PiInstallMethods): string[] {
  return [
    'Pi CLI not installed. Install with one of:',
    `npm:  ${methods.npm}`,
    `pnpm: ${methods.pnpm}`,
    `bun:  ${methods.bun}`,
  ];
}
