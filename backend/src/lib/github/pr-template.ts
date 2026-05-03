/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * pr-template.ts — PR description template renderer for Rorca auto-PR creation.
 *
 * Supports Handlebars-style {{variable}} substitution with error tolerance:
 * - Recognized variables are replaced with actual values.
 * - Unrecognized variables are left as-is (no error thrown).
 * - Empty/missing template falls back to DEFAULT_PR_TEMPLATE.
 *
 * Template stored in .rorca/config.json under github.prTemplate key.
 */

// ─── Default Template ─────────────────────────────────────────────────────────

export const DEFAULT_PR_TEMPLATE = `## Summary

{{run.diffSummary}}

> **Spec brief:** {{spec.brief}}

## Stories

{{run.storiesPassed}}/{{run.storiesTotal}} stories passed

| Outcome | Count |
|---------|-------|
| ✅ Passed | {{run.storiesPassed}} |
| ❌ Failed | {{run.storiesFailed}} |
| ⏭ Skipped | {{run.storiesSkipped}} |

## Changes

\`\`\`
{{run.diffStats}}
\`\`\`

## Token Usage

| Metric | Value |
|--------|-------|
| Input tokens | {{run.tokensInput}} |
| Output tokens | {{run.tokensOutput}} |
| Total tokens | {{run.tokensTotal}} |
| Estimated cost | {{run.costUsd}} |

## Run Details

| Field | Value |
|-------|-------|
| Run ID | {{run.id}} |
| Duration | {{run.duration}} |
| Agent | {{run.agentType}} |
| Model | {{run.model}} |
| Spec | {{spec.title}} |

---
*Generated automatically by [Rorca](https://rorca.app)*`;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PrTemplateData {
  spec: {
    title: string;
    brief: string;
  };
  run: {
    id: number | string;
    storiesPassed: number;
    storiesTotal: number;
    storiesFailed: number;
    storiesSkipped: number;
    tokensInput: number;
    tokensOutput: number;
    tokensTotal: number;
    costUsd: string;
    duration: string;
    agentType: string;
    model: string;
    diffStats: string;
    diffSummary: string;
  };
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

/**
 * Replace {{variable}} placeholders in a template string with values from data.
 *
 * - Only substitutes keys present in the flat data map.
 * - Unrecognized variables (e.g. {{typo}}) are left as-is — no error thrown.
 * - Malformed braces ({{{bad}}}) are left as-is.
 * - Empty/missing template falls back to DEFAULT_PR_TEMPLATE.
 */
export function renderPrTemplate(
  template: string | null | undefined,
  data: PrTemplateData,
): string {
  const tpl = template?.trim() ? template : DEFAULT_PR_TEMPLATE;

  // Flatten nested data into a dot-notation map: { 'spec.title': 'Foo', 'run.id': '42', ... }
  const flat: Record<string, string> = {
    'spec.title': String(data.spec.title),
    'spec.brief': String(data.spec.brief),
    'run.id': String(data.run.id),
    'run.storiesPassed': String(data.run.storiesPassed),
    'run.storiesTotal': String(data.run.storiesTotal),
    'run.storiesFailed': String(data.run.storiesFailed),
    'run.storiesSkipped': String(data.run.storiesSkipped),
    'run.tokensInput': data.run.tokensInput.toLocaleString(),
    'run.tokensOutput': data.run.tokensOutput.toLocaleString(),
    'run.tokensTotal': data.run.tokensTotal.toLocaleString(),
    'run.costUsd': String(data.run.costUsd),
    'run.duration': String(data.run.duration),
    'run.agentType': String(data.run.agentType),
    'run.model': String(data.run.model),
    'run.diffStats': String(data.run.diffStats),
    'run.diffSummary': String(data.run.diffSummary),
  };

  // Replace only exact {{key}} matches where key is known — leave others as-is
  return tpl.replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
    const trimmed = key.trim();
    return Object.prototype.hasOwnProperty.call(flat, trimmed) ? flat[trimmed] : match;
  });
}

// ─── Sample data for preview ──────────────────────────────────────────────────

/** Hardcoded sample data used by the Settings UI live preview pane. */
export const SAMPLE_PR_TEMPLATE_DATA: PrTemplateData = {
  spec: {
    title: 'rorca-go-to-market-v1',
    brief: 'Add GitHub integration with auto-PR creation and PR description templates.',
  },
  run: {
    id: 42,
    storiesPassed: 8,
    storiesTotal: 10,
    storiesFailed: 1,
    storiesSkipped: 1,
    tokensInput: 125000,
    tokensOutput: 18000,
    tokensTotal: 143000,
    costUsd: '$1.43',
    duration: '12m 34s',
    agentType: 'claude',
    model: 'claude-opus-4-6',
    diffStats: '12 files changed, 487 insertions(+), 23 deletions(-)',
    diffSummary: '- Added GitHub OAuth integration with encrypted token storage\n- Created auto-PR creation flow in `github-pr-creator.ts`\n- Added PR template renderer with Handlebars-style substitution\n- Implementation note: used `fetch` directly instead of Octokit (lighter dependency)',
  },
};
