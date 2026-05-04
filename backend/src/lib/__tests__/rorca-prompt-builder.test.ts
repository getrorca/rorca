/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

function jsonResponse(data: unknown, init?: { ok?: boolean; status?: number; statusText?: string }): Response {
  const ok = init?.ok ?? true;
  const status = init?.status ?? (ok ? 200 : 500);
  const statusText = init?.statusText ?? (ok ? 'OK' : 'Internal Server Error');
  return {
    ok,
    status,
    statusText,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response;
}

describe('rorca-prompt-builder', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('buildStoryPrompt reconstructs context, retrieval, and claude-style implementation shell', async () => {
    const fetchImpl = jest.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith('/api/direction?layer=1')) {
        return jsonResponse({ contentYaml: 'L1 standards' });
      }
      if (url.endsWith('/api/direction?layer=2&workspaceId=ws-1')) {
        return jsonResponse({ contentYaml: 'L2 conventions' });
      }
      if (url.endsWith('/api/direction?layer=3&workspaceId=ws-1')) {
        return jsonResponse({ contentYaml: 'L3 project' });
      }
      if (url.endsWith('/api/specs/spec-1?workspaceId=ws-1')) {
        return jsonResponse({
          title: 'Spec Title',
          brief: 'Spec Brief',
          userStories: [
            {
              id: 'US-001',
              title: 'Current story',
              description: 'Update backend/src/lib/execution-engine.ts with new prompt plumbing',
              acceptanceCriteria: ['Keep graph optional', 'Preserve prompt order'],
              dependsOn: ['US-000'],
              tags: ['backend'],
            },
            {
              id: 'US-000',
              title: 'Dependency story',
              description: 'Earlier setup',
            },
          ],
          storyAnnotations: {
            'US-001': 'Reviewer note',
          },
        });
      }
      if (url.endsWith('/api/workspaces/ws-1/rorca-config')) {
        return jsonResponse({
          config: {
            routing: {
              global: ['CLAUDE.md', 'AGENTS.md'],
              scopes: [
                {
                  path: 'backend/src/lib/**',
                  inject: ['backend/src/lib/execution-engine.ts'],
                  priority: 90,
                },
              ],
              tags: [
                { tag: 'backend', inject: ['backend/README.md'] },
              ],
              tokenBudget: 10000,
            },
          },
        });
      }
      if (url.includes('/api/workspaces/ws-1/context-files/read?filePath=CLAUDE.md')) {
        return jsonResponse({ content: '# CLAUDE\nProject context' });
      }
      if (url.includes('/api/workspaces/ws-1/context-files/read?filePath=AGENTS.md')) {
        return jsonResponse({ content: '# AGENTS\nGovernance' });
      }
      if (url.includes('/api/workspaces/ws-1/context-files/read?filePath=backend%2Fsrc%2Flib%2Fexecution-engine.ts')) {
        return jsonResponse({ content: '// execution-engine excerpt' });
      }
      if (url.includes('/api/workspaces/ws-1/context-files/read?filePath=backend%2FREADME.md')) {
        return jsonResponse({ content: '# backend readme' });
      }
      if (url.endsWith('/api/recall')) {
        expect(init?.method).toBe('POST');
        return jsonResponse({
          memories: [
            {
              date: '2026-05-04',
              category: 'Architecture',
              title: 'Memory A',
              rule: 'Use async enrich jobs.',
              context: 'Pi should not hold open sync requests.',
              source: 'US-019',
            },
          ],
          meta: {
            retrievalTier: 'graph',
          },
        });
      }
      if (url.endsWith('/api/context/enrich/async?mode=semantic')) {
        return jsonResponse({ jobId: 'job-1' });
      }
      if (url.endsWith('/api/spec-jobs/job-1')) {
        return jsonResponse({
          status: 'completed',
          error: null,
          result: {
            success: true,
            context: {
              direction: {
                standards: 'L1 standards',
                conventions: 'L2 conventions',
                project: 'L3 project',
              },
              memory: [{ text: 'Memory A', score: 0.9, source: 'search' }],
              skills: [{ name: 'backend', content: 'Prefer AppError subclasses.' }],
              graphContext: null,
              graphSection: '## Related History (from knowledge graph)\n- Prior touch',
              meta: {
                cagHits: 2,
                ragHits: 1,
                graphHits: 1,
                totalTokens: 400,
                latencyMs: 12,
                tier: 'graph',
                mode: 'semantic',
                graphAvailable: true,
                predictedPaths: ['backend/src/lib/execution-engine.ts'],
                inferredSkills: ['backend'],
              },
            },
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { buildStoryPrompt } = require('../rorca-prompt-builder');
    const prompt = await buildStoryPrompt('US-001', 'spec-1', 'ws-1', {
      fetchImpl,
      apiBaseUrl: 'http://localhost:3030',
    });

    expect(prompt).toContain('=== SPEC BRIEF (L4) ===\nSpec Brief');
    expect(prompt).toContain('=== STORY ANNOTATIONS (L5) ===\nReviewer note');
    expect(prompt).toContain('# === RORCA SPEC CONTEXT ===');
    expect(prompt).toContain('"dependsOnResolved": [');
    expect(prompt).toContain('"title": "Dependency story"');
    expect(prompt).toContain('## Relevant Memory');
    expect(prompt).toContain('Use async enrich jobs.');
    expect(prompt).toContain('## Retrieval Breakdown');
    expect(prompt).toContain('- Cache-first (CAG) hits: 2');
    expect(prompt).toContain('## Skill: backend');
    expect(prompt).toContain('=== RELATED HISTORY (from knowledge graph) ===');
    expect(prompt).toContain('Follow this workflow for implementation:');
    expect(prompt).toContain('## Memory Instructions');
    expect(prompt).toContain('Your task (US-001):');
    expect(prompt).toContain('Acceptance Criteria:\n- Keep graph optional\n- Preserve prompt order');
  });

  test('buildStoryPrompt aggregates missing sources into PROMPT_BUILD_FAILED', async () => {
    const fetchImpl = jest.fn(async (input: string | URL) => {
      const url = String(input);

      if (url.endsWith('/api/direction?layer=1')) {
        return jsonResponse({ error: 'boom' }, { ok: false, status: 500, statusText: 'Boom' });
      }
      if (url.endsWith('/api/direction?layer=2&workspaceId=ws-1')) {
        return jsonResponse({ contentYaml: 'ok' });
      }
      if (url.endsWith('/api/direction?layer=3&workspaceId=ws-1')) {
        return jsonResponse({ contentYaml: 'ok' });
      }
      if (url.endsWith('/api/specs/spec-1?workspaceId=ws-1')) {
        return jsonResponse({ error: 'missing' }, { ok: false, status: 404, statusText: 'Not Found' });
      }
      if (url.endsWith('/api/workspaces/ws-1/rorca-config')) {
        return jsonResponse({ error: 'missing' }, { ok: false, status: 404, statusText: 'Not Found' });
      }
      if (url.includes('/api/workspaces/ws-1/context-files/read?filePath=CLAUDE.md')) {
        return jsonResponse({ content: '# CLAUDE' });
      }
      if (url.includes('/api/workspaces/ws-1/context-files/read?filePath=AGENTS.md')) {
        return jsonResponse({ content: '# AGENTS' });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { buildStoryPrompt } = require('../rorca-prompt-builder');

    await expect(buildStoryPrompt('US-001', 'spec-1', 'ws-1', {
      fetchImpl,
      apiBaseUrl: 'http://localhost:3030',
    })).rejects.toMatchObject({
      code: 'PROMPT_BUILD_FAILED',
      missing: expect.arrayContaining(['direction', 'spec', 'workspace-context', 'recall']),
    });
  });
});
