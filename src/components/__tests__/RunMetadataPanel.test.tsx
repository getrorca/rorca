/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import RunMetadataPanel from '../RunMetadataPanel';
import type { RunTokenTelemetry } from '../../lib/run-metadata';

const baseRun = {
  id: 1,
  status: 'done',
  pid: null,
  branch_name: null,
  worktree_path: null,
  started_at: '2026-01-01T00:00:00.000Z',
  finished_at: '2026-01-01T00:01:00.000Z',
};

function renderMetadata(overrides: Record<string, unknown> = {}, tokenSummary: RunTokenTelemetry = { inputTokens: null, outputTokens: null, totalCostUsd: null }) {
  return render(
    <RunMetadataPanel
      run={{ ...baseRun, ...overrides }}
      tokenSummary={tokenSummary}
      specModel={null}
      totalStories={0}
      walEvents={[]}
    />,
  );
}

describe('RunMetadataPanel telemetry', () => {
  it('shows Unknown and Unavailable for absent historical metadata', () => {
    renderMetadata();

    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable')).toHaveLength(2);
    expect(screen.queryByText('0 in / 0 out')).not.toBeInTheDocument();
  });

  it('preserves Pi/Terra and labels unavailable interactive billing as Pi-managed', () => {
    renderMetadata({ agentType: 'pi', agentModel: 'openai-codex/gpt-5.6-terra' });

    expect(screen.getByText('Pi/Terra')).toBeInTheDocument();
    expect(screen.getByText('Unavailable — Pi-managed billing')).toBeInTheDocument();
    expect(screen.getByText('Pi-managed billing')).toBeInTheDocument();
    expect(screen.queryByText('0 in / 0 out')).not.toBeInTheDocument();
  });

  it('retains real reported counts and costs, including a real zero', () => {
    renderMetadata(
      { agentType: 'pi', agentModel: 'openai-codex/gpt-5.6-terra' },
      { inputTokens: 1200, outputTokens: 45, totalCostUsd: 0.42 },
    );

    expect(screen.getByText('1.2K in / 45 out')).toBeInTheDocument();
    expect(screen.getByText('$0.42')).toBeInTheDocument();
  });
});
