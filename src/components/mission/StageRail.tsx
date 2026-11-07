/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Mission lens rail. One native link per lens; the current query string
 * (which may carry return context) is preserved on every destination so
 * lens switches never strand the operator. Dot tones are derived only from
 * the server-authored stage outcome — never from client-side inference.
 */

import { Link, useLocation } from 'react-router';
import type {
  DeliveryCaseSummaryV1,
  OutcomeStateV1Schema,
} from '../../../shared/contracts/mission';
import type { z } from 'zod';
import {
  MISSION_LENSES,
  MISSION_LENS_LABELS,
  missionCasePath,
  type MissionLens,
} from '../../lib/missionRoutes';

type Outcome = z.infer<typeof OutcomeStateV1Schema>;
type OutcomePresentation = {
  label: string;
  symbol: string;
  tone: 'success' | 'failed' | 'progress' | 'unknown';
};

const OUTCOME_PRESENTATION: Record<Outcome, OutcomePresentation> = {
  unknown: { label: 'Unknown', symbol: '?', tone: 'unknown' },
  not_available: { label: 'N/A', symbol: '—', tone: 'unknown' },
  pending: { label: 'Pending', symbol: '…', tone: 'progress' },
  partial: { label: 'Partial', symbol: '◐', tone: 'progress' },
  succeeded: { label: 'Succeeded', symbol: '✓', tone: 'success' },
  failed: { label: 'Failed', symbol: '×', tone: 'failed' },
  cancelled: { label: 'Cancelled', symbol: '■', tone: 'failed' },
};

interface StageRailProps {
  summary: DeliveryCaseSummaryV1;
  specId: string;
  activeLens: MissionLens | 'overview';
}

export default function StageRail({ summary, specId, activeLens }: StageRailProps) {
  const location = useLocation();

  const items: Array<{
    key: MissionLens | 'overview';
    label: string;
    to: string;
    outcome: Outcome;
    summary: string;
  }> = [
    {
      key: 'overview',
      label: 'Overview',
      to: `${missionCasePath(specId)}${location.search}`,
      outcome: summary.state.outcome,
      summary: summary.state.consequence,
    },
    ...MISSION_LENSES.map((lens) => {
      const stage = summary.stages[lens];
      return {
        key: lens,
        label: MISSION_LENS_LABELS[lens],
        to: `${missionCasePath(specId, lens)}${location.search}`,
        outcome: stage.state.outcome,
        summary: stage.summary,
      };
    }),
  ];

  return (
    <nav className="stage-rail" aria-label="Mission lenses">
      {items.map((item) => {
        const presentation = OUTCOME_PRESENTATION[item.outcome];
        return (
          <Link
            key={item.key}
            to={item.to}
            className="stage-rail__item"
            aria-label={`${item.label} — outcome ${presentation.label}. ${item.summary}`}
            {...(item.key === activeLens ? { 'aria-current': 'page' as const } : {})}
          >
            <span className="stage-rail__outcome" data-tone={presentation.tone}>
              <span className="stage-rail__outcome-symbol" aria-hidden="true">
                {presentation.symbol}
              </span>
              <span>{presentation.label}</span>
            </span>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
