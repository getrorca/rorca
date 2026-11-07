/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * OperationalStatePacketV1 rendering. The six channels — outcome, liveness,
 * risk, confidence, freshness, authority — stay visibly separated. Every chip
 * pairs a tone with a channel label, value text, and an icon so meaning never
 * depends on color alone. Unknown and unavailable values render with a dashed
 * edge: missing evidence must never read as a quiet "ok".
 */

import {
  Activity, BadgeCheck, Ban, CheckCircle2, Circle, CircleDashed, CircleDot,
  Clock3, FileSearch, HelpCircle, History, Hourglass, Layers, ListPlus,
  MessageSquareWarning, MinusCircle, OctagonAlert, PauseCircle, ShieldAlert,
  ShieldCheck, TimerReset, XCircle, type LucideIcon,
} from 'lucide-react';
import type {
  AuthorityStateV1Schema,
  BlockerV1,
  ConfidenceStateV1Schema,
  FreshnessStateV1Schema,
  LivenessStateV1Schema,
  OperationalStatePacketV1,
  OutcomeStateV1Schema,
  RiskStateV1Schema,
} from '../../../shared/contracts/mission';
import type { z } from 'zod';
import { formatAbsoluteTime, formatRelativeTime } from '../../lib/missionFormat';

export type StateFacet = 'outcome' | 'liveness' | 'risk' | 'confidence' | 'freshness' | 'authority';

export const ALL_STATE_FACETS: readonly StateFacet[] = [
  'outcome', 'liveness', 'risk', 'confidence', 'freshness', 'authority',
];

type Outcome = z.infer<typeof OutcomeStateV1Schema>;
type Liveness = z.infer<typeof LivenessStateV1Schema>;
type Risk = z.infer<typeof RiskStateV1Schema>;
type Confidence = z.infer<typeof ConfidenceStateV1Schema>;
type Freshness = z.infer<typeof FreshnessStateV1Schema>;
type Authority = z.infer<typeof AuthorityStateV1Schema>;

type ChipTone =
  | 'neutral' | 'success' | 'progress' | 'warning' | 'failed' | 'stale'
  | 'active' | 'queued' | 'paused' | 'confidence'
  | 'risk-low' | 'risk-medium' | 'risk-high' | 'risk-critical' | 'unknown';

interface FacetPresentation {
  label: string;
  tone: ChipTone;
  icon: LucideIcon;
}

const OUTCOME_PRESENTATION: Record<Outcome, FacetPresentation> = {
  succeeded: { label: 'Succeeded', tone: 'success', icon: CheckCircle2 },
  failed: { label: 'Failed', tone: 'failed', icon: XCircle },
  cancelled: { label: 'Cancelled', tone: 'stale', icon: Ban },
  partial: { label: 'Partial', tone: 'warning', icon: CircleDot },
  pending: { label: 'Pending', tone: 'progress', icon: Clock3 },
  not_available: { label: 'Not available', tone: 'unknown', icon: MinusCircle },
  unknown: { label: 'Unknown', tone: 'unknown', icon: HelpCircle },
};

const LIVENESS_PRESENTATION: Record<Liveness, FacetPresentation> = {
  running: { label: 'Running', tone: 'active', icon: Activity },
  queued: { label: 'Queued', tone: 'queued', icon: ListPlus },
  paused: { label: 'Paused', tone: 'paused', icon: PauseCircle },
  stalled: { label: 'Stalled', tone: 'warning', icon: OctagonAlert },
  completed: { label: 'Completed', tone: 'success', icon: CheckCircle2 },
  not_started: { label: 'Not started', tone: 'neutral', icon: Circle },
  unknown: { label: 'Unknown', tone: 'unknown', icon: HelpCircle },
};

const RISK_PRESENTATION: Record<Risk, FacetPresentation> = {
  none: { label: 'No known risk', tone: 'risk-low', icon: ShieldCheck },
  low: { label: 'Low risk', tone: 'risk-low', icon: ShieldCheck },
  medium: { label: 'Medium risk', tone: 'risk-medium', icon: ShieldAlert },
  high: { label: 'High risk', tone: 'risk-high', icon: ShieldAlert },
  critical: { label: 'Critical risk', tone: 'risk-critical', icon: ShieldAlert },
  unknown: { label: 'Risk unknown', tone: 'unknown', icon: HelpCircle },
};

