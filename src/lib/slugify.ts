/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'this', 'that',
  'these', 'those', 'i', 'we', 'you', 'it', 'they', 'me', 'us', 'him',
  'her', 'them', 'my', 'our', 'your', 'its', 'their', 'as', 'if', 'so',
  'not', 'no', 'up', 'out', 'all', 'just', 'also', 'then', 'than',
]);

/**
 * Convert a brief/title string to a kebab-case slug.
 * Strips stop words, keeps first 5-8 meaningful words, max 60 chars.
 */
export function briefToSlug(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));

  if (words.length === 0) return '';

  // Take up to 8 meaningful words, but trim to 5 if result exceeds 60 chars
  let slug = words.slice(0, 8).join('-');
  if (slug.length > 60) {
    slug = words.slice(0, 5).join('-');
  }

  // Hard cap at 60 chars, trim trailing hyphen
  slug = slug.slice(0, 60).replace(/-$/, '');

  return slug;
}

/**
 * Convert a title string to a kebab-case slug (simple, no stop-word stripping).
 */
export function titleToSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export const KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
