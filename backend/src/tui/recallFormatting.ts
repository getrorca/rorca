/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export const RECALL_CATEGORIES = [
  'Architecture',
  'Convention',
  'Bug Fix',
  'Decision',
  'Pattern',
  'Gotcha',
] as const;

export type RecallCategory = typeof RECALL_CATEGORIES[number];

export type RecallColor = 'blue' | 'red' | 'cyan' | 'green' | 'magenta' | 'white';

export interface ParsedMemoryContent {
  title: string;
  body: string;
}

export function parseMemoryContent(content: string): ParsedMemoryContent {
  const trimmed = content.trim();
  const delimiterIndex = trimmed.indexOf(': ');

  if (delimiterIndex <= 0) {
    return { title: trimmed, body: '' };
  }

  return {
    title: trimmed.slice(0, delimiterIndex).trim(),
    body: trimmed.slice(delimiterIndex + 2).trim(),
  };
}

export function getRecallCategoryColor(category: string): RecallColor {
  switch (category) {
    case 'Decision':
      return 'blue';
    case 'Gotcha':
    case 'Bug Fix':
      return 'red';
    case 'Pattern':
      return 'cyan';
    case 'Convention':
      return 'green';
    case 'Architecture':
      return 'magenta';
    default:
      return 'white';
  }
}

export function getRecallCategoryLabel(category: string): string {
  return category.toUpperCase();
}

export function formatRecallHeader(query: string, count: number, width: number): string {
  const label = query
    ? ` Memory: '${query}' (${count} result${count === 1 ? '' : 's'}) `
    : ` Memory: recent (${count} result${count === 1 ? '' : 's'}) `;

  if (width <= label.length + 2) {
    return label.trim();
  }

  const fill = width - label.length;
  const left = Math.floor(fill / 2);
  const right = fill - left;
  return `${'━'.repeat(left)}${label}${'━'.repeat(right)}`;
}
