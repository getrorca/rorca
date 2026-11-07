/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  LIFECYCLE_PHASES,
  LIFECYCLE_STAGES,
  type LifecyclePortfolioFilters,
  type LifecycleSort,
} from '../types/lifecycle';

export const LIFECYCLE_QUERY_FIELDS = [
  'status', 'phase', 'stage', 'risk', 'owner', 'blocked', 'sort', 'view', 'spec-status', 'disposition',
] as const;

export type LifecycleQueryField = typeof LIFECYCLE_QUERY_FIELDS[number];

export interface LifecycleQueryToken {
  field: LifecycleQueryField;
  value: string;
  source: string;
}

export interface LifecycleQueryResult {
  filters: Partial<LifecyclePortfolioFilters>;
  freeText: string;
  tokens: LifecycleQueryToken[];
  errors: string[];
}

export interface LifecycleQuerySuggestion {
  id: string;
  label: string;
  description: string;
  replacement: string;
}

interface Lexeme { source: string; value: string; quoted: boolean }

const STATUS_VALUES = [
  'not_started', 'in_progress', 'blocked', 'awaiting_approval', 'passed', 'deferred',
  'not_applicable', 'stale', 'needs_compilation',
] as const;
const RISK_VALUES = ['low', 'medium', 'high', 'critical'] as const;
const SORT_VALUES = ['current_view', 'updated_desc', 'title_asc', 'risk_desc', 'readiness_desc', 'owner_asc'] as const;
const SPEC_STATUS_VALUES = ['pending', 'approved', 'completed', 'rejected'] as const;
const DISPOSITION_VALUES = ['required', 'deferred', 'not_applicable'] as const;

const FIELD_DESCRIPTIONS: Record<LifecycleQueryField, string> = {
  status: 'Evaluated lifecycle status',
  phase: 'Current lifecycle phase',
  stage: 'Current lifecycle stage (seven-stage delivery projection)',
  risk: 'Spec risk level',
  owner: 'Owner identifier',
  blocked: 'Blocked state (true or false)',
  sort: 'Portfolio sort order',
  view: 'Alias for sort order',
  'spec-status': 'Spec review status',
  disposition: 'Governed phase disposition',
};

function lex(input: string): Lexeme[] {
  const values: Lexeme[] = [];
  let index = 0;
  while (index < input.length) {
    while (/\s/.test(input[index] ?? '')) index += 1;
    if (index >= input.length) break;
    const start = index;
    let value = '';
    let quoted = false;
    let inQuote = false;
    while (index < input.length) {
      const character = input[index];
      if (character === '\\' && inQuote && index + 1 < input.length) {
        value += input[index + 1];
        index += 2;
        continue;
      }
      if (character === '"') {
        quoted = quoted || index === start;
        inQuote = !inQuote;
        index += 1;
        continue;
      }
      if (!inQuote && /\s/.test(character)) break;
      value += character;
      index += 1;
    }
    values.push({ source: input.slice(start, index), value, quoted });
  }
  return values;
}