const CONFIDENCE_PRESENTATION: Record<Confidence, FacetPresentation> = {
  high: { label: 'High confidence', tone: 'confidence', icon: Circle },
  medium: { label: 'Medium confidence', tone: 'confidence', icon: CircleDot },
  low: { label: 'Low confidence', tone: 'confidence', icon: CircleDashed },
  unknown: { label: 'Confidence unknown', tone: 'unknown', icon: HelpCircle },
};

const FRESHNESS_PRESENTATION: Record<Freshness, FacetPresentation> = {
  fresh: { label: 'Fresh', tone: 'progress', icon: TimerReset },
  aging: { label: 'Aging', tone: 'warning', icon: Hourglass },
  stale: { label: 'Stale', tone: 'stale', icon: History },
  unknown: { label: 'Freshness unknown', tone: 'unknown', icon: HelpCircle },
};

const AUTHORITY_PRESENTATION: Record<Authority, FacetPresentation> = {
  authoritative: { label: 'Authoritative', tone: 'progress', icon: BadgeCheck },
  derived: { label: 'Derived', tone: 'neutral', icon: Layers },
  reported: { label: 'Reported', tone: 'neutral', icon: MessageSquareWarning },
  unverified: { label: 'Unverified', tone: 'warning', icon: ShieldAlert },
  unknown: { label: 'Authority unknown', tone: 'unknown', icon: HelpCircle },
};

const CHANNEL_LABELS: Record<StateFacet, string> = {
  outcome: 'Outcome',
  liveness: 'Liveness',
  risk: 'Risk',
  confidence: 'Confidence',
  freshness: 'Freshness',
  authority: 'Authority',
};

function facetPresentation(packet: OperationalStatePacketV1, facet: StateFacet): FacetPresentation {
  switch (facet) {
    case 'outcome': return OUTCOME_PRESENTATION[packet.outcome];
    case 'liveness': return LIVENESS_PRESENTATION[packet.liveness];
    case 'risk': return RISK_PRESENTATION[packet.risk];
    case 'confidence': return CONFIDENCE_PRESENTATION[packet.confidence];
    case 'freshness': return FRESHNESS_PRESENTATION[packet.freshness];
    case 'authority': return AUTHORITY_PRESENTATION[packet.authority];
  }
}

interface StateChipsProps {
  packet: OperationalStatePacketV1;
  /** Subset of channels to render; defaults to all six in canonical order. */
  facets?: readonly StateFacet[];
}

export default function StateChips({ packet, facets = ALL_STATE_FACETS }: StateChipsProps) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Operational state">
      {facets.map((facet) => {
        const presentation = facetPresentation(packet, facet);
        const Icon = presentation.icon;
        const tone = presentation.tone === 'neutral' ? undefined : presentation.tone;
        return (
          <span
            key={facet}
            className="pk-chip"
            data-facet={facet}
            {...(tone ? { 'data-tone': tone } : {})}
            title={`${CHANNEL_LABELS[facet]}: ${presentation.label}`}
          >
            <Icon size={12} aria-hidden="true" />
            <span className="pk-chip__channel">{CHANNEL_LABELS[facet]}</span>
            <span>{presentation.label}</span>
          </span>
        );
      })}
    </div>
  );
}

interface EvidenceMetaProps {
  packet: OperationalStatePacketV1;
  /** Freshness channel displayed on the packet, when known, ages relative to now. */
  now?: number;
}

/** Source + observation time line. Read-only provenance, never a control. */
export function EvidenceMeta({ packet, now }: EvidenceMetaProps) {
  return (
    <span
      className="pk-meta"
      title={`Observed ${formatAbsoluteTime(packet.observedAt)} · source: ${packet.source.label}`}
    >
      <FileSearch size={12} aria-hidden="true" />
      <span>
        {packet.source.label} · observed {formatRelativeTime(packet.observedAt, now)}
      </span>
    </span>
  );
}

/** Server-authored blocker: code, message, and remediation, never inferred. */
export function BlockerNote({ blocker }: { blocker: BlockerV1 }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-[var(--lc-blocked)]/30 bg-[var(--lc-blocked-bg)] px-3 py-2"
    >
      <OctagonAlert size={14} className="mt-0.5 shrink-0 text-[var(--lc-blocked)]" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-xs font-semibold text-[var(--lc-blocked)]">
          Blocked · <code className="font-mono text-[11px]">{blocker.code}</code>
        </p>
        <p className="mt-0.5 text-xs text-[var(--text)]">{blocker.message}</p>
        <p className="mt-0.5 text-xs text-muted">{blocker.remediation}</p>
      </div>
    </div>
  );
}
