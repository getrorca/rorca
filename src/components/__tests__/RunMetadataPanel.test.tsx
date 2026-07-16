/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen } from '@testing-library/react';
import RunMetadataPanel from '../RunMetadataPanel';

describe('RunMetadataPanel enforced options', () => {
  it('shows persisted model effort, worktree, merge, graph, terminal, and safety values', () => {
    render(
      <RunMetadataPanel
        run={{
          id: 91,
          status: 'done',
          pid: null,
          branch_name: 'feat/rorca-evidence-driven-ssdlc',
          worktree_path: '/tmp/rorca-evidence-driven-ssdlc',
          started_at: '2026-07-15T12:00:00.000Z',
          finished_at: '2026-07-15T12:01:00.000Z',
          agent_type: 'pi',
          agent_model: 'openai-codex/gpt-5.6-sol',
          agentType: 'pi',
          agentModel: 'openai-codex/gpt-5.6-sol',
          effective_options: {
            model: 'openai-codex/gpt-5.6-sol',
            effort: 'xhigh',
            worktree: {
              enabled: true,
              path: '/tmp/rorca-evidence-driven-ssdlc',
              branch: 'feat/rorca-evidence-driven-ssdlc',
            },
            merge: { strategy: 'branch-only', autoMerge: false },
            graph: { enabled: true },
            terminal: 'ansi-html',
            safety: {
              guard: 'autonomous-command-guard-v1',
              allowBackendJest: false,
              deploy: false,
              externalSend: false,
              policyLocked: true,
            },
          },
        }}
        tokenSummary={{ inputTokens: 10, outputTokens: 20 }}
        specModel="openai-codex/gpt-5.6-sol"
        totalStories={1}
        walEvents={[]}
      />,
    );

    expect(screen.getByText('openai-codex/gpt-5.6-sol')).toBeInTheDocument();
    expect(screen.getByText('xhigh')).toBeInTheDocument();
    expect(screen.getByTestId('effective-run-options')).toHaveTextContent(
      'worktree · branch-only · merge off · graph on · ansi-html',
    );
    expect(screen.getByTestId('effective-run-safety')).toHaveTextContent(
      'backend Jest blocked · deploy off · external send off · policy locked',
    );
  });
});
