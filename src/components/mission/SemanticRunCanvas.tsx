/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Semantic run supervision canvas. Renders the server-authored run control
 * projection — waves, agent lanes, cost, evidence freshness, permitted
 * actions — as calm semantic structure. The raw terminal deliberately lives
 * in Run View; this surface links to it instead of embedding it. No progress
 * percentages are ever computed client-side.
 */

import { Link, useLocation } from 'react-router';
import type { RunControlProjectionV1 } from '../../../shared/contracts/mission';
import StateChips, { BlockerNote, EvidenceMeta } from './StateChips';
import {
  elapsedBetween,
  formatElapsedSeconds,
  formatRelativeTime,
  formatTokenCount,
  formatUsd,
} from '../../lib/missionFormat';
import { withReturnContext } from '../../lib/returnContext';

interface SemanticRunCanvasProps {
  projection: RunControlProjectionV1;
}

export default function SemanticRunCanvas({ projection }: SemanticRunCanvasProps) {
  const location = useLocation();
  const { costTokens, evidenceFreshness } = projection;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h3 className="text-sm font-semibold text-[var(--text)]">{projection.run.label}</h3>
          <span className="text-xs text-muted">spec {projection.spec.label}</span>
        </div>
        <StateChips
          packet={projection.state}
          facets={['outcome', 'liveness', 'risk', 'freshness']}
        />
        <div>
          <EvidenceMeta packet={projection.state} />
        </div>
      </div>

      {projection.state.blocker && <BlockerNote blocker={projection.state.blocker} />}

      {projection.waves.map((wave) => (
        <section key={wave.waveId} className="run-wave" aria-label={`Wave ${wave.ordinal + 1} ${wave.label}`}>
          <div className="flex flex-col gap-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-semibold text-[var(--text)]">
                Wave {wave.ordinal + 1} · {wave.label}
              </h4>
              <StateChips packet={wave.state} facets={['outcome', 'liveness']} />
            </div>
          </div>
          <div>
            {wave.lanes.map((lane) => (
              <div key={lane.laneId} className="agent-lane">
                <div className="agent-lane__identity">
                  <span className="agent-lane__story">{lane.label}</span>
                  <span className="text-xs text-muted">
                    agent {lane.agent}
                    {lane.model ? ` · model ${lane.model}` : ''}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StateChips packet={lane.state} facets={['outcome', 'liveness']} />
                  {lane.startedAt ? (
                    <span className="text-xs text-muted">
                      elapsed {formatElapsedSeconds(elapsedBetween(lane.startedAt, lane.completedAt))}
                    </span>
                  ) : (
                    <span className="text-xs text-muted">not started</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      <section aria-label="Cost and tokens (USD)" className="flex flex-col gap-1">
        <h4 className="text-xs font-semibold text-muted">Cost and tokens (USD)</h4>
        <p className="text-xs text-[var(--text)]">
          Cost {formatUsd(costTokens.actualCost)} actual · {formatUsd(costTokens.estimatedCost)}{' '}
          estimated · tokens in {formatTokenCount(costTokens.inputTokens)} / out{' '}
          {formatTokenCount(costTokens.outputTokens)}
        </p>
      </section>

      <p className="pk-meta">
        Evidence freshness {evidenceFreshness.state}
        {evidenceFreshness.newestEvidenceAt
          ? ` · newest evidence ${formatRelativeTime(evidenceFreshness.newestEvidenceAt)}`
          : ''}
        {` · ${evidenceFreshness.evidenceCount} evidence items · stale after ${evidenceFreshness.staleAfterSeconds}s`}
      </p>

      {projection.permittedActions.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Permitted run actions">
          {projection.permittedActions.map((action) => (
            <Link
              key={action.actionId}
              to={withReturnContext(action.href, location, {
                lens: 'development',
                focus: action.actionId,
              })}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-[var(--text)]"
            >
              {action.label}
              {action.requiresApproval && (
                <span className="sr-only"> (requires approval)</span>
              )}
            </Link>
          ))}
        </div>
      )}

      <p className="text-xs text-muted">
        Semantic projection only — raw terminal output opens in Run View.
      </p>
    </div>
  );
}