function normalizedEnum(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function validEnum<T extends string>(value: string, values: readonly T[]): T | null {
  const normalized = normalizedEnum(value);
  return values.includes(normalized as T) ? normalized as T : null;
}

function parseBoolean(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', '1'].includes(normalized)) return true;
  if (['false', 'no', '0'].includes(normalized)) return false;
  return null;
}

function queryField(value: string): LifecycleQueryField | null {
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  return LIFECYCLE_QUERY_FIELDS.includes(normalized as LifecycleQueryField)
    ? normalized as LifecycleQueryField
    : null;
}

/** Parse a bounded, non-executable query into the existing portfolio filters. */
export function parseLifecycleQuery(input: string): LifecycleQueryResult {
  const filters: Partial<LifecyclePortfolioFilters> = {};
  const freeText: string[] = [];
  const tokens: LifecycleQueryToken[] = [];
  const errors: string[] = [];

  for (const item of lex(input.slice(0, 500))) {
    const separator = item.value.indexOf(':');
    if (item.quoted || separator <= 0) {
      if (item.value.trim()) freeText.push(item.value.trim());
      continue;
    }
    const field = queryField(item.value.slice(0, separator));
    if (!field) {
      freeText.push(item.value);
      continue;
    }
    const rawValue = item.value.slice(separator + 1).trim();
    if (!rawValue) {
      errors.push(`${field} requires a value`);
      continue;
    }

    let accepted: string | boolean | null = null;
    if (field === 'status') accepted = validEnum(rawValue, STATUS_VALUES);
    else if (field === 'phase') accepted = validEnum(rawValue, LIFECYCLE_PHASES.map((phase) => phase.id));
    else if (field === 'stage') accepted = validEnum(rawValue, LIFECYCLE_STAGES.map((stage) => stage.id));
    else if (field === 'risk') accepted = validEnum(rawValue, RISK_VALUES);
    else if (field === 'blocked') accepted = parseBoolean(rawValue);
    else if (field === 'sort' || field === 'view') accepted = validEnum(rawValue, SORT_VALUES);
    else if (field === 'spec-status') accepted = validEnum(rawValue, SPEC_STATUS_VALUES);
    else if (field === 'disposition') accepted = validEnum(rawValue, DISPOSITION_VALUES);
    else if (field === 'owner') accepted = rawValue.slice(0, 256);

    if (accepted === null || accepted === '') {
      errors.push(`Unsupported ${field} value: ${rawValue}`);
      continue;
    }
    tokens.push({ field, value: String(accepted), source: item.source });
    if (field === 'view' || field === 'sort') filters.sort = accepted as LifecyclePortfolioFilters['sort'];
    else if (field === 'spec-status') filters.specStatus = accepted as LifecyclePortfolioFilters['specStatus'];
    else filters[field] = accepted as never;
  }

  return { filters, freeText: freeText.join(' ').trim().slice(0, 200), tokens, errors };
}

function quoted(value: string): string {
  return /[\s:"]/.test(value) ? `"${value.replace(/(["\\])/g, '\\$1')}"` : value;
}

/** Canonical query text used to keep URL filters, chips, and the query box synchronized. */
export function formatLifecycleQuery(filters: LifecyclePortfolioFilters): string {
  const parts: string[] = [];
  if (filters.search) parts.push(quoted(filters.search));
  if (filters.status) parts.push(`status:${filters.status}`);
  if (filters.phase) parts.push(`phase:${filters.phase}`);
  if (filters.stage) parts.push(`stage:${filters.stage}`);
  if (filters.risk) parts.push(`risk:${filters.risk}`);
  if (filters.owner) parts.push(`owner:${quoted(filters.owner)}`);
  if (filters.blocked !== undefined) parts.push(`blocked:${String(filters.blocked)}`);
  if (filters.specStatus) parts.push(`spec-status:${filters.specStatus}`);
  if (filters.disposition) parts.push(`disposition:${filters.disposition}`);
  if (filters.sort !== 'current_view') parts.push(`view:${filters.sort}`);
  return parts.join(' ');
}

function displayLabel(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function valueSuggestions(field: LifecycleQueryField, owners: ReadonlyArray<readonly [string, string]>): ReadonlyArray<readonly [string, string]> {
  if (field === 'status') return STATUS_VALUES.map((value) => [value, displayLabel(value)] as const);
  if (field === 'phase') return LIFECYCLE_PHASES.map((phase) => [phase.id, phase.displayName] as const);
  if (field === 'stage') return LIFECYCLE_STAGES.map((stage) => [stage.id, stage.displayName] as const);
  if (field === 'risk') return RISK_VALUES.map((value) => [value, displayLabel(value)] as const);
  if (field === 'blocked') return [['true', 'Blocked'], ['false', 'Not blocked']];
  if (field === 'sort' || field === 'view') return SORT_VALUES.map((value) => [value, displayLabel(value)] as const);
  if (field === 'spec-status') return SPEC_STATUS_VALUES.map((value) => [value, displayLabel(value)] as const);
  if (field === 'disposition') return DISPOSITION_VALUES.map((value) => [value, displayLabel(value)] as const);
  return owners;
}

/** Suggestions are limited to known fields/values and replace only the active query segment. */
export function lifecycleQuerySuggestions(
  input: string,
  owners: ReadonlyArray<readonly [string, string]> = [],
): LifecycleQuerySuggestion[] {
  const segmentStart = Math.max(input.lastIndexOf(' '), input.lastIndexOf('\n')) + 1;
  const segment = input.slice(segmentStart);
  const separator = segment.indexOf(':');
  if (separator < 0) {
    const match = segment.toLowerCase();
    return LIFECYCLE_QUERY_FIELDS
      .filter((field) => !match || field.startsWith(match))
      .slice(0, 8)
      .map((field) => ({
        id: `field-${field}`,
        label: `${field}:`,
        description: FIELD_DESCRIPTIONS[field],
        replacement: `${input.slice(0, segmentStart)}${field}:`,
      }));
  }
  const field = queryField(segment.slice(0, separator));
  if (!field) return [];
  const match = normalizedEnum(segment.slice(separator + 1));
  return valueSuggestions(field, owners)
    .filter(([value, label]) => !match || normalizedEnum(value).includes(match) || normalizedEnum(label).includes(match))
    .slice(0, 12)
    .map(([value, label]) => ({
      id: `${field}-${value}`,
      label,
      description: `${field}:${value}`,
      replacement: `${input.slice(0, segmentStart)}${field}:${quoted(value)} `,
    }));
}

export function lifecycleSortLabel(sort: LifecycleSort): string {
  return displayLabel(sort);
}
