/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, useRef, useMemo, type CSSProperties, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, BookOpen, Trash2, Pencil, Search, Pin, Save, X, Check, Bot, Undo2, Network, ShieldCheck } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import { MEMORY_ANALYTICS_DRILLDOWN_STORAGE_KEY, type MemoryAnalyticsDrilldown } from '../lib/memoryAnalyticsDrilldown';
import SpecRelevanceGraph from '../components/SpecRelevanceGraph';
import { useSpecRelevanceGraph } from '../hooks/useSpecRelevanceGraph';
import { CONTEXT_TRUST_TIERS, CONTEXT_TRUST_TIER_LABELS, type ContextTrustTier } from '../../shared/contracts/trust';

// ─── Types ──────────────────────────────────────────────────────────────────

interface MemoryItem {
  id: number;
  workspaceId: string;
  category: string;
  content: string;
  sourceStoryId: string | null;
  sourceSpecId: string | null;
  sourceRunId: number | null;
  confidence: string;
  relatedFiles: string[];
  pinned: boolean;
  sourceType: string | null;
  createdAt: string;
}

interface MemoryListResponse {
  items: MemoryItem[];
  total: number;
  pinned: number;
  recentRunIds: number[];
  categories: string[];
}

interface MemoryRelationListItem {
  id: number;
  relationType: 'SUPERSEDES' | 'CONFLICTS_WITH';
  status: 'active' | 'superseded' | 'deleted';
  sourceMemoryId: number;
  targetMemoryId: number;
}

interface MemoryRelationsResponse {
  items: MemoryRelationListItem[];
  total: number;
}

type MemoryReviewAction = 'archive' | 'delete' | 'keep' | 'revisit' | 'restore';
type MemoryReviewStatus = 'candidate' | 'kept' | 'revisit' | 'archived' | 'deleted';

interface MemoryReviewReason {
  code: string;
  label: string;
}

interface MemoryReviewItem extends MemoryItem {
  source: string | null;
  sourceRef: string | null;
  updatedAt: string;
  deletedAt: string | null;
  staleScore: number;
  reasons: MemoryReviewReason[];
  status: MemoryReviewStatus;
  lastAction: {
    action: MemoryReviewAction;
    at: string;
    actor: string | null;
    previousStatus: string | null;
    nextStatus: MemoryReviewStatus | null;
  } | null;
}

interface MemoryHotspotItem {
  scopeType: 'file' | 'spec';
  key: string;
  label: string;
  memoryCount: number;
  conflictCount: number;
  supersededCount: number;
  lastTouchedAt: string | null;
  sampleMemoryIds: number[];
}

interface MemoryReviewResponse {
  available: boolean;
  staleCandidates: {
    items: MemoryReviewItem[];
    total: number;
    truncated: boolean;
    heuristics: {
      scanLimit: number;
      resultLimit: number;
      scoreThreshold: number;
      staleAfterDays: number;
      lowConfidenceAfterDays: number;
    };
    ageAvailable: boolean;
    mode: string;
    reason?: string | null;
  };
  provenanceCandidates?: {
    items: MemoryReviewItem[];
    total: number;
    truncated: boolean;
    heuristics: {
      scanLimit: number;
      resultLimit: number;
      scoreThreshold: number;
    };
    mode: string;
    reason?: string | null;
  };
  hotspots: {
    files: MemoryHotspotItem[];
    specs: MemoryHotspotItem[];
    total: number;
    truncated: boolean;
    ageAvailable: boolean;
    mode: string;
    reason?: string | null;
    windowSize: number;
    resultLimit: number;
  };
}

type MemoryPanelSubTab = 'ledger' | 'candidates';
type MemoryCandidateConfidence = 'high' | 'medium' | 'low';
type MemoryCandidateCategory = 'Architecture' | 'Convention' | 'Bug Fix' | 'Decision' | 'Pattern' | 'Gotcha';
type CandidateReviewStatus = 'pending' | 'approved' | 'rejected' | 'superseded' | 'duplicate' | 'conflict' | 'deferred';
type CandidateTargetKind = 'candidate' | 'memory';
type CandidateAction = 'approve' | 'reject' | 'edit-and-approve' | 'duplicate' | 'supersede' | 'conflict' | 'defer';

interface MemoryCandidate {
  id: string;
  workspaceId: string;
  contextEventId: string | null;
  eventType: string | null;
  sourceSystem: string | null;
  sourceRef: string | null;
  actor: string | null;
  occurredAt: string | null;
  suggestedCategory: MemoryCandidateCategory;
  title: string;
  rule: string;
  context: string;
  relatedFiles: string[];
  confidence: MemoryCandidateConfidence;
  trustTier: ContextTrustTier;
  reviewStatus: CandidateReviewStatus;
  reviewer: string | null;
  reviewedAt: string | null;
  promotedMemoryId: number | null;
  promotedAt: string | null;
  provenance: Record<string, unknown>;
  metadata: Record<string, unknown>;
  securitySensitive: boolean;
  regulatedDomain: boolean;
  requiresReview: boolean;
  createdAt: string;
  updatedAt: string;
}

interface MemoryCandidateListResponse {
  items: MemoryCandidate[];
  total: number;
  hasMore?: boolean;
  nextCursor?: string | null;
}

interface CandidateFilePreview {
  path: string;
  fileName: string;
  exists: boolean;
  text: string;
  truncated: boolean;
  byteLength: number;
  maxPreviewBytes: number;
  withinCaptureLimit: boolean;
  redactionApplied: boolean;
  sha256: string | null;
  safety: {
    securitySensitive: boolean;
    regulatedDomain: boolean;
    requiresReview: boolean;
    findings: Array<{ category: string; name: string }>;
  };
}

interface CandidateFilePreviewResponse {
  candidateId: string;
  workspaceId: string;
  preview: CandidateFilePreview;
}

interface CandidateEditDraft {
  suggestedCategory: MemoryCandidateCategory;
  confidence: MemoryCandidateConfidence;
  title: string;
  rule: string;
  context: string;
  relatedFiles: string;
}

interface MemoryOntologyExplanation {
  tone: 'active' | 'suppressed' | 'conflict';
  label: string;
  relatedMemoryId: string;
}

/** Context for viewing a spec/story-centric relevance graph in the split pane. */
interface SpecContextSelection {
  specSlug: string;
  storyId?: string;
  label: string;
}

type MemoryViewMode = 'list' | 'graph' | 'split';

type MemoryGraphNodeType = 'Memory' | 'Story' | 'Spec' | 'File';

type MemoryGraphEdgeType = 'ABOUT' | 'LEARNED_FROM' | 'FROM_SPEC' | 'TOUCHES' | 'BELONGS_TO' | 'DEPENDS_ON' | 'SUPERSEDES' | 'CONFLICTS_WITH';

interface MemoryGraphCaps {
  memories: number;
  stories: number;
  files: number;
  specs: number;
  edges: number;
  dependencies: number;
}

interface MemoryGraphNode {
  id: string;
  type: MemoryGraphNodeType;
  entityId: string;
  label: string;
  selected: boolean;
  category?: string;
  pinned?: boolean;
  storyId?: string;
  specId?: string;
  title?: string;
  path?: string;
}

interface MemoryGraphEdge {
  id: string;
  type: MemoryGraphEdgeType;
  source: string;
  target: string;
}

interface MemoryGraphSummary {
  nodeCount: number;
  edgeCount: number;
  countsByType: Record<string, number>;
  countsByEdgeType: Record<MemoryGraphEdgeType, number>;
  caps?: MemoryGraphCaps;
  truncated: {
    nodes: boolean;
    edges: boolean;
  };
}

interface MemoryGraphSelection {
  selectedMemoryId: string | null;
  suggestedMemoryIds: string[];
  relatedStoryIds: string[];
  relatedSpecIds: string[];
  relatedFilePaths: string[];
}

interface MemoryGraphResponse {
  available: boolean;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  summary: MemoryGraphSummary;
  selection: MemoryGraphSelection;
  error?: string;
  hint?: string;
}

interface FilteredGraphData {
  available: boolean;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  summary: MemoryGraphSummary;
  selection: MemoryGraphSelection;
  error?: string;
  hint?: string;
}

interface PositionedMemoryGraphNode extends MemoryGraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MemoryGraphLayout {
  width: number;
  height: number;
  nodes: PositionedMemoryGraphNode[];
  edges: Array<MemoryGraphEdge & { sourceNode: PositionedMemoryGraphNode; targetNode: PositionedMemoryGraphNode }>;
}

type TokenTone = 'success' | 'warning' | 'error' | 'accent' | 'muted';

const CATEGORIES = ['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha', 'Follow-up', 'Run Synthesis'] as const;

const CATEGORY_COLORS: Record<string, string> = {
  Architecture: 'bg-blue-500/10 text-blue-500',
  Convention: 'bg-purple-500/10 text-purple-500',
  'Bug Fix': 'bg-red-500/10 text-red-500',
  Decision: 'bg-amber-500/10 text-amber-500',
  Pattern: 'bg-emerald-500/10 text-emerald-500',
  Gotcha: 'bg-orange-500/10 text-orange-500',
  'Follow-up': 'bg-amber-500/10 text-amber-500',
  'Run Synthesis': 'bg-cyan-500/10 text-cyan-500',
};

const CONFIDENCE_COLORS: Record<string, string> = {
  high: 'text-emerald-500',
  medium: 'text-amber-500',
  low: 'text-red-400',
};

const SOURCE_TYPES = ['synthesis', 'manual', 'mcp', 'auto-extracted', 'import'] as const;

const SOURCE_TYPE_LABELS: Record<string, string> = {
  synthesis: 'Synthesis',
  manual: 'Manual',
  mcp: 'MCP',
  'auto-extracted': 'Auto-extracted',
  import: 'Import',
};

const SOURCE_TYPE_COLORS: Record<string, string> = {
  synthesis: 'bg-cyan-500/10 text-cyan-500',
  manual: 'bg-violet-500/10 text-violet-500',
  mcp: 'bg-indigo-500/10 text-indigo-500',
  'auto-extracted': 'bg-teal-500/10 text-teal-500',
  import: 'bg-pink-500/10 text-pink-500',
};

const MEMORY_PANEL_TABS: Array<{ id: MemoryPanelSubTab; label: string; description: string }> = [
  { id: 'ledger', label: 'Memories', description: 'Durable approved memory ledger' },
  { id: 'candidates', label: 'Candidates', description: 'Review sidecar-generated memory candidates' },
];

const MEMORY_CANDIDATE_CATEGORIES: MemoryCandidateCategory[] = ['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha'];
const MEMORY_CANDIDATE_CONFIDENCES: MemoryCandidateConfidence[] = ['high', 'medium', 'low'];
const CANDIDATE_REVIEW_STATUSES: CandidateReviewStatus[] = ['pending', 'approved', 'rejected', 'duplicate', 'superseded', 'conflict', 'deferred'];

const CANDIDATE_STATUS_LABELS: Record<CandidateReviewStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  duplicate: 'Duplicate',
  superseded: 'Superseded',
  conflict: 'Conflict',
  deferred: 'Deferred',
};

const CANDIDATE_STATUS_TONES: Record<CandidateReviewStatus, TokenTone> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'error',
  duplicate: 'muted',
  superseded: 'accent',
  conflict: 'error',
  deferred: 'warning',
};

const CANDIDATE_TRUST_TONES: Record<ContextTrustTier, TokenTone> = {
  agent_observation: 'muted',
  working_note: 'warning',
  engineering_decision: 'accent',
  approved_policy: 'success',
  verified_fact: 'success',
};

const VIEW_MODES: Array<{ id: MemoryViewMode; label: string; description: string }> = [
  { id: 'list', label: 'List', description: 'Ledger-first reading view' },
  { id: 'graph', label: 'Graph', description: 'Knowledge Web only' },
  { id: 'split', label: 'Split', description: 'Ledger and Web together' },
];

const GRAPH_NODE_META: Record<MemoryGraphNodeType, { label: string; badgeClass: string; tintClass: string }> = {
  Memory: { label: 'Memories', badgeClass: 'border-blue-500/20 bg-blue-500/10 text-blue-500', tintClass: 'text-blue-500' },
  Story: { label: 'Stories', badgeClass: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500', tintClass: 'text-emerald-500' },
  Spec: { label: 'Specs', badgeClass: 'border-violet-500/20 bg-violet-500/10 text-violet-500', tintClass: 'text-violet-500' },
  File: { label: 'Files', badgeClass: 'border-amber-500/20 bg-amber-500/10 text-amber-500', tintClass: 'text-amber-500' },
};

const GRAPH_EDGE_META: Record<MemoryGraphEdgeType, { label: string; badgeClass: string; tintClass: string; dash: string }> = {
  ABOUT: { label: 'About', badgeClass: 'border-sky-500/20 bg-sky-500/10 text-sky-500', tintClass: 'text-sky-500', dash: '0' },
  LEARNED_FROM: { label: 'Learned from', badgeClass: 'border-teal-500/20 bg-teal-500/10 text-teal-500', tintClass: 'text-teal-500', dash: '8 6' },
  FROM_SPEC: { label: 'From spec', badgeClass: 'border-purple-500/20 bg-purple-500/10 text-purple-500', tintClass: 'text-purple-500', dash: '0' },
  TOUCHES: { label: 'Touches', badgeClass: 'border-amber-500/20 bg-amber-500/10 text-amber-500', tintClass: 'text-amber-500', dash: '4 6' },
  BELONGS_TO: { label: 'Belongs to', badgeClass: 'border-cyan-500/20 bg-cyan-500/10 text-cyan-500', tintClass: 'text-cyan-500', dash: '0' },
  DEPENDS_ON: { label: 'Depends on', badgeClass: 'border-rose-500/20 bg-rose-500/10 text-rose-500', tintClass: 'text-rose-500', dash: '10 5' },
  SUPERSEDES: { label: 'Supersedes', badgeClass: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500', tintClass: 'text-emerald-500', dash: '0' },
  CONFLICTS_WITH: { label: 'Conflicts', badgeClass: 'border-red-500/20 bg-red-500/10 text-red-400', tintClass: 'text-red-400', dash: '2 6' },
};

const GRAPH_TYPE_ORDER: MemoryGraphNodeType[] = ['Memory', 'Story', 'Spec', 'File'];
const GRAPH_EDGE_ORDER: MemoryGraphEdgeType[] = ['ABOUT', 'LEARNED_FROM', 'FROM_SPEC', 'TOUCHES', 'BELONGS_TO', 'DEPENDS_ON', 'SUPERSEDES', 'CONFLICTS_WITH'];
const GRAPH_NODE_SIZES: Record<MemoryGraphNodeType, { width: number; height: number }> = {
  Memory: { width: 182, height: 60 },
  Story: { width: 166, height: 54 },
  Spec: { width: 166, height: 54 },
  File: { width: 190, height: 54 },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function normalizeMemoryText(value: string): string {
  return value
    .replace(/^>\s*/gm, '')
    .replace(/^Rule:\s*/gim, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function splitMemoryContent(value: string): { primary: string; rule: string | null } {
  const marker = value.match(/\n\s*>?\s*Rule:\s*/i);
  if (!marker || marker.index === undefined) return { primary: value, rule: null };

  const primary = value.slice(0, marker.index).trim();
  const rule = value
    .slice(marker.index + marker[0].length)
    .replace(/^>\s?/gm, '')
    .trim();

  if (!primary || !rule || normalizeMemoryText(primary) === normalizeMemoryText(rule)) {
    return { primary: primary || value, rule: null };
  }

  return { primary, rule };
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function tokenBadgeStyle(tone: TokenTone): CSSProperties {
  const token = {
    success: '--color-success',
    warning: '--color-warning',
    error: '--color-error',
    accent: '--accent',
    muted: '--text-muted',
  }[tone];
  const color = `var(${token})`;
  return {
    color,
    borderColor: `color-mix(in srgb, ${color} 32%, transparent)`,
    backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
  };
}

const DISPLAY_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
  [/\b(AKIA[0-9A-Z]{16})\b/g, '[REDACTED]'],
  [/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]'],
  [/((?:api|access|secret|private|auth|refresh)[_-]?(?:key|token|secret|password)\s*[:=]\s*)["']?[^"'\s,;}]+/gi, '$1[REDACTED]'],
];
const DISPLAY_SECRET_KEY_PATTERN = /(api[-_]?key|token|secret|password|credential|authorization|auth)/iu;

function redactDisplayText(value: string): string {
  return DISPLAY_SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function redactDisplayValue(value: unknown): unknown {
  if (typeof value === 'string') return redactDisplayText(value);
  if (Array.isArray(value)) return value.map(redactDisplayValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        DISPLAY_SECRET_KEY_PATTERN.test(key) && typeof item === 'string' ? '[REDACTED]' : redactDisplayValue(item),
      ]),
    );
  }
  return value;
}

function displayCandidateText(value: string | null | undefined, fallback = 'Unknown'): string {
  const normalized = value?.trim();
  return normalized ? redactDisplayText(normalized) : fallback;
}

function formatJson(value: unknown): string {
  if (value == null) return '{}';
  try {
    return JSON.stringify(redactDisplayValue(value), null, 2);
  } catch {
    return String(redactDisplayValue(value));
  }
}

function candidateReviewTime(candidate: MemoryCandidate): string {
  if (candidate.reviewedAt) return new Date(candidate.reviewedAt).toLocaleString();
  return 'Not reviewed yet';
}

function candidateSourceLabel(candidate: MemoryCandidate): string {
  return [candidate.sourceSystem, candidate.sourceRef]
    .map((item) => displayCandidateText(item, ''))
    .filter(Boolean)
    .join(' / ') || 'Unknown source';
}

function createCandidateEditDraft(candidate: MemoryCandidate): CandidateEditDraft {
  return {
    suggestedCategory: candidate.suggestedCategory,
    confidence: candidate.confidence,
    title: redactDisplayText(candidate.title),
    rule: redactDisplayText(candidate.rule),
    context: redactDisplayText(candidate.context),
    relatedFiles: candidate.relatedFiles.join('\n'),
  };
}

function relatedFilesFromDraft(value: string): string[] {
  return unique(value.split(/[\n,]/u).map((item) => item.trim()).filter(Boolean));
}

function formatMemoryOptionLabel(item: MemoryItem): string {
  return `#${item.id} · ${item.category} · ${truncateText(item.content.replace(/\s+/g, ' '), 64)}`;
}

function matchesRelationPair(
  relation: MemoryRelationListItem,
  relationType: MemoryRelationListItem['relationType'],
  sourceMemoryId: number,
  targetMemoryId: number,
): boolean {
  if (relation.relationType !== relationType) return false;
  if (relationType === 'CONFLICTS_WITH') {
    return [relation.sourceMemoryId, relation.targetMemoryId].sort((left, right) => left - right).join(':')
      === [sourceMemoryId, targetMemoryId].sort((left, right) => left - right).join(':');
  }

  return relation.sourceMemoryId === sourceMemoryId && relation.targetMemoryId === targetMemoryId;
}

function buildRelationDraftError(
  relationType: MemoryRelationListItem['relationType'],
  sourceMemoryId: number | null,
  targetMemoryId: number | null,
  relations: MemoryRelationListItem[],
): string | null {
  if (!sourceMemoryId) return 'Select a memory to curate.';
  if (!targetMemoryId) return null;
  if (sourceMemoryId === targetMemoryId) {
    return relationType === 'SUPERSEDES'
      ? 'A memory cannot supersede itself.'
      : 'Memory relations require two distinct memories.';
  }

  const activeRelations = relations.filter((relation) => relation.status === 'active');
  if (activeRelations.some((relation) => matchesRelationPair(relation, relationType, sourceMemoryId, targetMemoryId))) {
    return relationType === 'SUPERSEDES'
      ? 'This supersession is already recorded.'
      : 'These memories already conflict.';
  }

  if (
    relationType === 'SUPERSEDES'
    && activeRelations.some((relation) => matchesRelationPair(relation, 'SUPERSEDES', targetMemoryId, sourceMemoryId))
  ) {
    return 'Archive the existing supersession before reversing it.';
  }

  return null;
}

function describeRelationForSelection(relation: MemoryRelationListItem, selectedMemoryId: number): {
  label: string;
  counterpartId: number;
  tone: MemoryOntologyExplanation['tone'];
} {
  if (relation.relationType === 'SUPERSEDES') {
    if (relation.sourceMemoryId === selectedMemoryId) {
      return {
        label: `Supersedes memory #${relation.targetMemoryId}`,
        counterpartId: relation.targetMemoryId,
        tone: 'active',
      };
    }

    return {
      label: `Superseded by memory #${relation.sourceMemoryId}`,
      counterpartId: relation.sourceMemoryId,
      tone: 'suppressed',
    };
  }

  const counterpartId = relation.sourceMemoryId === selectedMemoryId ? relation.targetMemoryId : relation.sourceMemoryId;
  return {
    label: `Conflicts with memory #${counterpartId}`,
    counterpartId,
    tone: 'conflict',
  };
}

function createEmptyCaps(): MemoryGraphCaps {
  return {
    memories: 0,
    stories: 0,
    files: 0,
    specs: 0,
    edges: 0,
    dependencies: 0,
  };
}

function createEmptySummary(): MemoryGraphSummary {
  return {
    nodeCount: 0,
    edgeCount: 0,
    countsByType: { Memory: 0, Story: 0, Spec: 0, File: 0 },
    countsByEdgeType: { ABOUT: 0, LEARNED_FROM: 0, FROM_SPEC: 0, TOUCHES: 0, BELONGS_TO: 0, DEPENDS_ON: 0, SUPERSEDES: 0, CONFLICTS_WITH: 0 },
    caps: createEmptyCaps(),
    truncated: { nodes: false, edges: false },
  };
}

function summarizeGraph(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  truncated: MemoryGraphSummary['truncated'],
  caps?: MemoryGraphCaps,
): MemoryGraphSummary {
  const summary = createEmptySummary();
  summary.nodeCount = nodes.length;
  summary.edgeCount = edges.length;
  summary.truncated = truncated;
  summary.caps = caps ?? createEmptyCaps();

  for (const node of nodes) {
    summary.countsByType[node.type] = (summary.countsByType[node.type] ?? 0) + 1;
  }

  for (const edge of edges) {
    summary.countsByEdgeType[edge.type] = (summary.countsByEdgeType[edge.type] ?? 0) + 1;
  }

  return summary;
}

function formatGraphCaps(caps?: MemoryGraphCaps): string {
  if (!caps) return 'bounded before rendering';
  return `${caps.memories} memories, ${caps.stories} stories, ${caps.specs} specs, ${caps.files} files, ${caps.edges} edges`;
}

function pushMemoryExplanation(map: Map<string, MemoryOntologyExplanation[]>, memoryId: string, explanation: MemoryOntologyExplanation) {
  const existing = map.get(memoryId) ?? [];
  if (existing.some((item) => item.label === explanation.label)) return;
  map.set(memoryId, [...existing, explanation]);
}

function buildMemoryExplainabilityMap(relations: MemoryRelationListItem[]): Map<string, MemoryOntologyExplanation[]> {
  const map = new Map<string, MemoryOntologyExplanation[]>();

  for (const relation of relations) {
    if (relation.status !== 'active') continue;
    const sourceMemoryId = String(relation.sourceMemoryId);
    const targetMemoryId = String(relation.targetMemoryId);

    if (relation.relationType === 'SUPERSEDES') {
      pushMemoryExplanation(map, sourceMemoryId, {
        tone: 'active',
        label: `Active rule — supersedes memory #${targetMemoryId}`,
        relatedMemoryId: targetMemoryId,
      });
      pushMemoryExplanation(map, targetMemoryId, {
        tone: 'suppressed',
        label: `Superseded by memory #${sourceMemoryId}`,
        relatedMemoryId: sourceMemoryId,
      });
      continue;
    }

    pushMemoryExplanation(map, sourceMemoryId, {
      tone: 'conflict',
      label: `Conflicts with memory #${targetMemoryId}`,
      relatedMemoryId: targetMemoryId,
    });
    pushMemoryExplanation(map, targetMemoryId, {
      tone: 'conflict',
      label: `Conflicts with memory #${sourceMemoryId}`,
      relatedMemoryId: sourceMemoryId,
    });
  }

  return new Map(
    [...map.entries()].map(([memoryId, explanations]) => [
      memoryId,
      explanations.sort((left, right) => {
        const order = { suppressed: 0, conflict: 1, active: 2 } as const;
        return order[left.tone] - order[right.tone] || left.label.localeCompare(right.label);
      }),
    ]),
  );
}

function buildBlastRadiusSummary(graph: FilteredGraphData, selectedMemoryId: string | null) {
  const relatedMemoryIds = graph.nodes
    .filter((node) => node.type === 'Memory' && node.entityId !== selectedMemoryId)
    .map((node) => node.entityId);
  const relatedStoryIds = unique(graph.selection.relatedStoryIds);
  const relatedSpecIds = unique(graph.selection.relatedSpecIds);
  const relatedFilePaths = unique(graph.selection.relatedFilePaths);
  const totalReach = relatedMemoryIds.length + relatedStoryIds.length + relatedSpecIds.length + relatedFilePaths.length;

  if (!selectedMemoryId) {
    return {
      assessment: 'Workspace overview',
      detail: 'Showing the bounded Knowledge Web for the current filtered memory corpus.',
      relatedMemoryIds,
      relatedStoryIds,
      relatedSpecIds,
      relatedFilePaths,
    };
  }

  if (totalReach <= 2) {
    return {
      assessment: 'Focused',
      detail: 'Changes appear tightly scoped around this memory selection.',
      relatedMemoryIds,
      relatedStoryIds,
      relatedSpecIds,
      relatedFilePaths,
    };
  }

  if (totalReach <= 6) {
    return {
      assessment: 'Moderate',
      detail: 'Expect follow-on checks in nearby stories, specs, and files.',
      relatedMemoryIds,
      relatedStoryIds,
      relatedSpecIds,
      relatedFilePaths,
    };
  }

  return {
    assessment: 'Wide',
    detail: 'This memory touches a broad neighborhood; validate the wider surface before shipping.',
    relatedMemoryIds,
    relatedStoryIds,
    relatedSpecIds,
    relatedFilePaths,
  };
}

function sortGraphNodes(nodes: MemoryGraphNode[], selectedMemoryId: string | null): MemoryGraphNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return GRAPH_TYPE_ORDER.indexOf(a.type) - GRAPH_TYPE_ORDER.indexOf(b.type);

    if (a.type === 'Memory' && b.type === 'Memory') {
      if (a.entityId === selectedMemoryId) return -1;
      if (b.entityId === selectedMemoryId) return 1;
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
    }

    const aLabel = a.title ?? a.path ?? a.storyId ?? a.specId ?? a.label;
    const bLabel = b.title ?? b.path ?? b.storyId ?? b.specId ?? b.label;
    return aLabel.localeCompare(bLabel);
  });
}

function buildFilteredGraphData(
  overviewGraph: MemoryGraphResponse | null,
  neighborhoodGraph: MemoryGraphResponse | null,
  filteredItems: MemoryItem[],
  selectedMemoryId: string | null,
): FilteredGraphData | null {
  if (!overviewGraph) return null;
  if (!overviewGraph.available) return overviewGraph;

  const allowedMemoryIds = new Set(filteredItems.map((item) => String(item.id)));
  const selectedAllowed = selectedMemoryId ? allowedMemoryIds.has(selectedMemoryId) : false;
  const nodeMap = new Map<string, MemoryGraphNode>();
  const edgeMap = new Map<string, MemoryGraphEdge>();
  const overviewNodeMap = new Map(overviewGraph.nodes.map((node) => [node.id, node]));
  const neighborhoodNodeMap = new Map((neighborhoodGraph?.nodes ?? []).map((node) => [node.id, node]));
  const allowedMemoryNodeIds = new Set(
    overviewGraph.nodes
      .filter((node) => node.type === 'Memory' && allowedMemoryIds.has(node.entityId))
      .map((node) => node.id),
  );

  const addNode = (node: MemoryGraphNode | undefined) => {
    if (!node) return;
    if (node.type === 'Memory' && !allowedMemoryIds.has(node.entityId)) return;
    nodeMap.set(node.id, node);
  };

  const addEdge = (edge: MemoryGraphEdge) => {
    edgeMap.set(edge.id, edge);
  };

  overviewGraph.nodes
    .filter((node) => node.type === 'Memory' && allowedMemoryIds.has(node.entityId))
    .forEach(addNode);

  for (const edge of overviewGraph.edges) {
    const touchesAllowedMemory = allowedMemoryNodeIds.has(edge.source) || allowedMemoryNodeIds.has(edge.target);
    if (!touchesAllowedMemory) continue;
    addNode(overviewNodeMap.get(edge.source));
    addNode(overviewNodeMap.get(edge.target));
    addEdge(edge);
  }

  if (selectedAllowed && neighborhoodGraph?.available) {
    for (const node of neighborhoodGraph.nodes) addNode(node);
    for (const edge of neighborhoodGraph.edges) {
      addNode(neighborhoodNodeMap.get(edge.source));
      addNode(neighborhoodNodeMap.get(edge.target));
      addEdge(edge);
    }
  }

  const nodes = sortGraphNodes(Array.from(nodeMap.values()), selectedMemoryId);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = Array.from(edgeMap.values()).filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  const selectionSource = selectedAllowed && neighborhoodGraph?.available ? neighborhoodGraph.selection : overviewGraph.selection;
  const selection = {
    selectedMemoryId: selectedAllowed ? selectedMemoryId : null,
    suggestedMemoryIds: unique((overviewGraph.selection.suggestedMemoryIds ?? []).filter((memoryId) => allowedMemoryIds.has(memoryId))),
    relatedStoryIds: unique(selectionSource.relatedStoryIds ?? []),
    relatedSpecIds: unique(selectionSource.relatedSpecIds ?? []),
    relatedFilePaths: unique(selectionSource.relatedFilePaths ?? []),
  };

  return {
    available: true,
    nodes,
    edges,
    selection,
    summary: summarizeGraph(
      nodes,
      edges,
      {
        nodes: overviewGraph.summary.truncated.nodes || Boolean(neighborhoodGraph?.available && neighborhoodGraph.summary.truncated.nodes),
        edges: overviewGraph.summary.truncated.edges || Boolean(neighborhoodGraph?.available && neighborhoodGraph.summary.truncated.edges),
      },
      overviewGraph.summary.caps,
    ),
  };
}

function buildGraphLayout(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], selectedMemoryId: string | null): MemoryGraphLayout {
  const sortedNodes = sortGraphNodes(nodes, selectedMemoryId);
  const grouped = GRAPH_TYPE_ORDER.map((type) => ({
    type,
    nodes: sortedNodes.filter((node) => node.type === type),
  })).filter((group) => group.nodes.length > 0);

  const maxRows = Math.max(...grouped.map((group) => group.nodes.length), 1);
  const width = Math.max(820, grouped.length * 240 + 120);
  const height = Math.max(340, maxRows * 84 + 120);
  const startX = 110;
  const columnGap = grouped.length > 1 ? (width - startX * 2) / (grouped.length - 1) : 0;

  const positionedNodes: PositionedMemoryGraphNode[] = grouped.flatMap((group, columnIndex) => {
    const size = GRAPH_NODE_SIZES[group.type];
    const totalHeight = group.nodes.length * size.height + Math.max(group.nodes.length - 1, 0) * 26;
    const startY = (height - totalHeight) / 2 + size.height / 2;

    return group.nodes.map((node, rowIndex) => ({
      ...node,
      width: size.width,
      height: size.height,
      x: startX + columnIndex * columnGap,
      y: startY + rowIndex * (size.height + 26),
    }));
  });

  const nodeMap = new Map(positionedNodes.map((node) => [node.id, node]));
  const positionedEdges = edges
    .map((edge) => {
      const sourceNode = nodeMap.get(edge.source);
      const targetNode = nodeMap.get(edge.target);
      if (!sourceNode || !targetNode) return null;
      return { ...edge, sourceNode, targetNode };
    })
    .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge));

  return {
    width,
    height,
    nodes: positionedNodes,
    edges: positionedEdges,
  };
}

function edgePath(sourceNode: PositionedMemoryGraphNode, targetNode: PositionedMemoryGraphNode): string {
  const sourceX = sourceNode.x + sourceNode.width / 2 - 12;
  const targetX = targetNode.x - targetNode.width / 2 + 12;
  const sourceY = sourceNode.y;
  const targetY = targetNode.y;

  if (Math.abs(sourceNode.x - targetNode.x) < 8) {
    const bend = sourceNode.width / 2 + 48;
    return [
      `M ${sourceNode.x} ${sourceY}`,
      `C ${sourceNode.x + bend} ${sourceY}, ${targetNode.x + bend} ${targetY}, ${targetNode.x} ${targetY}`,
    ].join(' ');
  }

  const curve = Math.max(48, Math.abs(targetX - sourceX) * 0.35);
  return [
    `M ${sourceX} ${sourceY}`,
    `C ${sourceX + curve} ${sourceY}, ${targetX - curve} ${targetY}, ${targetX} ${targetY}`,
  ].join(' ');
}

function getNodeTitle(node: MemoryGraphNode): string {
  if (node.type === 'Memory') return `Memory #${node.entityId}`;
  if (node.type === 'Story') return node.storyId ?? node.label;
  if (node.type === 'Spec') return node.title ?? node.label;
  return basename(node.path ?? node.label);
}

function getNodeSubtitle(node: MemoryGraphNode, memoryById: Map<string, MemoryItem>): string {
  if (node.type === 'Memory') {
    const memory = memoryById.get(node.entityId);
    return truncateText(memory?.content ?? node.category ?? 'Memory', 38);
  }
  if (node.type === 'Story') return truncateText(node.title ?? node.label, 38);
  if (node.type === 'Spec') return truncateText(node.specId ?? node.label, 38);
  return truncateText(node.path ?? node.label, 38);
}

// ─── Undo Toast ─────────────────────────────────────────────────────────────

function UndoToast({ message, onUndo, onDismiss }: {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 10000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-[var(--text)] px-4 py-2.5 text-xs font-medium text-bg shadow-lg animate-in slide-in-from-bottom-2">
      <span>{message}</span>
      <button
        onClick={onUndo}
        className="inline-flex items-center gap-1 rounded bg-white/20 px-2 py-1 transition-colors hover:bg-white/30"
      >
        <Undo2 size={11} />
        Undo
      </button>
      <button onClick={onDismiss} className="p-0.5 hover:opacity-70">
        <X size={12} />
      </button>
    </div>
  );
}

// ─── Inline Edit Textarea ───────────────────────────────────────────────────

function InlineEditor({ value, onSave, onCancel }: {
  value: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <div className="space-y-2">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        className="w-full resize-y rounded border border-accent/50 bg-bg px-3 py-2 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave(text);
          }
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onSave(text)}
          disabled={!text.trim()}
          className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-accent/90 disabled:opacity-50"
        >
          <Save size={10} />
          Save
        </button>
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] font-medium text-muted hover:bg-surface-200"
        >
          <X size={10} />
          Cancel
        </button>
        <span className="ml-1 text-[9px] text-muted">Cmd+Enter to save</span>
      </div>
    </div>
  );
}

function MemoryRelationPreviewCard({
  label,
  item,
  emptyMessage,
}: {
  label: string;
  item: MemoryItem | null;
  emptyMessage: string;
}) {
  if (!item) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-bg px-3 py-3 text-[11px] text-muted">
        <p className="font-medium text-[var(--text)]">{label}</p>
        <p className="mt-2 leading-relaxed">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-bg px-3 py-3 text-[11px] text-muted">
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="font-medium text-[var(--text)]">{label}</p>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${CATEGORY_COLORS[item.category] ?? 'bg-gray-500/10 text-gray-500'}`}>
          {item.category}
        </span>
        {item.pinned && <Pin size={10} className="fill-amber-500 text-amber-500" />}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-[var(--text)]/80">{truncateText(item.content, 180)}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        <span className="rounded bg-surface-200 px-1.5 py-0.5 text-[10px] text-muted">Memory #{item.id}</span>
        {item.sourceStoryId && <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-500">Story {item.sourceStoryId}</span>}
        {item.sourceSpecId && <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-400">Spec {item.sourceSpecId}</span>}
        {item.sourceRunId && <span className="rounded bg-surface-200 px-1.5 py-0.5 font-mono text-[10px] text-muted">Run #{item.sourceRunId}</span>}
        {item.sourceType && <span className={`rounded px-1.5 py-0.5 text-[10px] ${SOURCE_TYPE_COLORS[item.sourceType] ?? 'bg-gray-500/10 text-gray-500'}`}>{SOURCE_TYPE_LABELS[item.sourceType] ?? item.sourceType}</span>}
      </div>
      {(item.relatedFiles?.length ?? 0) > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {(item.relatedFiles ?? []).slice(0, 3).map((file) => (
            <span key={file} className="rounded bg-surface-200 px-1.5 py-0.5 font-mono text-[10px] text-muted">{file}</span>
          ))}
          {(item.relatedFiles?.length ?? 0) > 3 && (
            <span className="rounded bg-surface-200 px-1.5 py-0.5 text-[10px] text-muted">+{(item.relatedFiles?.length ?? 0) - 3} more</span>
          )}
        </div>
      )}
    </div>
  );
}

function OntologyCurationSection({
  items,
  selectedMemoryId,
  relations,
  targetMemoryId,
  busyKey,
  notice,
  onTargetMemoryChange,
  onCreateRelation,
  onRemoveRelation,
}: {
  items: MemoryItem[];
  selectedMemoryId: string | null;
  relations: MemoryRelationListItem[];
  targetMemoryId: string;
  busyKey: string | null;
  notice: { tone: 'success' | 'error'; message: string } | null;
  onTargetMemoryChange: (memoryId: string) => void;
  onCreateRelation: (relationType: MemoryRelationListItem['relationType']) => void;
  onRemoveRelation: (relationId: number) => void;
}) {
  const selectedMemory = items.find((item) => String(item.id) === selectedMemoryId) ?? null;
  const targetMemory = items.find((item) => String(item.id) === targetMemoryId) ?? null;
  const selectedId = selectedMemory?.id ?? null;
  const targetId = targetMemory?.id ?? null;
  const supersedesError = buildRelationDraftError('SUPERSEDES', selectedId, targetId, relations);
  const conflictError = buildRelationDraftError('CONFLICTS_WITH', selectedId, targetId, relations);
  const activeRelations = selectedId === null
    ? []
    : relations
      .filter((relation) => relation.status === 'active' && (relation.sourceMemoryId === selectedId || relation.targetMemoryId === selectedId))
      .sort((left, right) => left.relationType.localeCompare(right.relationType) || left.id - right.id);
  const candidateTargets = items.filter((item) => item.id !== selectedId);

  return (
    <section className="rounded-xl border border-border bg-surface-100/70 p-3 sm:p-4" aria-label="Ontology curation">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">Ontology curation</h2>
          <p className="mt-0.5 max-w-2xl text-[11px] leading-relaxed text-muted">
            Relate the focused memory to another workspace memory, preserve relation history through soft deletion, and keep the Knowledge Web in sync.
          </p>
        </div>
        {selectedMemory && <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">Focused memory #{selectedMemory.id}</span>}
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="text-[11px] font-medium text-[var(--text)]" htmlFor="ontology-target-memory">Target memory</label>
        <select
          id="ontology-target-memory"
          value={targetMemoryId}
          onChange={(event) => onTargetMemoryChange(event.target.value)}
          aria-label="Target memory"
          disabled={Boolean(busyKey) || candidateTargets.length === 0}
          className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          <option value="">Choose another memory…</option>
          {candidateTargets.map((item) => (
            <option key={item.id} value={item.id}>{formatMemoryOptionLabel(item)}</option>
          ))}
        </select>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <MemoryRelationPreviewCard label="Focused memory" item={selectedMemory} emptyMessage="Select a memory from the ledger or Knowledge Web to start curation." />
        <MemoryRelationPreviewCard label="Target memory" item={targetMemory} emptyMessage="Choose the other memory you want to supersede or mark as conflicting." />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onCreateRelation('SUPERSEDES')}
          disabled={Boolean(busyKey) || !targetMemory || Boolean(supersedesError)}
          className="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Mark as superseding
        </button>
        <button
          type="button"
          onClick={() => onCreateRelation('CONFLICTS_WITH')}
          disabled={Boolean(busyKey) || !targetMemory || Boolean(conflictError)}
          className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Mark conflict
        </button>
      </div>

      <div className="mt-2 space-y-1 text-[11px] text-muted">
        {targetMemory ? (
          <>
            {supersedesError && <p>Supersedes: {supersedesError}</p>}
            {conflictError && conflictError !== supersedesError && <p>Conflicts: {conflictError}</p>}
            {!supersedesError && !conflictError && selectedMemory && (
              <p>Choose supersedes when the focused memory is the newer rule. Choose conflict when both memories must stay visible but cannot both be applied cleanly.</p>
            )}
          </>
        ) : (
          <p>Choose a second memory to compare provenance, spec scope, and file context before adding an ontology edge.</p>
        )}
      </div>

      {notice && (
        <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${notice.tone === 'success' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300' : 'border-red-500/20 bg-red-500/10 text-red-300'}`}>
          {notice.message}
        </div>
      )}

      <div className="mt-4 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Active relations for the focused memory</p>
          <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">{activeRelations.length}</span>
        </div>
        {activeRelations.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-bg px-3 py-2 text-[11px] text-muted">No active supersession or conflict edges recorded for this memory yet.</p>
        ) : (
          <ul className="space-y-2" role="list" aria-label="Active ontology relations">
            {activeRelations.map((relation) => {
              const summary = describeRelationForSelection(relation, selectedId as number);
              const counterpart = items.find((item) => item.id === summary.counterpartId) ?? null;
              const toneClass = {
                active: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
                suppressed: 'border-amber-500/20 bg-amber-500/10 text-amber-400',
                conflict: 'border-red-500/20 bg-red-500/10 text-red-300',
              } as const;

              return (
                <li key={relation.id} className="rounded-lg border border-border bg-bg px-3 py-3 text-[11px] text-muted">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${toneClass[summary.tone]}`}>{summary.label}</span>
                        <span className="rounded-full border border-border bg-surface-100 px-2 py-0.5 text-[10px] text-muted">Relation #{relation.id}</span>
                      </div>
                      {counterpart && (
                        <>
                          <p className="mt-2 text-xs leading-relaxed text-[var(--text)]/80">{truncateText(counterpart.content, 160)}</p>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {counterpart.sourceStoryId && <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-500">Story {counterpart.sourceStoryId}</span>}
                            {counterpart.sourceSpecId && <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-400">Spec {counterpart.sourceSpecId}</span>}
                            {counterpart.relatedFiles.slice(0, 2).map((file) => (
                              <span key={file} className="rounded bg-surface-200 px-1.5 py-0.5 font-mono text-[10px] text-muted">{file}</span>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveRelation(relation.id)}
                      disabled={Boolean(busyKey)}
                      className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-surface-200 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function OntologyCurationDrawer({
  open,
  onClose,
  ...props
}: Parameters<typeof OntologyCurationSection>[0] & {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" role="dialog" aria-modal="true" aria-label="Ontology curation drawer">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="Close ontology curation" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-xl flex-col border-l border-border bg-bg shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-[var(--text)]">Curate memory edge</p>
            <p className="mt-0.5 text-[11px] text-muted">Link this memory only when you are actively resolving precedence or conflict.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-200" aria-label="Close curation drawer">
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <OntologyCurationSection {...props} />
        </div>
      </div>
    </div>
  );
}

function MemoryPanelTabs({ value, onChange }: { value: MemoryPanelSubTab; onChange: (tab: MemoryPanelSubTab) => void }) {
  return (
    <div className="rounded-xl border border-border bg-surface-100/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">Memory workspace</h2>
          <p className="mt-0.5 text-[11px] text-muted">Review durable memories or inspect sidecar-generated candidates before promotion.</p>
        </div>
        <div role="tablist" aria-label="Memory workspace tabs" className="inline-flex rounded-lg border border-border bg-bg p-1">
          {MEMORY_PANEL_TABS.map((tab) => {
            const active = value === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`memory-panel-${tab.id}`}
                id={`memory-panel-tab-${tab.id}`}
                title={tab.description}
                onClick={() => onChange(tab.id)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  active ? 'bg-accent text-white shadow-sm' : 'text-muted hover:bg-surface-200 hover:text-[var(--text)]'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CandidateBadge({ children, tone }: { children: ReactNode; tone: TokenTone }) {
  return (
    <span className="rounded-full border px-2 py-0.5 text-[10px] font-medium" style={tokenBadgeStyle(tone)}>
      {children}
    </span>
  );
}

function MemoryCandidateReviewSection({
  filters,
  candidates,
  total,
  loading,
  error,
  selectedCandidate,
  selectedCandidateId,
  previewPath,
  preview,
  previewLoading,
  previewError,
  editDraft,
  actionNote,
  targetKind,
  targetId,
  deferUntil,
  actionBusy,
  actionNotice,
  onFilterChange,
  onSelectCandidate,
  onPreviewPathChange,
  onEditDraftChange,
  onActionNoteChange,
  onTargetKindChange,
  onTargetIdChange,
  onDeferUntilChange,
  onAction,
  onRetry,
}: {
  filters: { source: string; category: string; confidence: string; trustTier: string; status: string; q: string };
  candidates: MemoryCandidate[];
  total: number;
  loading: boolean;
  error: string | null;
  selectedCandidate: MemoryCandidate | null;
  selectedCandidateId: string | null;
  previewPath: string;
  preview: CandidateFilePreview | null;
  previewLoading: boolean;
  previewError: string | null;
  editDraft: CandidateEditDraft | null;
  actionNote: string;
  targetKind: CandidateTargetKind;
  targetId: string;
  deferUntil: string;
  actionBusy: CandidateAction | null;
  actionNotice: { tone: 'success' | 'error'; message: string } | null;
  onFilterChange: (key: string, value: string) => void;
  onSelectCandidate: (candidateId: string) => void;
  onPreviewPathChange: (path: string) => void;
  onEditDraftChange: (draft: CandidateEditDraft) => void;
  onActionNoteChange: (value: string) => void;
  onTargetKindChange: (value: CandidateTargetKind) => void;
  onTargetIdChange: (value: string) => void;
  onDeferUntilChange: (value: string) => void;
  onAction: (action: CandidateAction) => void;
  onRetry: () => void;
}) {
  const selectedIsApproved = selectedCandidate?.reviewStatus === 'approved';
  const requiresTarget = targetId.trim().length === 0;
  const editDisabled = !editDraft?.title.trim() || !editDraft?.rule.trim() || selectedIsApproved || Boolean(actionBusy);
  const transitionDisabled = !selectedCandidate || selectedIsApproved || Boolean(actionBusy);
  const filteredDescription = `${total} candidate${total === 1 ? '' : 's'} across the current workspace filter`;

  return (
    <section
      id="memory-panel-candidates"
      role="tabpanel"
      aria-labelledby="memory-panel-tab-candidates"
      className="space-y-4"
      aria-label="Memory candidate review"
    >
      <div className="rounded-xl border border-border bg-surface-100/70 p-3 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text)]">Candidate review</h2>
            <p className="mt-0.5 max-w-3xl text-[11px] leading-relaxed text-muted">
              Review sidecar-generated memory candidates with provenance, source metadata, safety flags, and redacted related-file previews before promotion.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
            <span className="rounded-full border border-border bg-bg px-2 py-0.5">{filteredDescription}</span>
            <span className="rounded-full border border-border bg-bg px-2 py-0.5">status: {filters.status || 'all'}</span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-6" role="search" aria-label="Candidate filters">
          <label className="space-y-1 text-[11px] font-medium text-[var(--text)] xl:col-span-2">
            <span>Source</span>
            <input
              value={filters.source}
              onChange={(event) => onFilterChange('candidateSource', event.target.value)}
              placeholder="source system"
              aria-label="Filter candidates by source"
              className="w-full rounded border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </label>
          <label className="space-y-1 text-[11px] font-medium text-[var(--text)]">
            <span>Category</span>
            <select
              value={filters.category}
              onChange={(event) => onFilterChange('candidateCategory', event.target.value)}
              aria-label="Filter candidates by category"
              className="w-full rounded border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
            >
              <option value="">All categories</option>
              {MEMORY_CANDIDATE_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-[11px] font-medium text-[var(--text)]">
            <span>Confidence</span>
            <select
              value={filters.confidence}
              onChange={(event) => onFilterChange('candidateConfidence', event.target.value)}
              aria-label="Filter candidates by confidence"
              className="w-full rounded border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
            >
              <option value="">All confidence</option>
              {MEMORY_CANDIDATE_CONFIDENCES.map((confidence) => <option key={confidence} value={confidence}>{confidence}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-[11px] font-medium text-[var(--text)]">
            <span>Trust tier</span>
            <select
              value={filters.trustTier}
              onChange={(event) => onFilterChange('candidateTrustTier', event.target.value)}
              aria-label="Filter candidates by trust tier"
              className="w-full rounded border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
            >
              <option value="">All trust tiers</option>
              {CONTEXT_TRUST_TIERS.map((tier) => <option key={tier} value={tier}>{CONTEXT_TRUST_TIER_LABELS[tier]}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-[11px] font-medium text-[var(--text)]">
            <span>Review status</span>
            <select
              value={filters.status}
              onChange={(event) => onFilterChange('candidateStatus', event.target.value)}
              aria-label="Filter candidates by review status"
              className="w-full rounded border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
            >
              <option value="all">All statuses</option>
              {CANDIDATE_REVIEW_STATUSES.map((status) => <option key={status} value={status}>{CANDIDATE_STATUS_LABELS[status]}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-[11px] font-medium text-[var(--text)] md:col-span-2 xl:col-span-2">
            <span>Search</span>
            <input
              value={filters.q}
              onChange={(event) => onFilterChange('candidateQ', event.target.value)}
              placeholder="title, rule, or context"
              aria-label="Search candidates"
              className="w-full rounded border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </label>
        </div>
      </div>

      {loading && candidates.length === 0 ? (
        <section className="rounded-xl border border-border bg-surface-100/70 p-4" aria-label="Candidate loading state">
          <div className="flex items-center gap-3 text-xs text-muted">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            <span>Loading memory candidates…</span>
          </div>
        </section>
      ) : null}

      {error ? (
        <section className="rounded-xl border border-border bg-surface-100/70 p-4" aria-label="Candidate error state">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-[var(--text)]">Candidates unavailable</p>
            <button type="button" onClick={onRetry} className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:bg-surface-200">Retry</button>
          </div>
          <p className="mt-2 rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">{error}</p>
        </section>
      ) : null}

      {!loading && !error && candidates.length === 0 ? (
        <section className="rounded-xl border border-dashed border-border bg-surface-100/70 p-8 text-center" aria-label="Candidate empty state">
          <BookOpen size={24} className="mx-auto mb-3 text-muted" />
          <p className="text-sm font-semibold text-[var(--text)]">No memory candidates match the current filters</p>
          <p className="mt-1 text-xs text-muted">Rejected and deferred candidates remain visible when the status filter is set to all statuses.</p>
        </section>
      ) : null}

      {candidates.length > 0 ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(280px,0.85fr)_minmax(0,1.15fr)] xl:items-start">
          <section className="rounded-xl border border-border bg-surface-100/70 p-3 sm:p-4" aria-label="Candidate list">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-[var(--text)]">Review queue</h3>
                <p className="mt-0.5 text-[11px] text-muted">Default view includes reviewed candidates for auditability.</p>
              </div>
              {loading && <span className="text-[10px] text-muted">Refreshing…</span>}
            </div>
            <ul role="list" aria-label="Memory candidate review queue" className="space-y-2">
              {candidates.map((candidate) => {
                const selected = candidate.id === selectedCandidateId;
                return (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      onClick={() => onSelectCandidate(candidate.id)}
                      aria-pressed={selected}
                      className={`w-full rounded-lg border p-3 text-left transition-colors ${selected ? 'border-accent bg-accent/5' : 'border-border bg-bg hover:bg-surface-200'}`}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <CandidateBadge tone={CANDIDATE_STATUS_TONES[candidate.reviewStatus]}>{CANDIDATE_STATUS_LABELS[candidate.reviewStatus]}</CandidateBadge>
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${CATEGORY_COLORS[candidate.suggestedCategory] ?? 'bg-surface-200 text-muted'}`}>{candidate.suggestedCategory}</span>
                        <CandidateBadge tone={candidate.confidence === 'high' ? 'success' : candidate.confidence === 'medium' ? 'warning' : 'error'}>{candidate.confidence}</CandidateBadge>
                        <CandidateBadge tone={CANDIDATE_TRUST_TONES[candidate.trustTier]}>{CONTEXT_TRUST_TIER_LABELS[candidate.trustTier]}</CandidateBadge>
                      </div>
                      <p className="mt-2 text-xs font-semibold text-[var(--text)]">{redactDisplayText(candidate.title)}</p>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted">{redactDisplayText(candidate.rule)}</p>
                      <div className="mt-2 flex flex-wrap gap-1 text-[10px] text-muted">
                        <span className="rounded bg-surface-200 px-1.5 py-0.5">#{candidate.id}</span>
                        <span className="rounded bg-surface-200 px-1.5 py-0.5">{candidateSourceLabel(candidate)}</span>
                        {candidate.promotedMemoryId && <span className="rounded bg-surface-200 px-1.5 py-0.5">Memory #{candidate.promotedMemoryId}</span>}
                        {(candidate.securitySensitive || candidate.regulatedDomain || candidate.requiresReview) && (
                          <span className="inline-flex items-center gap-1 rounded bg-surface-200 px-1.5 py-0.5"><ShieldCheck size={10} /> review flags</span>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="rounded-xl border border-border bg-surface-100/70 p-3 sm:p-4" aria-label="Memory candidate detail">
            {selectedCandidate && editDraft ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <CandidateBadge tone={CANDIDATE_STATUS_TONES[selectedCandidate.reviewStatus]}>{CANDIDATE_STATUS_LABELS[selectedCandidate.reviewStatus]}</CandidateBadge>
                      <CandidateBadge tone={selectedCandidate.confidence === 'high' ? 'success' : selectedCandidate.confidence === 'medium' ? 'warning' : 'error'}>confidence {selectedCandidate.confidence}</CandidateBadge>
                      <CandidateBadge tone={CANDIDATE_TRUST_TONES[selectedCandidate.trustTier]}>{CONTEXT_TRUST_TIER_LABELS[selectedCandidate.trustTier]}</CandidateBadge>
                      {selectedCandidate.promotedMemoryId && <CandidateBadge tone="success">Promoted memory #{selectedCandidate.promotedMemoryId}</CandidateBadge>}
                    </div>
                    <h3 className="mt-2 text-base font-semibold text-[var(--text)]">{redactDisplayText(selectedCandidate.title)}</h3>
                    <p className="mt-1 text-[11px] text-muted">Candidate #{selectedCandidate.id} · {candidateReviewTime(selectedCandidate)}</p>
                  </div>
                </div>

                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="rounded-lg border border-border bg-bg p-3">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-muted">Rule</p>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[var(--text)]">{redactDisplayText(selectedCandidate.rule)}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-bg p-3">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-muted">Context</p>
                    <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[var(--text)]/85">{displayCandidateText(selectedCandidate.context, 'No additional context provided.')}</p>
                  </div>
                </div>

                <div className="grid gap-3 lg:grid-cols-3">
                  <div className="rounded-lg border border-border bg-bg p-3 text-[11px] text-muted">
                    <p className="font-medium text-[var(--text)]">Source metadata</p>
                    <dl className="mt-2 space-y-1">
                      <div><dt className="inline text-muted">System:</dt> <dd className="inline text-[var(--text)]">{displayCandidateText(selectedCandidate.sourceSystem)}</dd></div>
                      <div><dt className="inline text-muted">Ref:</dt> <dd className="inline break-all text-[var(--text)]">{displayCandidateText(selectedCandidate.sourceRef)}</dd></div>
                      <div><dt className="inline text-muted">Event:</dt> <dd className="inline text-[var(--text)]">{displayCandidateText(selectedCandidate.eventType, 'None')}</dd></div>
                      <div><dt className="inline text-muted">Actor:</dt> <dd className="inline text-[var(--text)]">{displayCandidateText(selectedCandidate.actor)}</dd></div>
                      <div><dt className="inline text-muted">Occurred:</dt> <dd className="inline text-[var(--text)]">{selectedCandidate.occurredAt ? new Date(selectedCandidate.occurredAt).toLocaleString() : 'Unknown'}</dd></div>
                    </dl>
                  </div>
                  <div className="rounded-lg border border-border bg-bg p-3 text-[11px] text-muted">
                    <p className="font-medium text-[var(--text)]">Safety flags</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <CandidateBadge tone={selectedCandidate.securitySensitive ? 'error' : 'success'}>{selectedCandidate.securitySensitive ? 'Security sensitive' : 'No secret flag'}</CandidateBadge>
                      <CandidateBadge tone={selectedCandidate.regulatedDomain ? 'warning' : 'success'}>{selectedCandidate.regulatedDomain ? 'Regulated domain' : 'No regulated flag'}</CandidateBadge>
                      <CandidateBadge tone={selectedCandidate.requiresReview ? 'warning' : 'success'}>{selectedCandidate.requiresReview ? 'Review required' : 'Review optional'}</CandidateBadge>
                    </div>
                  </div>
                  <div className="rounded-lg border border-border bg-bg p-3 text-[11px] text-muted">
                    <p className="font-medium text-[var(--text)]">Review audit</p>
                    <p className="mt-2">Reviewer: <span className="text-[var(--text)]">{selectedCandidate.reviewer ?? 'Not reviewed'}</span></p>
                    <p className="mt-1">Reviewed: <span className="text-[var(--text)]">{candidateReviewTime(selectedCandidate)}</span></p>
                    {selectedCandidate.promotedAt && <p className="mt-1">Promoted: <span className="text-[var(--text)]">{new Date(selectedCandidate.promotedAt).toLocaleString()}</span></p>}
                  </div>
                </div>

                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="rounded-lg border border-border bg-bg p-3">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-muted">Provenance</p>
                    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-surface-200 p-2 text-[10px] leading-relaxed text-[var(--text)]/85">{formatJson(selectedCandidate.provenance)}</pre>
                  </div>
                  <div className="rounded-lg border border-border bg-bg p-3">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-muted">Candidate metadata</p>
                    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-surface-200 p-2 text-[10px] leading-relaxed text-[var(--text)]/85">{formatJson(selectedCandidate.metadata)}</pre>
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-bg p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[var(--text)]">Related file previews</p>
                      <p className="mt-0.5 text-[11px] text-muted">Previews are served by the backend and redacted with context-safety before display.</p>
                    </div>
                    <span className="rounded-full border border-border bg-surface-100 px-2 py-0.5 text-[10px] text-muted">{selectedCandidate.relatedFiles.length} files</span>
                  </div>
                  {selectedCandidate.relatedFiles.length === 0 ? (
                    <p className="mt-3 rounded-lg border border-dashed border-border bg-surface-100 px-3 py-2 text-xs text-muted">No related files were attached to this candidate.</p>
                  ) : (
                    <>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {selectedCandidate.relatedFiles.map((file) => (
                          <button
                            key={file}
                            type="button"
                            onClick={() => onPreviewPathChange(file)}
                            className={`rounded border px-2 py-1 font-mono text-[10px] transition-colors ${previewPath === file ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:bg-surface-200'}`}
                          >
                            Preview {file}
                          </button>
                        ))}
                      </div>
                      <div className="mt-3 rounded-lg border border-border bg-surface-100 p-3">
                        {previewLoading ? <p className="text-xs text-muted">Loading safe preview…</p> : null}
                        {previewError ? <p className="text-xs text-error">{previewError}</p> : null}
                        {preview && !previewLoading ? (
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
                              <span className="font-mono text-[var(--text)]">{preview.path}</span>
                              <CandidateBadge tone={preview.redactionApplied ? 'warning' : 'success'}>{preview.redactionApplied ? 'Redaction applied' : 'No redactions reported'}</CandidateBadge>
                              <CandidateBadge tone={preview.safety.securitySensitive ? 'error' : 'success'}>{preview.safety.securitySensitive ? 'Sensitive findings' : 'No sensitive findings'}</CandidateBadge>
                              {preview.truncated && <CandidateBadge tone="warning">Truncated</CandidateBadge>}
                              {!preview.withinCaptureLimit && <CandidateBadge tone="warning">Above capture limit</CandidateBadge>}
                            </div>
                            {preview.safety.findings.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {preview.safety.findings.map((finding) => (
                                  <span key={`${finding.category}:${finding.name}`} className="rounded bg-surface-200 px-1.5 py-0.5 text-[10px] text-muted">{finding.category}: {finding.name}</span>
                                ))}
                              </div>
                            )}
                            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-bg p-3 text-[11px] leading-relaxed text-[var(--text)]/85">{preview.exists ? preview.text : 'File does not exist in the workspace.'}</pre>
                          </div>
                        ) : null}
                      </div>
                    </>
                  )}
                </div>

                <div className="rounded-lg border border-border bg-bg p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[var(--text)]">Operator actions</p>
                      <p className="mt-0.5 text-[11px] text-muted">All mutations use context-candidate backend APIs through apiFetch and keep reviewed candidates auditable.</p>
                    </div>
                    {actionNotice && (
                      <span className="rounded-full border px-2 py-0.5 text-[10px]" style={tokenBadgeStyle(actionNotice.tone === 'success' ? 'success' : 'error')}>{actionNotice.message}</span>
                    )}
                  </div>

                  <div className="mt-3 grid gap-3 lg:grid-cols-2">
                    <div className="space-y-2">
                      <label className="space-y-1 text-[11px] font-medium text-[var(--text)]">
                        <span>Edit title</span>
                        <input value={editDraft.title} onChange={(event) => onEditDraftChange({ ...editDraft, title: event.target.value })} className="w-full rounded border border-border bg-surface-100 px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent" />
                      </label>
                      <label className="space-y-1 text-[11px] font-medium text-[var(--text)]">
                        <span>Edit rule</span>
                        <textarea value={editDraft.rule} onChange={(event) => onEditDraftChange({ ...editDraft, rule: event.target.value })} rows={3} className="w-full rounded border border-border bg-surface-100 px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent" />
                      </label>
                      <label className="space-y-1 text-[11px] font-medium text-[var(--text)]">
                        <span>Edit context</span>
                        <textarea value={editDraft.context} onChange={(event) => onEditDraftChange({ ...editDraft, context: event.target.value })} rows={3} className="w-full rounded border border-border bg-surface-100 px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent" />
                      </label>
                    </div>
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <label className="space-y-1 text-[11px] font-medium text-[var(--text)]">
                          <span>Category</span>
                          <select value={editDraft.suggestedCategory} onChange={(event) => onEditDraftChange({ ...editDraft, suggestedCategory: event.target.value as MemoryCandidateCategory })} className="w-full rounded border border-border bg-surface-100 px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent">
                            {MEMORY_CANDIDATE_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
                          </select>
                        </label>
                        <label className="space-y-1 text-[11px] font-medium text-[var(--text)]">
                          <span>Confidence</span>
                          <select value={editDraft.confidence} onChange={(event) => onEditDraftChange({ ...editDraft, confidence: event.target.value as MemoryCandidateConfidence })} className="w-full rounded border border-border bg-surface-100 px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent">
                            {MEMORY_CANDIDATE_CONFIDENCES.map((confidence) => <option key={confidence} value={confidence}>{confidence}</option>)}
                          </select>
                        </label>
                      </div>
                      <label className="space-y-1 text-[11px] font-medium text-[var(--text)]">
                        <span>Related files (one per line)</span>
                        <textarea value={editDraft.relatedFiles} onChange={(event) => onEditDraftChange({ ...editDraft, relatedFiles: event.target.value })} rows={3} className="w-full rounded border border-border bg-surface-100 px-2 py-1.5 font-mono text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent" />
                      </label>
                      <label className="space-y-1 text-[11px] font-medium text-[var(--text)]">
                        <span>Review reason / note</span>
                        <textarea value={actionNote} onChange={(event) => onActionNoteChange(event.target.value)} rows={2} placeholder="Required for reject; stored for audit actions" className="w-full rounded border border-border bg-surface-100 px-2 py-1.5 text-xs text-[var(--text)] placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent" />
                      </label>
                      <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2">
                        <label className="space-y-1 text-[11px] font-medium text-[var(--text)]">
                          <span>Target kind</span>
                          <select value={targetKind} onChange={(event) => onTargetKindChange(event.target.value as CandidateTargetKind)} className="w-full rounded border border-border bg-surface-100 px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent">
                            <option value="candidate">Candidate</option>
                            <option value="memory">Memory</option>
                          </select>
                        </label>
                        <label className="space-y-1 text-[11px] font-medium text-[var(--text)]">
                          <span>Target ID</span>
                          <input value={targetId} onChange={(event) => onTargetIdChange(event.target.value)} placeholder="Required for duplicate/supersede/conflict" className="w-full rounded border border-border bg-surface-100 px-2 py-1.5 text-xs text-[var(--text)] placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent" />
                        </label>
                      </div>
                      <label className="space-y-1 text-[11px] font-medium text-[var(--text)]">
                        <span>Defer until</span>
                        <input type="datetime-local" value={deferUntil} onChange={(event) => onDeferUntilChange(event.target.value)} className="w-full rounded border border-border bg-surface-100 px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent" />
                      </label>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => onAction('approve')} disabled={transitionDisabled} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60">Approve</button>
                    <button type="button" onClick={() => onAction('edit-and-approve')} disabled={editDisabled} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-[var(--text)] hover:bg-surface-200 disabled:cursor-not-allowed disabled:opacity-60">Edit and approve</button>
                    <button type="button" onClick={() => onAction('reject')} disabled={transitionDisabled || !actionNote.trim()} className="rounded-md border px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60" style={tokenBadgeStyle('error')}>Reject</button>
                    <button type="button" onClick={() => onAction('duplicate')} disabled={transitionDisabled || requiresTarget} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-200 disabled:cursor-not-allowed disabled:opacity-60">Mark duplicate</button>
                    <button type="button" onClick={() => onAction('supersede')} disabled={transitionDisabled || requiresTarget} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-200 disabled:cursor-not-allowed disabled:opacity-60">Mark superseded</button>
                    <button type="button" onClick={() => onAction('conflict')} disabled={transitionDisabled || requiresTarget} className="rounded-md border px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60" style={tokenBadgeStyle('warning')}>Mark conflict</button>
                    <button type="button" onClick={() => onAction('defer')} disabled={transitionDisabled} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-200 disabled:cursor-not-allowed disabled:opacity-60">Defer</button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex min-h-[320px] flex-col items-center justify-center text-center">
                <BookOpen size={24} className="mb-3 text-muted" />
                <p className="text-sm font-medium text-[var(--text)]">Select a candidate to inspect provenance and safe previews</p>
                <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted">Candidate details include title, rule, context, source metadata, review flags, and server-redacted related-file previews.</p>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </section>
  );
}

function ReviewWorkflowSection({
  data,
  loading,
  error,
  busyKey,
  onAction,
  onFocusMemory,
}: {
  data: MemoryReviewResponse | null;
  loading: boolean;
  error: string | null;
  busyKey: string | null;
  onAction: (memoryId: number, action: MemoryReviewAction) => void;
  onFocusMemory: (memoryId: string) => void;
}) {
  const [reviewExpanded, setReviewExpanded] = useState(false);
  const [filterReviewStatus, setFilterReviewStatus] = useState<string>('');
  const [filterReviewCategory, setFilterReviewCategory] = useState<string>('');
  const [filterReviewSourceType, setFilterReviewSourceType] = useState<string>('');
  const [expandedContentIds, setExpandedContentIds] = useState<Set<number>>(new Set());

  if (loading) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 p-3 sm:p-4" aria-label="Stale memory review workflow">
        <div className="flex items-center gap-3 text-xs text-muted">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span>Loading stale-memory review queue…</span>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 p-3 sm:p-4" aria-label="Stale memory review workflow">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text)]">Stale memory review</h2>
              <p className="mt-0.5 text-[11px] text-muted">Review candidates, hotspots, and recoverable memory decisions.</p>
            </div>
            <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">Unavailable</span>
          </div>
          <p className="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">{error}</p>
        </div>
      </section>
    );
  }

  if (!data) return null;

  const provenanceCandidates = data.provenanceCandidates ?? {
    items: [],
    total: 0,
    truncated: false,
    heuristics: { scanLimit: 0, resultLimit: 0, scoreThreshold: 0 },
    mode: 'bounded-sql',
    reason: null,
  };
  const applyReviewFilters = (items: MemoryReviewItem[]) => items.filter((item) => {
    if (filterReviewStatus && item.status !== filterReviewStatus) return false;
    if (filterReviewCategory && item.category !== filterReviewCategory) return false;
    if (filterReviewSourceType && (item.sourceType ?? '') !== filterReviewSourceType) return false;
    return true;
  });
  const queueItems = applyReviewFilters(data.staleCandidates.items.filter((item) => item.status !== 'archived' && item.status !== 'deleted'));
  const provenanceItems = applyReviewFilters(provenanceCandidates.items.filter((item) => item.status !== 'archived' && item.status !== 'deleted'));
  const recoverableItems = applyReviewFilters(data.staleCandidates.items.filter((item) => item.status === 'archived' || item.status === 'deleted'));
  const boundedCopy = `Review queue is intentionally bounded to ${data.staleCandidates.heuristics.scanLimit} low-recency memories and ${data.hotspots.windowSize} recent active memories. Provenance cleanup is separately bounded to ${provenanceCandidates.heuristics.scanLimit} provenance-poor memories.`;
  const statusClass: Record<MemoryReviewStatus, string> = {
    candidate: 'border-amber-500/20 bg-amber-500/10 text-amber-400',
    kept: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
    revisit: 'border-cyan-500/20 bg-cyan-500/10 text-cyan-400',
    archived: 'border-violet-500/20 bg-violet-500/10 text-violet-400',
    deleted: 'border-red-500/20 bg-red-500/10 text-red-300',
  };
  const statusLabel: Record<MemoryReviewStatus, string> = {
    candidate: 'Candidate',
    kept: 'Kept',
    revisit: 'Revisit',
    archived: 'Archived',
    deleted: 'Deleted',
  };
  const trustLabel = (score: number): { label: string; color: string } => {
    if (score >= 70) return { label: 'Critical', color: 'text-red-400' };
    if (score >= 40) return { label: 'Needs review', color: 'text-amber-400' };
    return { label: 'Healthy', color: 'text-emerald-400' };
  };
  const isPromoted = (item: MemoryReviewItem) => item.status === 'kept' && item.lastAction?.action === 'keep';
  const filesHot = data.hotspots.files;
  const specsHot = data.hotspots.specs;
  const hotspotCount = filesHot.length + specsHot.length;
  const ageFallbackReason = data.staleCandidates.reason ?? data.hotspots.reason ?? null;
  const hasActiveReviewWork = queueItems.length > 0 || provenanceItems.length > 0 || recoverableItems.length > 0 || hotspotCount > 0;
  const showExpandedReview = hasActiveReviewWork || reviewExpanded;

  const renderReviewItems = (items: MemoryReviewItem[], listAriaLabel: string) => {
    const CONTENT_LIMIT = 300;
    const RELATED_FILES_SHOWN = 5;
    return (
    <ul className="space-y-3" role="list" aria-label={listAriaLabel}>
      {items.map((item) => {
        const lastActionAt = item.lastAction?.at ? new Date(item.lastAction.at).toLocaleString() : null;
        const occurredAt = new Date(item.createdAt).toLocaleString();
        const contentOverflow = item.content.length > CONTENT_LIMIT;
        const expanded = expandedContentIds.has(item.id);
        const toggleExpanded = () => {
          setExpandedContentIds(prev => {
            const next = new Set(prev);
            if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
            return next;
          });
        };
        const relatedFiles = item.relatedFiles ?? [];
        const shownFiles = relatedFiles.slice(0, RELATED_FILES_SHOWN);
        const hiddenCount = relatedFiles.length - RELATED_FILES_SHOWN;
        const displayContent = contentOverflow && !expanded
          ? item.content.slice(0, CONTENT_LIMIT)
          : item.content;
        return (
          <li key={item.id} className="rounded-lg border border-border bg-bg px-3 py-3 text-[11px] text-muted">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusClass[item.status]}`}>{statusLabel[item.status]}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${CATEGORY_COLORS[item.category] ?? 'bg-gray-500/10 text-gray-500'}`}>{item.category}</span>
                  <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${trustLabel(item.staleScore).color} bg-surface-200`} title={`Stale score: ${item.staleScore} — ${trustLabel(item.staleScore).label}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${trustLabel(item.staleScore).color.replace('text-', 'bg-')}`} />
                    {trustLabel(item.staleScore).label}
                  </span>
                  {item.sourceType && <span className={`rounded px-1.5 py-0.5 text-[10px] ${SOURCE_TYPE_COLORS[item.sourceType] ?? 'bg-gray-500/10 text-gray-500'}`}>{SOURCE_TYPE_LABELS[item.sourceType] ?? item.sourceType}</span>}
                  {isPromoted(item) && (
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500" title="Promoted to live memory">
                      <Check size={9} />
                      Promoted
                    </span>
                  )}
                </div>
                {/* Occurred at (createdAt) — provenance timestamp */}
                <p className="mt-2 text-[10px] text-muted/70">
                  <span className="font-medium text-muted">Occurred:</span> {occurredAt}
                </p>
                {/* Source ref — provenance reference */}
                {item.sourceRef && (
                  <p className="mt-1 text-[10px] text-muted/70">
                    <span className="font-medium text-muted">Source ref:</span>{' '}
                    <span className="font-mono text-[10px] rounded bg-surface-200 px-1 py-0.5">{item.sourceRef}</span>
                  </p>
                )}
                {/* Content with collapse for large payloads */}
                <div className="mt-2">
                  <p className="text-xs leading-relaxed text-[var(--text)]/85 break-words">
                    {displayContent}
                  </p>
                  {contentOverflow && (
                    <div className="mt-1">
                      <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); toggleExpanded(); }}
                        className="text-[10px] font-medium text-accent hover:underline"
                      >
                        {expanded ? 'Show less' : `Show all (${item.content.length} chars)`}
                      </button>
                      {!expanded && (
                        <span className="ml-2 inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 text-[9px] font-medium text-warning" title={`Content truncated at ${CONTENT_LIMIT} character limit`}>
                          <AlertTriangle size={9} />
                          Truncated at {CONTENT_LIMIT} chars
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {/* Changed/related files — with provenance file list */}
                {relatedFiles.length > 0 && (
                  <div className="mt-2">
                    <p className="text-[10px] font-medium text-muted mb-1">
                      Changed files ({relatedFiles.length}):
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {shownFiles.map((file) => (
                        <span key={file} className="rounded bg-surface-200 px-1.5 py-0.5 font-mono text-[10px] text-muted">{file}</span>
                      ))}
                      {hiddenCount > 0 && (
                        <span className="rounded bg-surface-200 px-1.5 py-0.5 font-mono text-[10px] text-muted/60">+{hiddenCount} more</span>
                      )}
                    </div>
                  </div>
                )}
                {/* Provenance source badges */}
                <div className="mt-2 flex flex-wrap gap-1">
                  {item.sourceStoryId && <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-500">Story {item.sourceStoryId}</span>}
                  {item.sourceSpecId && <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-400">Spec {item.sourceSpecId}</span>}
                  {item.sourceRunId && <span className="rounded bg-surface-200 px-1.5 py-0.5 font-mono text-[10px] text-muted">Run #{item.sourceRunId}</span>}
                </div>
                {/* Redaction marker — for items with missing provenance */}
                {!item.sourceStoryId && !item.sourceSpecId && !item.sourceRef && relatedFiles.length === 0 && (
                  <span className="mt-1.5 inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-[9px] font-medium text-red-400" title="No provenance or file context available for this memory">
                    <AlertTriangle size={9} />
                    No provenance
                  </span>
                )}
                <div className="mt-2 flex flex-wrap gap-1">
                  {item.reasons.map((reason) => (
                    <span key={reason.code} className="rounded-full border border-border bg-surface-100 px-2 py-0.5 text-[10px] text-muted">{reason.label}</span>
                  ))}
                </div>
                {lastActionAt && (
                  <p className="mt-2 text-[10px] text-muted">
                    Last review action: {item.lastAction?.action}{item.lastAction?.actor ? ` by ${item.lastAction.actor}` : ''} · {lastActionAt}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-col gap-2">
                <button
                  type="button"
                  onClick={() => onFocusMemory(String(item.id))}
                  className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-surface-200"
                >
                  Focus
                </button>
                <button
                  type="button"
                  onClick={() => onAction(item.id, 'keep')}
                  disabled={busyKey === `review:${item.id}`}
                  className="rounded-md bg-emerald-500 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-emerald-500/90 disabled:opacity-60"
                >
                  Keep
                </button>
                <button
                  type="button"
                  onClick={() => onAction(item.id, 'revisit')}
                  disabled={busyKey === `review:${item.id}`}
                  className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[11px] font-medium text-cyan-300 transition-colors hover:bg-cyan-500/20 disabled:opacity-60"
                >
                  Revisit
                </button>
                <button
                  type="button"
                  onClick={() => onAction(item.id, 'archive')}
                  disabled={busyKey === `review:${item.id}`}
                  className="rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-1 text-[11px] font-medium text-violet-300 transition-colors hover:bg-violet-500/20 disabled:opacity-60"
                >
                  Archive
                </button>
                <button
                  type="button"
                  onClick={() => onAction(item.id, 'delete')}
                  disabled={busyKey === `review:${item.id}`}
                  className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-60"
                >
                  Delete
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
    );
  };

  if (!showExpandedReview) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 px-3 py-2" aria-label="Stale memory review workflow">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-[var(--text)]">Stale memory review</span>
            <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">{queueItems.length} stale</span>
            <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">{provenanceItems.length} provenance</span>
            <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">{recoverableItems.length} recoverable</span>
            <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">{hotspotCount} hotspots</span>
            {ageFallbackReason && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300" title={ageFallbackReason}>
                <AlertTriangle size={10} /> SQL fallback
              </span>
            )}
            {(filterReviewStatus || filterReviewCategory || filterReviewSourceType) && (
              <span className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] text-accent" title="Review filters active">
                Filtered
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setReviewExpanded(true)}
            className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-surface-200"
          >
            Expand
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-border bg-surface-100/70 p-3 sm:p-4" aria-label="Stale memory review workflow">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">Stale memory review</h2>
          <p className="mt-0.5 max-w-2xl text-[11px] leading-relaxed text-muted">Archive or soft-delete stale memories, keep or revisit live ones, restore recoverable decisions, and inspect direct file/spec hotspots before cleanup.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
          <span className="rounded-full border border-border bg-bg px-2 py-0.5">{queueItems.length} in queue</span>
          <span className="rounded-full border border-border bg-bg px-2 py-0.5">{provenanceItems.length} provenance</span>
          <span className="rounded-full border border-border bg-bg px-2 py-0.5">{recoverableItems.length} recoverable</span>
          <span className="rounded-full border border-border bg-bg px-2 py-0.5">{hotspotCount} hotspots</span>
          {ageFallbackReason && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-amber-300" title={ageFallbackReason}>
              <AlertTriangle size={10} /> SQL fallback
            </span>
          )}
          {!hasActiveReviewWork && (
            <button type="button" onClick={() => setReviewExpanded(false)} className="rounded-full border border-border bg-bg px-2 py-0.5 transition-colors hover:bg-surface-200">Collapse</button>
          )}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        <div className="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">{boundedCopy}</div>
      </div>

      {/* Review candidate filters */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={filterReviewStatus}
          onChange={(e) => setFilterReviewStatus(e.target.value)}
          aria-label="Filter review items by status"
          className="rounded border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
        >
          <option value="">All statuses</option>
          {(['candidate', 'kept', 'revisit', 'archived', 'deleted'] as const).map((status) => (
            <option key={status} value={status}>{statusLabel[status]}</option>
          ))}
        </select>

        <select
          value={filterReviewCategory}
          onChange={(e) => setFilterReviewCategory(e.target.value)}
          aria-label="Filter review items by category"
          className="rounded border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
        >
          <option value="">All categories</option>
          {CATEGORIES.map((category) => (
            <option key={category} value={category}>{category}</option>
          ))}
        </select>

        <select
          value={filterReviewSourceType}
          onChange={(e) => setFilterReviewSourceType(e.target.value)}
          aria-label="Filter review items by source type"
          className="rounded border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
        >
          <option value="">All sources</option>
          {SOURCE_TYPES.map((sourceType) => (
            <option key={sourceType} value={sourceType}>{SOURCE_TYPE_LABELS[sourceType]}</option>
          ))}
        </select>

        {(filterReviewStatus || filterReviewCategory || filterReviewSourceType) && (
          <button
            type="button"
            onClick={() => { setFilterReviewStatus(''); setFilterReviewCategory(''); setFilterReviewSourceType(''); }}
            className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-surface-200"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
        <div className="space-y-3">
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Review queue</p>
              <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">{data.staleCandidates.total} items</span>
            </div>
            {queueItems.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border bg-bg px-3 py-3 text-[11px] text-muted">No stale review candidates surfaced inside the current bounded heuristic window.</p>
            ) : (
              renderReviewItems(queueItems, 'Stale memory review queue')
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Provenance cleanup</p>
              <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">{provenanceCandidates.total} items</span>
            </div>
            {provenanceItems.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border bg-bg px-3 py-3 text-[11px] text-muted">No provenance cleanup candidates surfaced inside the current bounded hygiene window.</p>
            ) : (
              renderReviewItems(provenanceItems, 'Provenance cleanup queue')
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Recoverable decisions</p>
              <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">{recoverableItems.length}</span>
            </div>
            {recoverableItems.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border bg-bg px-3 py-3 text-[11px] text-muted">Nothing is archived or soft-deleted from this bounded review window right now.</p>
            ) : (
              <ul className="space-y-2" role="list" aria-label="Recoverable memory decisions">
                {recoverableItems.map((item) => (
                  <li key={item.id} className="rounded-lg border border-border bg-bg px-3 py-3 text-[11px] text-muted">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusClass[item.status]}`}>{statusLabel[item.status]}</span>
                          <span className="rounded bg-surface-200 px-1.5 py-0.5 text-[10px] text-muted">Memory #{item.id}</span>
                          {item.sourceSpecId && <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-400">Spec {item.sourceSpecId}</span>}
                        </div>
                        <p className="mt-2 text-xs leading-relaxed text-[var(--text)]/85">{truncateText(item.content, 180)}</p>
                        {item.lastAction?.at && <p className="mt-2 text-[10px] text-muted">Last action: {item.lastAction.action} · {new Date(item.lastAction.at).toLocaleString()}</p>}
                      </div>
                      <button
                        type="button"
                        onClick={() => onAction(item.id, 'restore')}
                        disabled={busyKey === `review:${item.id}`}
                        className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-60"
                      >
                        <Undo2 size={11} />
                        Restore
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-xl border border-border bg-bg p-3 text-[11px] text-muted">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium text-[var(--text)]">Hotspot files</p>
                <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted">Bounded direct-provenance activity</p>
              </div>
              <span className="rounded-full border border-border bg-surface-100 px-2 py-0.5 text-[10px] text-muted">{filesHot.length}</span>
            </div>
            {filesHot.length === 0 ? (
              <p className="mt-3 text-xs text-muted">No hotspot files surfaced within the current bounded workspace window.</p>
            ) : (
              <ul className="mt-3 space-y-2" role="list" aria-label="Hotspot files">
                {filesHot.map((item) => (
                  <li key={item.key} className="rounded-lg border border-border bg-surface-100/60 px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-[10px] text-[var(--text)]">{item.label}</p>
                        <p className="mt-1 text-[10px] text-muted">{item.memoryCount} memories · {item.conflictCount} conflicts · {item.supersededCount} superseded links</p>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {item.sampleMemoryIds.map((memoryId) => (
                          <button
                            key={memoryId}
                            type="button"
                            onClick={() => onFocusMemory(String(memoryId))}
                            className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-200"
                          >
                            #{memoryId}
                          </button>
                        ))}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-border bg-bg p-3 text-[11px] text-muted">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium text-[var(--text)]">Hotspot specs</p>
                <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted">Specs with repeated memory pressure</p>
              </div>
              <span className="rounded-full border border-border bg-surface-100 px-2 py-0.5 text-[10px] text-muted">{specsHot.length}</span>
            </div>
            {specsHot.length === 0 ? (
              <p className="mt-3 text-xs text-muted">No hotspot specs surfaced within the current bounded workspace window.</p>
            ) : (
              <ul className="mt-3 space-y-2" role="list" aria-label="Hotspot specs">
                {specsHot.map((item) => (
                  <li key={item.key} className="rounded-lg border border-border bg-surface-100/60 px-3 py-2">
                    <p className="text-[11px] font-medium text-[var(--text)]">{item.label}</p>
                    <p className="mt-1 text-[10px] text-muted">{item.memoryCount} memories · {item.conflictCount} conflicts · {item.supersededCount} superseded links</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Entry Row ──────────────────────────────────────────────────────────────

function EntryRow({ item, isSelected, isEditing, isFocused, isSplitMode, explainability, onToggleSelect, onFocus, onEdit, onSaveEdit, onCancelEdit, onDelete, onTogglePin, onCurate }: {
  item: MemoryItem;
  isSelected: boolean;
  isEditing: boolean;
  isFocused: boolean;
  isSplitMode: boolean;
  explainability: MemoryOntologyExplanation[];
  onToggleSelect: () => void;
  onFocus: () => void;
  onEdit: () => void;
  onSaveEdit: (text: string) => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onCurate: () => void;
}) {
  const dateStr = new Date(item.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const contentParts = splitMemoryContent(item.content);

  return (
    <div
      onClick={onFocus}
      className={`group cursor-pointer rounded-lg border p-3 transition-colors ${
        isFocused
          ? `border-accent bg-accent/5 ${isSplitMode ? 'shadow-[0_0_0_1px_var(--accent)]' : ''}`
          : item.pinned
            ? 'border-amber-500/30 bg-amber-500/5'
            : 'border-border hover:bg-surface-200'
      }`}
    >
      <div className="flex items-start gap-2">
        <label className="mt-0.5 shrink-0">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
            className="h-3.5 w-3.5 cursor-pointer rounded border-border text-accent focus:ring-accent/50"
          />
        </label>

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${CATEGORY_COLORS[item.category] ?? 'bg-gray-500/10 text-gray-500'}`}>
              {item.category}
            </span>
            <span className={`text-[10px] font-medium ${CONFIDENCE_COLORS[item.confidence] ?? 'text-muted'}`}>
              {item.confidence}
            </span>
            {item.pinned && <Pin size={10} className="fill-amber-500 text-amber-500" />}
            {item.sourceStoryId && (
              <span className="inline-flex items-center gap-0.5 rounded bg-cyan-500/10 px-1 py-0.5 text-[9px] font-medium text-cyan-500">
                <Bot size={9} />
                {item.sourceStoryId}
              </span>
            )}
            {item.sourceSpecId && (
              <span className="rounded bg-violet-500/10 px-1 py-0.5 text-[9px] font-medium text-violet-400">
                {item.sourceSpecId}
              </span>
            )}
            {item.sourceRunId && <span className="font-mono text-[9px] text-muted">run #{item.sourceRunId}</span>}
            {item.sourceType && (
              <span className={`rounded px-1 py-0.5 text-[9px] font-medium ${SOURCE_TYPE_COLORS[item.sourceType] ?? 'bg-gray-500/10 text-gray-500'}`}>
                {SOURCE_TYPE_LABELS[item.sourceType] ?? item.sourceType}
              </span>
            )}
            {isFocused && (
              <span className="rounded bg-accent/10 px-1 py-0.5 text-[9px] font-medium text-accent">
                {isSplitMode ? 'Active node' : 'Web focus'}
              </span>
            )}
            <span className="ml-auto shrink-0 tabular-nums text-[10px] text-muted">{dateStr}</span>
          </div>

          {isEditing ? (
            <InlineEditor value={item.content} onSave={onSaveEdit} onCancel={onCancelEdit} />
          ) : (
            <div className="space-y-2 text-xs leading-relaxed">
              <p className="whitespace-pre-wrap text-[var(--text)]/85">{contentParts.primary}</p>
              {contentParts.rule && (
                <blockquote className="border-l-2 border-accent/40 pl-2 text-[var(--text)]/75">
                  <span className="font-semibold text-[var(--text)]">Rule:</span> {contentParts.rule}
                </blockquote>
              )}
            </div>
          )}

          {(item.relatedFiles?.length ?? 0) > 0 && !isEditing && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {(item.relatedFiles ?? []).slice(0, 3).map((file) => (
                <span key={file} className="rounded bg-surface-200 px-1 py-0.5 font-mono text-[9px] text-muted">{file}</span>
              ))}
              {(item.relatedFiles?.length ?? 0) > 3 && (
                <span className="text-[9px] text-muted">+{(item.relatedFiles?.length ?? 0) - 3} more</span>
              )}
            </div>
          )}

          {!isEditing && explainability.length > 0 && (
            <div className="mt-2 space-y-1">
              <p className="text-[10px] uppercase tracking-wide text-muted">Ontology</p>
              <OntologyExplanationChips explanations={explainability} />
            </div>
          )}
        </div>

        {!isEditing && (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button onClick={onEdit} className="rounded p-1.5 transition-colors hover:bg-bg" title="Edit content">
              <Pencil size={12} className="text-muted" />
            </button>
            <button
              onClick={onTogglePin}
              className="rounded p-1.5 transition-colors hover:bg-amber-500/10"
              title={item.pinned ? 'Unpin' : 'Pin — always include in prompts'}
            >
              <Pin size={12} className={item.pinned ? 'fill-amber-500 text-amber-500' : 'text-muted'} />
            </button>
            <button
              onClick={(event) => { event.stopPropagation(); onCurate(); }}
              className="rounded px-1.5 py-1 text-[10px] font-medium text-muted transition-colors hover:bg-accent/10 hover:text-accent"
              title="Curate edge"
            >
              Curate
            </button>
            <button onClick={onDelete} className="rounded p-1.5 transition-colors hover:bg-red-500/10" title="Delete">
              <Trash2 size={12} className="text-red-500/60" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Floating Action Bar ────────────────────────────────────────────────────

function BulkActionBar({ count, onDelete, onPin, onClear }: {
  count: number;
  onDelete: () => void;
  onPin: () => void;
  onClear: () => void;
}) {
  if (count === 0) return null;

  return (
    <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg bg-[var(--text)] px-4 py-2 text-xs font-medium text-bg shadow-lg">
      <Check size={12} />
      <span>{count} selected</span>
      <div className="mx-1 h-4 w-px bg-bg/30" />
      <button
        onClick={onDelete}
        className="inline-flex items-center gap-1 rounded bg-red-500/20 px-2 py-1 text-red-300 transition-colors hover:bg-red-500/30"
      >
        <Trash2 size={11} />
        Delete
      </button>
      <button
        onClick={onPin}
        className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-1 text-amber-300 transition-colors hover:bg-amber-500/30"
      >
        <Pin size={11} />
        Pin
      </button>
      <button onClick={onClear} className="p-1 hover:opacity-70">
        <X size={12} />
      </button>
    </div>
  );
}

// ─── View Tabs ──────────────────────────────────────────────────────────────

function ViewModeTabs({ value, graphIssue, onChange }: { value: MemoryViewMode; graphIssue?: string | null; onChange: (mode: MemoryViewMode) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-100/70 p-3">
      <div>
        <h2 className="text-sm font-semibold text-[var(--text)]">Views</h2>
        <p className="mt-0.5 text-[11px] text-muted">Search and filters stay in sync across List, Graph, and Split.</p>
      </div>
      <div role="tablist" aria-label="Memory view modes" className="inline-flex rounded-lg border border-border bg-bg p-1">
        {VIEW_MODES.map((mode) => {
          const active = value === mode.id;
          return (
            <button
              key={mode.id}
              role="tab"
              aria-selected={active}
              aria-controls={`memory-view-${mode.id}`}
              id={`memory-view-tab-${mode.id}`}
              onClick={() => onChange(mode.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                active ? 'bg-accent text-white shadow-sm' : 'text-muted hover:bg-surface-200 hover:text-[var(--text)]'
              }`}
              title={graphIssue && mode.id !== 'list' ? `${mode.description}: ${graphIssue}` : mode.description}
            >
              <span className="inline-flex items-center gap-1">
                {mode.label}
                {graphIssue && mode.id !== 'list' && (
                  <AlertTriangle size={11} className={active ? 'text-white/80' : 'text-amber-400'} aria-hidden="true" />
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Graph View ─────────────────────────────────────────────────────────────

function GraphMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface-100/60 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold text-[var(--text)]">{value}</p>
    </div>
  );
}

function GraphRelationGroup({
  label,
  items,
  renderItem,
}: {
  label: string;
  items: string[];
  renderItem: (item: string) => string;
}) {
  if (items.length === 0) return null;

  const visibleItems = items.slice(0, 4);
  const remaining = items.length - visibleItems.length;

  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {visibleItems.map((item) => (
          <span key={item} className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">
            {renderItem(item)}
          </span>
        ))}
        {remaining > 0 && <span className="rounded-full bg-surface-200 px-2 py-0.5 text-[10px] text-muted">+{remaining} more</span>}
      </div>
    </div>
  );
}

function GraphNotice({ tone = 'default', children }: { tone?: 'default' | 'warning'; children: ReactNode }) {
  const toneClass = tone === 'warning'
    ? 'border-amber-500/30 bg-amber-500/10 text-[var(--text)]'
    : 'border-border bg-bg text-muted';

  return (
    <div className={`rounded-lg border px-3 py-2 text-xs ${toneClass}`}>
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <p className="leading-relaxed">{children}</p>
      </div>
    </div>
  );
}

function OntologyExplanationChips({ explanations, emptyMessage }: { explanations: MemoryOntologyExplanation[]; emptyMessage?: string }) {
  if (explanations.length === 0) {
    return emptyMessage ? <p className="text-[11px] text-muted">{emptyMessage}</p> : null;
  }

  const visible = explanations.slice(0, 2);
  const overflow = explanations.length - visible.length;
  const toneClass = {
    active: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
    suppressed: 'border-amber-500/20 bg-amber-500/10 text-amber-400',
    conflict: 'border-red-500/20 bg-red-500/10 text-red-300',
  } as const;

  return (
    <div className="flex flex-wrap gap-1.5">
      {visible.map((explanation) => (
        <span key={`${explanation.tone}:${explanation.label}`} className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${toneClass[explanation.tone]}`}>
          {explanation.label}
        </span>
      ))}
      {overflow > 0 && <span className="rounded-full bg-surface-200 px-2 py-0.5 text-[10px] text-muted">+{overflow} more</span>}
    </div>
  );
}

function GraphView({
  graph,
  selectedMemoryId,
  selectedExplainability,
  ontologyError,
  onSelectMemory,
  filteredItems,
  memoryById,
  loading,
  overviewGraph,
  overviewError,
  neighborhoodGraph,
  neighborhoodError,
  loadingNeighborhood,
}: {
  graph: FilteredGraphData | null;
  selectedMemoryId: string | null;
  selectedExplainability: MemoryOntologyExplanation[];
  ontologyError: string | null;
  onSelectMemory: (memoryId: string) => void;
  filteredItems: MemoryItem[];
  memoryById: Map<string, MemoryItem>;
  loading: boolean;
  overviewGraph: MemoryGraphResponse | null;
  overviewError: string | null;
  neighborhoodGraph: MemoryGraphResponse | null;
  neighborhoodError: string | null;
  loadingNeighborhood: boolean;
}) {
  const layout = useMemo(() => {
    if (!graph?.available || graph.nodes.length === 0) return null;
    return buildGraphLayout(graph.nodes, graph.edges, selectedMemoryId);
  }, [graph, selectedMemoryId]);

  const presentNodeTypes = GRAPH_TYPE_ORDER.filter((type) => (graph?.summary.countsByType[type] ?? 0) > 0);
  const presentEdgeTypes = GRAPH_EDGE_ORDER.filter((type) => (graph?.summary.countsByEdgeType[type] ?? 0) > 0);
  const suggestedMemoryIds = (graph?.selection.suggestedMemoryIds ?? []).filter((memoryId) => memoryById.has(memoryId));
  const focusedMemory = selectedMemoryId ? memoryById.get(selectedMemoryId) : null;
  const blastRadius = graph?.available ? buildBlastRadiusSummary(graph, selectedMemoryId) : null;
  const overviewBounded = Boolean(overviewGraph?.available && (overviewGraph.summary.truncated.nodes || overviewGraph.summary.truncated.edges));
  const neighborhoodBounded = Boolean(
    selectedMemoryId
    && neighborhoodGraph?.available
    && (neighborhoodGraph.summary.truncated.nodes || neighborhoodGraph.summary.truncated.edges),
  );
  const neighborhoodUnavailableMessage = selectedMemoryId && neighborhoodGraph && !neighborhoodGraph.available
    ? `${neighborhoodGraph.error ?? 'Focused neighborhood unavailable.'}${neighborhoodGraph.hint ? ` ${neighborhoodGraph.hint}` : ''}`
    : neighborhoodError;

  if (loading) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 p-4" aria-label="Knowledge Web graph">
        <div className="flex min-h-[240px] flex-col items-center justify-center text-center">
          <div className="mb-3 h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="text-sm font-medium text-[var(--text)]">Loading Knowledge Web</p>
          <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted">
            Preparing the bounded V1 Knowledge Web from existing ontology edges for this workspace.
          </p>
        </div>
      </section>
    );
  }

  if (!graph && overviewError) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 p-4" aria-label="Knowledge Web graph">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text)]">Knowledge Web</h2>
              <p className="mt-0.5 text-[11px] text-muted">V1 is a bounded Knowledge Web built from existing ontology edges.</p>
            </div>
            <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">Unavailable</span>
          </div>
          <p className="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">{overviewError}</p>
        </div>
      </section>
    );
  }

  if (!graph) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 p-4" aria-label="Knowledge Web graph">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text)]">Knowledge Web</h2>
              <p className="mt-0.5 text-[11px] text-muted">V1 is a bounded Knowledge Web built from existing ontology edges.</p>
            </div>
            <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">Unavailable</span>
          </div>
          <p className="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">Knowledge Web data is unavailable right now.</p>
        </div>
      </section>
    );
  }

  if (!graph.available) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 p-4" aria-label="Knowledge Web graph">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text)]">Knowledge Web</h2>
              <p className="mt-0.5 text-[11px] text-muted">V1 is a bounded Knowledge Web built from existing ontology edges.</p>
            </div>
            <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">Unavailable</span>
          </div>
          <p className="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">
            {graph.error ?? 'Knowledge Web unavailable in lite mode.'}
            {graph.hint ? ` ${graph.hint}` : ''}
          </p>
        </div>
      </section>
    );
  }

  if (filteredItems.length === 0) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 p-4" aria-label="Knowledge Web graph">
        <div className="flex min-h-[240px] flex-col items-center justify-center text-center">
          <BookOpen size={24} className="mb-3 text-muted" />
          <p className="text-sm font-medium text-[var(--text)]">No graph results for the current filters</p>
          <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted">
            Clear or change the search and filters to repopulate the bounded V1 Knowledge Web.
          </p>
        </div>
      </section>
    );
  }

  if (!layout || layout.nodes.length === 0) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 p-4" aria-label="Knowledge Web graph">
        <div className="flex min-h-[240px] flex-col items-center justify-center text-center">
          <BookOpen size={24} className="mb-3 text-muted" />
          <p className="text-sm font-medium text-[var(--text)]">No graph links available yet</p>
          <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted">
            The current bounded selection does not expose existing ontology edges to stories, files, or specs.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-border bg-surface-100/70 p-3 sm:p-4" aria-label="Knowledge Web graph">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">Knowledge Web</h2>
          <p className="mt-0.5 text-[11px] text-muted">V1 is a bounded Knowledge Web built from existing ontology edges and the current filtered memory corpus.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
          <span className="rounded-full border border-border bg-bg px-2 py-0.5">{graph.summary.nodeCount} nodes</span>
          <span className="rounded-full border border-border bg-bg px-2 py-0.5">{graph.summary.edgeCount} edges</span>
          {graph.summary.truncated.nodes || graph.summary.truncated.edges ? (
            <span className="rounded-full border border-border bg-bg px-2 py-0.5">bounded</span>
          ) : null}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {overviewBounded && (
          <GraphNotice tone="warning">
            Workspace overview is intentionally capped before rendering at {formatGraphCaps(overviewGraph?.summary.caps)} so large workspaces stay responsive.
          </GraphNotice>
        )}
        {neighborhoodBounded && (
          <GraphNotice tone="warning">
            Focused neighborhood is intentionally capped before rendering at {formatGraphCaps(neighborhoodGraph?.summary.caps)} for the current selection.
          </GraphNotice>
        )}
        {neighborhoodUnavailableMessage && (
          <GraphNotice>
            Focused neighborhood unavailable; showing the bounded workspace overview for this selection. {neighborhoodUnavailableMessage}
          </GraphNotice>
        )}
        {ontologyError && (
          <GraphNotice>
            Ontology explanations unavailable; showing graph topology without precedence summaries. {ontologyError}
          </GraphNotice>
        )}
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px] xl:items-start">
        <div className="flex flex-wrap gap-1.5">
          {presentNodeTypes.map((type) => (
            <span key={type} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${GRAPH_NODE_META[type].badgeClass}`}>
              {GRAPH_NODE_META[type].label} {graph.summary.countsByType[type]}
            </span>
          ))}
          {presentEdgeTypes.map((type) => (
            <span key={type} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${GRAPH_EDGE_META[type].badgeClass}`}>
              {GRAPH_EDGE_META[type].label} {graph.summary.countsByEdgeType[type]}
            </span>
          ))}
        </div>

        <div className="rounded-xl border border-border bg-bg p-3 text-[11px] text-muted" aria-label="Blast radius summary">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium text-[var(--text)]">Blast radius</p>
              <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted">
                {selectedMemoryId ? `Centered on memory #${selectedMemoryId}` : 'Workspace overview'}
              </p>
            </div>
            <span className="rounded-full border border-border bg-surface-100 px-2 py-0.5 text-[10px] font-medium text-[var(--text)]">
              {blastRadius?.assessment ?? 'Unknown'}
            </span>
          </div>

          <p className="mt-2 leading-relaxed">
            {focusedMemory
              ? truncateText(focusedMemory.content, 120)
              : 'Select a memory from the ledger or graph to inspect its bounded neighborhood.'}
          </p>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <GraphMetric label="Related memories" value={blastRadius?.relatedMemoryIds.length ?? 0} />
            <GraphMetric label="Related stories" value={blastRadius?.relatedStoryIds.length ?? 0} />
            <GraphMetric label="Related specs" value={blastRadius?.relatedSpecIds.length ?? 0} />
            <GraphMetric label="Related files" value={blastRadius?.relatedFilePaths.length ?? 0} />
          </div>

          <p className="mt-3 text-xs leading-relaxed text-muted">{blastRadius?.detail}</p>

          <div className="mt-3 space-y-2">
            <p className="text-[10px] uppercase tracking-wide text-muted">Ontology</p>
            <OntologyExplanationChips
              explanations={selectedExplainability}
              emptyMessage={selectedMemoryId ? 'No supersession or conflict edges recorded for this memory.' : 'Select a memory to inspect ontology precedence and conflicts.'}
            />
          </div>

          <div className="mt-3 space-y-3">
            <GraphRelationGroup label="Related memories" items={blastRadius?.relatedMemoryIds ?? []} renderItem={(memoryId) => `Memory #${memoryId}`} />
            <GraphRelationGroup label="Related stories" items={blastRadius?.relatedStoryIds ?? []} renderItem={(storyId) => `Story ${storyId}`} />
            <GraphRelationGroup label="Related specs" items={blastRadius?.relatedSpecIds ?? []} renderItem={(specId) => `Spec ${specId}`} />
            <GraphRelationGroup label="Related files" items={blastRadius?.relatedFilePaths ?? []} renderItem={(path) => basename(path)} />
          </div>

          {(blastRadius?.relatedMemoryIds.length ?? 0) === 0
            && (blastRadius?.relatedStoryIds.length ?? 0) === 0
            && (blastRadius?.relatedSpecIds.length ?? 0) === 0
            && (blastRadius?.relatedFilePaths.length ?? 0) === 0 && (
              <p className="mt-3 text-xs text-muted">No related memories, stories, specs, or files were surfaced for this bounded selection.</p>
          )}

          {loadingNeighborhood && selectedMemoryId && <p className="mt-3 text-[10px] text-muted">Refreshing focused neighborhood…</p>}
        </div>
      </div>

      {suggestedMemoryIds.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted">Suggested</span>
          {suggestedMemoryIds.slice(0, 6).map((memoryId) => (
            <button
              key={memoryId}
              onClick={() => onSelectMemory(memoryId)}
              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                selectedMemoryId === memoryId
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-muted hover:bg-surface-200'
              }`}
            >
              Memory #{memoryId}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 rounded-xl border border-border bg-bg p-2 sm:p-3">
        <div className="overflow-hidden rounded-lg border border-border/70 bg-surface-100/50">
          <svg
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="h-[320px] w-full sm:h-[400px]"
            role="img"
            aria-label="Knowledge Web graph canvas"
            preserveAspectRatio="xMidYMid meet"
          >
            <defs>
              <marker id="memory-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" className="text-muted" />
              </marker>
            </defs>

            {layout.edges.map((edge) => {
              const edgeMeta = GRAPH_EDGE_META[edge.type];
              return (
                <path
                  key={edge.id}
                  d={edgePath(edge.sourceNode, edge.targetNode)}
                  className={edgeMeta.tintClass}
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeDasharray={edgeMeta.dash === '0' ? undefined : edgeMeta.dash}
                  strokeLinecap="round"
                  fill="none"
                  opacity={0.8}
                  markerEnd="url(#memory-graph-arrow)"
                />
              );
            })}

            {layout.nodes.map((node) => {
              const meta = GRAPH_NODE_META[node.type];
              const title = truncateText(getNodeTitle(node), 26);
              const subtitle = getNodeSubtitle(node, memoryById);
              const selected = node.type === 'Memory' && selectedMemoryId === node.entityId;
              const clickable = node.type === 'Memory';
              const radius = node.type === 'Memory' ? 16 : 14;

              return (
                <g
                  key={node.id}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  aria-label={clickable ? `Focus memory ${node.entityId} from graph` : undefined}
                  aria-pressed={clickable ? selected : undefined}
                  className={clickable ? 'cursor-pointer' : undefined}
                  onClick={() => {
                    if (clickable) onSelectMemory(node.entityId);
                  }}
                  onKeyDown={(event) => {
                    if (!clickable) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelectMemory(node.entityId);
                    }
                  }}
                >
                  {selected && (
                    <rect
                      x={node.x - node.width / 2 - 4}
                      y={node.y - node.height / 2 - 4}
                      width={node.width + 8}
                      height={node.height + 8}
                      rx={radius + 2}
                      fill="none"
                      stroke="var(--accent)"
                      strokeWidth={3}
                    />
                  )}

                  <rect
                    x={node.x - node.width / 2}
                    y={node.y - node.height / 2}
                    width={node.width}
                    height={node.height}
                    rx={radius}
                    className={meta.tintClass}
                    fill="currentColor"
                    fillOpacity={0.12}
                    stroke="currentColor"
                    strokeWidth={selected ? 2.5 : 1.5}
                  />

                  {node.pinned && (
                    <circle
                      cx={node.x + node.width / 2 - 14}
                      cy={node.y - node.height / 2 + 14}
                      r={4}
                      className="fill-amber-500"
                    />
                  )}

                  <text x={node.x - node.width / 2 + 12} y={node.y - 4} fontSize={11} fontWeight={600} fill="var(--text)">
                    {title}
                  </text>
                  <text x={node.x - node.width / 2 + 12} y={node.y + 12} fontSize={10} fill="var(--text-muted)">
                    {truncateText(subtitle, 32)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-[10px] text-muted">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-accent" />
          <span>Selected memory</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
          <span>Pinned memory</span>
        </div>
        <span>Tap any memory node to sync the ledger selection without mutating the ledger state.</span>
      </div>
    </section>
  );
}

// ─── Entries Section ────────────────────────────────────────────────────────

function EntriesSection({
  filteredItems,
  totalCount,
  selectedIds,
  editingId,
  selectedMemoryId,
  explainabilityByMemory,
  onToggleSelect,
  onFocusMemory,
  onEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onTogglePin,
  onCurateMemory,
  compact,
}: {
  filteredItems: MemoryItem[];
  totalCount: number;
  selectedIds: Set<number>;
  editingId: number | null;
  selectedMemoryId: string | null;
  explainabilityByMemory: Map<string, MemoryOntologyExplanation[]>;
  onToggleSelect: (id: number) => void;
  onFocusMemory: (memoryId: string) => void;
  onEdit: (id: number) => void;
  onSaveEdit: (id: number, content: string) => void;
  onCancelEdit: () => void;
  onDelete: (id: number) => void;
  onTogglePin: (item: MemoryItem) => void;
  onCurateMemory: (memoryId: string) => void;
  compact: boolean;
}) {
  const content = filteredItems.length === 0 ? (
    <li role="listitem" className="py-12 text-center">
      {totalCount === 0 ? (
        <div className="mx-auto flex max-w-[400px] flex-col items-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10">
            <BookOpen size={28} className="text-accent" />
          </div>
          <h3 className="mb-1.5 text-base font-semibold text-[var(--text)]">No memory entries yet</h3>
          <p className="text-sm leading-relaxed text-muted">
            Memory entries are created automatically as specs run. They capture patterns, conventions, and decisions learned from each story.
          </p>
        </div>
      ) : (
        <>
          <BookOpen size={24} className="mx-auto mb-3 text-muted" />
          <p className="text-sm text-muted">No entries match your filters.</p>
        </>
      )}
    </li>
  ) : (
    filteredItems.map((item) => (
      <li key={item.id} role="listitem">
        <EntryRow
          item={item}
          isSelected={selectedIds.has(item.id)}
          isEditing={editingId === item.id}
          isFocused={selectedMemoryId === String(item.id)}
          isSplitMode={compact}
          explainability={explainabilityByMemory.get(String(item.id)) ?? []}
          onToggleSelect={() => onToggleSelect(item.id)}
          onFocus={() => onFocusMemory(String(item.id))}
          onEdit={() => onEdit(item.id)}
          onSaveEdit={(text) => onSaveEdit(item.id, text)}
          onCancelEdit={onCancelEdit}
          onDelete={() => onDelete(item.id)}
          onTogglePin={() => onTogglePin(item)}
          onCurate={() => onCurateMemory(String(item.id))}
        />
      </li>
    ))
  );

  if (!compact) {
    return <ul role="list" aria-label="Memory entries" className="space-y-2">{content}</ul>;
  }

  return (
    <section className="rounded-xl border border-border bg-surface-100/70 p-3 sm:p-4" aria-label="Memory ledger list">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">Ledger</h2>
          <p className="mt-0.5 text-[11px] text-muted">The same filtered memory list, kept in sync with the graph selection.</p>
        </div>
        <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">
          {filteredItems.length} shown
        </span>
      </div>
      <ul role="list" aria-label="Memory entries" className="space-y-2">{content}</ul>
    </section>
  );
}

// ─── Spec Relevance Graph Pane ──────────────────────────────────────────────

function SpecRelevanceGraphPane({
  data,
  state,
  error,
  onNodeClick,
}: {
  data: import('../types/spec-relevance-graph').SpecRelevanceGraphResponse | null;
  state: import('../types/spec-relevance-graph').GraphLoadingState;
  error: string | null;
  onNodeClick: (memoryEntityId: string) => void;
}) {
  const handleNodeAction = useCallback((node: import('../types/spec-relevance-graph').PositionedNode) => {
    if (node.type === 'memory') {
      onNodeClick(node.entityId);
    }
  }, [onNodeClick]);

  return (
    <section
      className="rounded-xl border border-border bg-surface-100/70 p-4"
      aria-label="Spec relevance graph"
      data-testid="spec-relevance-graph-pane"
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text)]">Spec Relevance Graph</h2>
            <p className="mt-0.5 text-[11px] text-muted">
              Shows how memories attach to this spec context.
            </p>
          </div>
          <span className="rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-500">
            Spec context
          </span>
        </div>

        <SpecRelevanceGraph data={data} state={state} error={error} onNodeClick={handleNodeAction} />

        {/* Node action hints */}
        {state === 'ready' || state === 'partial' ? (
          <div className="flex flex-wrap gap-2 text-[10px] text-muted">
            <span>Focus a memory node to view details.</span>
            <span>Click a memory node to jump to its ledger entry.</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// ─── Main Panel ─────────────────────────────────────────────────────────────

export default function MemoryPanel() {
  const { workspaceId } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const activePanelTab: MemoryPanelSubTab = searchParams.get('memoryTab') === 'candidates' ? 'candidates' : 'ledger';
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [pinnedCount, setPinnedCount] = useState(0);
  const [recentRunIds, setRecentRunIds] = useState<number[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Candidate review
  const [candidateItems, setCandidateItems] = useState<MemoryCandidate[]>([]);
  const [candidateTotal, setCandidateTotal] = useState(0);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [candidatePreviewPath, setCandidatePreviewPath] = useState('');
  const [candidatePreview, setCandidatePreview] = useState<CandidateFilePreview | null>(null);
  const [candidatePreviewLoading, setCandidatePreviewLoading] = useState(false);
  const [candidatePreviewError, setCandidatePreviewError] = useState<string | null>(null);
  const [candidateEditDraft, setCandidateEditDraft] = useState<CandidateEditDraft | null>(null);
  const [candidateActionNote, setCandidateActionNote] = useState('');
  const [candidateTargetKind, setCandidateTargetKind] = useState<CandidateTargetKind>('candidate');
  const [candidateTargetId, setCandidateTargetId] = useState('');
  const [candidateDeferUntil, setCandidateDeferUntil] = useState('');
  const [candidateActionBusy, setCandidateActionBusy] = useState<CandidateAction | null>(null);
  const [candidateActionNotice, setCandidateActionNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  // Filters
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [filterConfidence, setFilterConfidence] = useState<string>('');
  const [filterRunId, setFilterRunId] = useState<string>('');
  const [filterSourceType, setFilterSourceType] = useState<string>('');
  const [searchInput, setSearchInput] = useState('');
  const [searchText, setSearchText] = useState('');
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // View state
  const [viewMode, setViewMode] = useState<MemoryViewMode>('list');

  // Knowledge Web
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [selectedSpecContext, setSelectedSpecContext] = useState<SpecContextSelection | null>(null);
  const [overviewGraph, setOverviewGraph] = useState<MemoryGraphResponse | null>(null);
  const [neighborhoodGraph, setNeighborhoodGraph] = useState<MemoryGraphResponse | null>(null);
  const [overviewGraphLoading, setOverviewGraphLoading] = useState(false);
  const [neighborhoodGraphLoading, setNeighborhoodGraphLoading] = useState(false);
  const [overviewGraphError, setOverviewGraphError] = useState<string | null>(null);
  const [neighborhoodGraphError, setNeighborhoodGraphError] = useState<string | null>(null);
  const [relations, setRelations] = useState<MemoryRelationListItem[]>([]);
  const [relationsError, setRelationsError] = useState<string | null>(null);
  const [targetMemoryId, setTargetMemoryId] = useState('');
  const [relationMutationKey, setRelationMutationKey] = useState<string | null>(null);
  const [relationNotice, setRelationNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [curationOpen, setCurationOpen] = useState(false);
  const [reviewData, setReviewData] = useState<MemoryReviewResponse | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewBusyKey, setReviewBusyKey] = useState<string | null>(null);
  const [analyticsDrilldown, setAnalyticsDrilldown] = useState<MemoryAnalyticsDrilldown | null>(null);
  const [analyticsDrilldownActive, setAnalyticsDrilldownActive] = useState(false);

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Editing
  const [editingId, setEditingId] = useState<number | null>(null);

  // Undo
  const [undoState, setUndoState] = useState<{ id: number; message: string } | null>(null);

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  useEffect(() => {
    setFilterCategory('');
    setFilterConfidence('');
    setFilterRunId('');
    setFilterSourceType('');
    setSearchInput('');
    setSearchText('');
    setViewMode('list');
    setSelectedMemoryId(null);
    setSelectedSpecContext(null);
    setOverviewGraph(null);
    setNeighborhoodGraph(null);
    setOverviewGraphError(null);
    setNeighborhoodGraphError(null);
    setSelectedIds(new Set());
    setEditingId(null);
    setRelations([]);
    setRelationsError(null);
    setTargetMemoryId('');
    setRelationMutationKey(null);
    setRelationNotice(null);
    setCurationOpen(false);
    setReviewData(null);
    setReviewLoading(false);
    setReviewError(null);
    setReviewBusyKey(null);
    setAnalyticsDrilldown(null);
    setAnalyticsDrilldownActive(false);
    setCandidateItems([]);
    setCandidateTotal(0);
    setCandidateLoading(false);
    setCandidateError(null);
    setCandidatePreviewPath('');
    setCandidatePreview(null);
    setCandidatePreviewLoading(false);
    setCandidatePreviewError(null);
    setCandidateEditDraft(null);
    setCandidateActionNote('');
    setCandidateTargetKind('candidate');
    setCandidateTargetId('');
    setCandidateDeferUntil('');
    setCandidateActionBusy(null);
    setCandidateActionNotice(null);
  }, [workspaceId]);

  const candidateFilters = useMemo(() => ({
    source: searchParams.get('candidateSource') ?? '',
    category: searchParams.get('candidateCategory') ?? '',
    confidence: searchParams.get('candidateConfidence') ?? '',
    trustTier: searchParams.get('candidateTrustTier') ?? '',
    status: searchParams.get('candidateStatus') ?? 'all',
    q: searchParams.get('candidateQ') ?? '',
  }), [searchParams]);

  const selectedCandidateIdFromParams = searchParams.get('candidateId');

  const updateSearch = useCallback((updates: Record<string, string | null>, replace = true) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next, { replace });
  }, [searchParams, setSearchParams]);

  const handlePanelTabChange = useCallback((tab: MemoryPanelSubTab) => {
    updateSearch({ memoryTab: tab === 'candidates' ? 'candidates' : null });
  }, [updateSearch]);

  const handleCandidateFilterChange = useCallback((key: string, value: string) => {
    updateSearch({ memoryTab: 'candidates', [key]: value || null, candidateId: null });
  }, [updateSearch]);

  const handleSelectCandidate = useCallback((candidateId: string) => {
    updateSearch({ memoryTab: 'candidates', candidateId });
  }, [updateSearch]);

  useEffect(() => {
    if (!workspaceId) {
      setAnalyticsDrilldown(null);
      setAnalyticsDrilldownActive(false);
      return;
    }

    try {
      const raw = sessionStorage.getItem(MEMORY_ANALYTICS_DRILLDOWN_STORAGE_KEY);
      if (!raw) {
        setAnalyticsDrilldown(null);
        setAnalyticsDrilldownActive(false);
        return;
      }

      const parsed = JSON.parse(raw) as MemoryAnalyticsDrilldown;
      if (parsed?.source !== 'ontology-health' || parsed.workspaceId !== workspaceId) {
        setAnalyticsDrilldown(null);
        setAnalyticsDrilldownActive(false);
        return;
      }

      setAnalyticsDrilldown(parsed);
      setAnalyticsDrilldownActive(true);
      setViewMode('split');
    } catch {
      setAnalyticsDrilldown(null);
      setAnalyticsDrilldownActive(false);
    }
  }, [workspaceId]);

  const fetchItems = useCallback(async () => {
    if (!workspaceId) return;
    const params = new URLSearchParams({ workspaceId, limit: '500' });
    if (filterCategory) params.set('category', filterCategory);
    if (filterConfidence) params.set('confidence', filterConfidence);
    if (filterRunId) params.set('sourceRunId', filterRunId);
    if (searchText) params.set('search', searchText);

    try {
      const data = await apiFetch<MemoryListResponse>(`/api/memory/items?${params.toString()}`);
      const nextItems = Array.isArray(data?.items) ? data.items : [];
      setItems(nextItems);
      setTotalCount(Number(data?.total ?? 0));
      setPinnedCount(Number(data?.pinned ?? 0));
      setRecentRunIds(Array.isArray(data?.recentRunIds) ? data.recentRunIds : []);
    } catch {
      setItems([]);
      setTotalCount(0);
      setPinnedCount(0);
      setRecentRunIds([]);
    }
    setLoaded(true);
  }, [workspaceId, filterCategory, filterConfidence, filterRunId, searchText]);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  const fetchReviewData = useCallback(async () => {
    if (!workspaceId) return;
    setReviewLoading(true);
    setReviewError(null);

    try {
      const data = await apiFetch<MemoryReviewResponse>(`/api/memory/review?workspaceId=${encodeURIComponent(workspaceId)}`);
      setReviewData(data);
    } catch (error) {
      setReviewData(null);
      setReviewError(error instanceof Error ? error.message : 'Memory review queue unavailable right now.');
    } finally {
      setReviewLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void fetchReviewData();
  }, [fetchReviewData]);

  const fetchCandidates = useCallback(async () => {
    if (!workspaceId || activePanelTab !== 'candidates') return;

    const params = new URLSearchParams({ workspaceId, limit: '100', status: candidateFilters.status || 'all' });
    if (candidateFilters.source) params.set('sourceSystem', candidateFilters.source);
    if (candidateFilters.category) params.set('category', candidateFilters.category);
    if (candidateFilters.confidence) params.set('confidence', candidateFilters.confidence);
    if (candidateFilters.trustTier) params.set('trustTier', candidateFilters.trustTier);
    if (candidateFilters.q) params.set('q', candidateFilters.q);

    setCandidateLoading(true);
    setCandidateError(null);
    try {
      const data = await apiFetch<MemoryCandidateListResponse>(`/api/context-candidates?${params.toString()}`);
      const nextItems = Array.isArray(data?.items) ? data.items : [];
      setCandidateItems(nextItems);
      setCandidateTotal(Number(data?.total ?? nextItems.length));
    } catch (error) {
      setCandidateItems([]);
      setCandidateTotal(0);
      setCandidateError(error instanceof Error ? error.message : 'Unable to load memory candidates right now.');
    } finally {
      setCandidateLoading(false);
    }
  }, [activePanelTab, candidateFilters.category, candidateFilters.confidence, candidateFilters.q, candidateFilters.source, candidateFilters.status, candidateFilters.trustTier, workspaceId]);

  useEffect(() => {
    if (activePanelTab !== 'candidates') return;
    void fetchCandidates();
  }, [activePanelTab, fetchCandidates]);

  const selectedCandidate = useMemo(() => {
    if (candidateItems.length === 0) return null;
    if (selectedCandidateIdFromParams) {
      return candidateItems.find((candidate) => candidate.id === selectedCandidateIdFromParams) ?? candidateItems[0];
    }
    return candidateItems[0];
  }, [candidateItems, selectedCandidateIdFromParams]);
  const selectedCandidateId = selectedCandidate?.id ?? null;

  useEffect(() => {
    if (!selectedCandidate) {
      setCandidateEditDraft(null);
      setCandidatePreviewPath('');
      setCandidatePreview(null);
      return;
    }

    setCandidateEditDraft(createCandidateEditDraft(selectedCandidate));
    setCandidateActionNote('');
    setCandidateTargetId('');
    setCandidateDeferUntil('');
    setCandidateActionNotice(null);
    setCandidatePreviewPath(selectedCandidate.relatedFiles[0] ?? '');
    setCandidatePreview(null);
    setCandidatePreviewError(null);
  }, [selectedCandidate]);

  useEffect(() => {
    if (activePanelTab !== 'candidates' || !workspaceId || !selectedCandidate || !candidatePreviewPath) {
      setCandidatePreview(null);
      setCandidatePreviewLoading(false);
      setCandidatePreviewError(null);
      return;
    }

    let cancelled = false;
    const params = new URLSearchParams({ workspaceId, path: candidatePreviewPath });
    setCandidatePreviewLoading(true);
    setCandidatePreviewError(null);
    void apiFetch<CandidateFilePreviewResponse>(`/api/context-candidates/${selectedCandidate.id}/file-preview?${params.toString()}`)
      .then((data) => {
        if (cancelled) return;
        setCandidatePreview(data.preview);
      })
      .catch((error) => {
        if (cancelled) return;
        setCandidatePreview(null);
        setCandidatePreviewError(error instanceof Error ? error.message : 'Unable to load the safe file preview.');
      })
      .finally(() => {
        if (!cancelled) setCandidatePreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activePanelTab, candidatePreviewPath, selectedCandidate, workspaceId]);

  const fetchRelations = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const data = await apiFetch<MemoryRelationsResponse>(`/api/memory/relations?workspaceId=${encodeURIComponent(workspaceId)}`);
      setRelations(Array.isArray(data?.items) ? data.items : []);
      setRelationsError(null);
    } catch (error) {
      setRelations([]);
      setRelationsError(error instanceof Error ? error.message : 'Ontology explanations unavailable right now.');
    }
  }, [workspaceId]);

  useEffect(() => {
    void fetchRelations();
  }, [fetchRelations]);

  const shouldShowGraph = viewMode !== 'list';

  const fetchOverviewGraph = useCallback(async () => {
    if (!workspaceId || !shouldShowGraph) return;
    setOverviewGraphLoading(true);
    setOverviewGraphError(null);

    try {
      const data = await apiFetch<MemoryGraphResponse>(`/api/memory/graph/overview?workspaceId=${encodeURIComponent(workspaceId)}`);
      setOverviewGraph(data);
    } catch (error) {
      setOverviewGraph(null);
      setOverviewGraphError(error instanceof Error ? error.message : 'Knowledge Web unavailable right now.');
    } finally {
      setOverviewGraphLoading(false);
    }
  }, [workspaceId, shouldShowGraph]);

  useEffect(() => {
    if (!shouldShowGraph) return;
    void fetchOverviewGraph();
  }, [fetchOverviewGraph, shouldShowGraph]);

  const sourceTypeFilteredItems = useMemo(
    () => (filterSourceType ? items.filter((item) => (item.sourceType ?? 'manual') === filterSourceType) : items),
    [items, filterSourceType],
  );

  const filteredItems = useMemo(() => {
    if (!analyticsDrilldownActive || !analyticsDrilldown) return sourceTypeFilteredItems;

    const memoryIdSet = new Set(analyticsDrilldown.memoryIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0));
    const specIdSet = new Set(analyticsDrilldown.specIds.filter((value) => value.trim().length > 0));
    const filePathSet = new Set(analyticsDrilldown.filePaths.filter((value) => value.trim().length > 0));

    return sourceTypeFilteredItems.filter((item) => {
      if (memoryIdSet.has(item.id)) return true;
      if (item.sourceSpecId && specIdSet.has(item.sourceSpecId)) return true;
      return item.relatedFiles.some((file) => filePathSet.has(file));
    });
  }, [analyticsDrilldown, analyticsDrilldownActive, sourceTypeFilteredItems]);

  useEffect(() => {
    setSelectedMemoryId((current) => {
      if (current && filteredItems.some((item) => String(item.id) === current)) return current;
      return filteredItems[0] ? String(filteredItems[0].id) : null;
    });
  }, [filteredItems]);

  useEffect(() => {
    if (!selectedMemoryId) {
      setTargetMemoryId('');
      return;
    }

    setTargetMemoryId((current) => {
      if (current && current !== selectedMemoryId && items.some((item) => String(item.id) === current)) {
        return current;
      }
      return '';
    });
    setRelationNotice(null);
  }, [items, selectedMemoryId]);

  const fetchNeighborhoodGraph = useCallback(async () => {
    if (!workspaceId || !selectedMemoryId || !shouldShowGraph) {
      setNeighborhoodGraph(null);
      setNeighborhoodGraphError(null);
      return;
    }

    setNeighborhoodGraphLoading(true);
    setNeighborhoodGraph(null);
    setNeighborhoodGraphError(null);
    try {
      const params = new URLSearchParams({ workspaceId, memoryId: selectedMemoryId });
      const data = await apiFetch<MemoryGraphResponse>(`/api/memory/graph/neighborhood?${params.toString()}`);
      setNeighborhoodGraph(data);
    } catch (error) {
      setNeighborhoodGraph(null);
      setNeighborhoodGraphError(error instanceof Error ? error.message : 'Focused neighborhood unavailable right now.');
    } finally {
      setNeighborhoodGraphLoading(false);
    }
  }, [workspaceId, selectedMemoryId, shouldShowGraph]);

  useEffect(() => {
    if (!shouldShowGraph) return;
    void fetchNeighborhoodGraph();
  }, [fetchNeighborhoodGraph, shouldShowGraph]);

  const refreshOntologyState = useCallback(async () => {
    await fetchRelations();
    if (!shouldShowGraph) return;
    await fetchOverviewGraph();
    await fetchNeighborhoodGraph();
  }, [fetchNeighborhoodGraph, fetchOverviewGraph, fetchRelations, shouldShowGraph]);

  const handleOpenCuration = (memoryId: string) => {
    setSelectedMemoryId(memoryId);
    setRelationNotice(null);
    setCurationOpen(true);
  };

  const handleReviewAction = async (memoryId: number, action: MemoryReviewAction) => {
    if (!workspaceId) return;

    try {
      setReviewBusyKey(`review:${memoryId}`);
      await apiFetch(`/api/memory/review/${memoryId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, action }),
      });
      await Promise.all([fetchItems(), fetchReviewData(), refreshOntologyState()]);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : 'Unable to apply the memory review action right now.');
    } finally {
      setReviewBusyKey(null);
    }
  };

  const handleCandidateAction = async (action: CandidateAction) => {
    if (!workspaceId || !selectedCandidate) return;

    const base = {
      workspaceId,
      reviewer: 'local-user',
      ...(candidateActionNote.trim() ? { reason: candidateActionNote.trim() } : {}),
    };
    const targetId = candidateTargetId.trim();
    let endpoint = `/api/context-candidates/${selectedCandidate.id}/${action}`;
    let payload: Record<string, unknown> = base;

    if (action === 'approve') {
      payload = {
        workspaceId,
        reviewer: 'local-user',
        ...(selectedCandidate.regulatedDomain ? { regulatedReviewConfirmed: true } : {}),
      };
    } else if (action === 'edit-and-approve') {
      if (!candidateEditDraft) return;
      payload = {
        workspaceId,
        reviewer: 'local-user',
        ...(selectedCandidate.regulatedDomain ? { regulatedReviewConfirmed: true } : {}),
        edits: {
          suggestedCategory: candidateEditDraft.suggestedCategory,
          title: candidateEditDraft.title,
          rule: candidateEditDraft.rule,
          context: candidateEditDraft.context,
          confidence: candidateEditDraft.confidence,
          relatedFiles: relatedFilesFromDraft(candidateEditDraft.relatedFiles),
        },
      };
    } else if (action === 'duplicate') {
      payload = {
        ...base,
        [candidateTargetKind === 'candidate' ? 'duplicateOfCandidateId' : 'duplicateOfMemoryId']: targetId,
      };
    } else if (action === 'supersede') {
      endpoint = `/api/context-candidates/${selectedCandidate.id}/supersede`;
      payload = {
        ...base,
        [candidateTargetKind === 'candidate' ? 'supersededByCandidateId' : 'supersededByMemoryId']: targetId,
      };
    } else if (action === 'conflict') {
      payload = {
        ...base,
        [candidateTargetKind === 'candidate' ? 'conflictingCandidateId' : 'conflictingMemoryId']: targetId,
      };
    } else if (action === 'defer') {
      payload = {
        ...base,
        ...(candidateDeferUntil ? { deferUntil: new Date(candidateDeferUntil).toISOString() } : {}),
      };
    }

    try {
      setCandidateActionBusy(action);
      setCandidateActionNotice(null);
      await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setCandidateActionNotice({
        tone: 'success',
        message: action === 'edit-and-approve' ? 'Candidate edited and approved.' : `Candidate ${action.replaceAll('-', ' ')} saved.`,
      });
      await Promise.all([fetchCandidates(), fetchItems()]);
    } catch (error) {
      setCandidateActionNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : `Unable to ${action.replaceAll('-', ' ')} candidate.`,
      });
    } finally {
      setCandidateActionBusy(null);
    }
  };

  const handleCreateRelation = async (relationType: MemoryRelationListItem['relationType']) => {
    if (!workspaceId || !selectedMemoryId) return;

    const sourceMemoryId = Number(selectedMemoryId);
    const parsedTargetMemoryId = Number(targetMemoryId);
    const normalizedSourceMemoryId = Number.isInteger(sourceMemoryId) ? sourceMemoryId : null;
    const normalizedTargetMemoryId = Number.isInteger(parsedTargetMemoryId) && parsedTargetMemoryId > 0 ? parsedTargetMemoryId : null;

    if (!normalizedTargetMemoryId) {
      setRelationNotice({ tone: 'error', message: 'Choose another memory to relate.' });
      return;
    }

    const validationError = buildRelationDraftError(
      relationType,
      normalizedSourceMemoryId,
      normalizedTargetMemoryId,
      relations,
    );

    if (validationError) {
      setRelationNotice({ tone: 'error', message: validationError });
      return;
    }

    try {
      setRelationMutationKey(`create:${relationType}`);
      await apiFetch('/api/memory/relations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          sourceMemoryId,
          targetMemoryId: normalizedTargetMemoryId,
          relationType,
        }),
      });
      setTargetMemoryId('');
      setRelationNotice({
        tone: 'success',
        message: relationType === 'SUPERSEDES'
          ? `Memory #${sourceMemoryId} now supersedes memory #${normalizedTargetMemoryId}.`
          : `Memory #${sourceMemoryId} now conflicts with memory #${normalizedTargetMemoryId}.`,
      });
      await refreshOntologyState();
    } catch (error) {
      setRelationNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to save the ontology relation right now.',
      });
    } finally {
      setRelationMutationKey(null);
    }
  };

  const handleRemoveRelation = async (relationId: number) => {
    if (!workspaceId) return;

    try {
      setRelationMutationKey(`delete:${relationId}`);
      await apiFetch(`/api/memory/relations/${relationId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      setRelationNotice({ tone: 'success', message: `Relation #${relationId} removed from the active ontology.` });
      await refreshOntologyState();
    } catch (error) {
      setRelationNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to remove the ontology relation right now.',
      });
    } finally {
      setRelationMutationKey(null);
    }
  };

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => setSearchText(value), 300);
  };

  const handleDelete = async (id: number) => {
    try {
      await apiFetch(`/api/memory/items/${id}`, { method: 'DELETE' });
      setUndoState({ id, message: 'Memory deleted. Undo?' });
      await fetchItems();
    } catch {
      // ignore
    }
  };

  const handleUndelete = async (id: number) => {
    try {
      await apiFetch(`/api/memory/items/${id}/undelete`, { method: 'POST' });
      setUndoState(null);
      await fetchItems();
    } catch {
      // ignore
    }
  };

  const handleTogglePin = async (item: MemoryItem) => {
    try {
      await apiFetch(`/api/memory/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: !item.pinned }),
      });
      await fetchItems();
    } catch {
      // ignore
    }
  };

  const handleSaveEdit = async (id: number, content: string) => {
    try {
      await apiFetch(`/api/memory/items/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      setEditingId(null);
      await fetchItems();
    } catch {
      // ignore
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try {
      await apiFetch('/api/memory/items/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action: 'delete' }),
      });
      setSelectedIds(new Set());
      await fetchItems();
    } catch {
      // ignore
    }
  };

  const handleBulkPin = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try {
      await apiFetch('/api/memory/items/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action: 'pin' }),
      });
      setSelectedIds(new Set());
      await fetchItems();
    } catch {
      // ignore
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const categoryCounts = filteredItems.reduce<Record<string, number>>((acc, item) => {
    acc[item.category] = (acc[item.category] ?? 0) + 1;
    return acc;
  }, {});

  const sourceTypeCounts = items.reduce<Record<string, number>>((acc, item) => {
    const sourceType = item.sourceType ?? 'manual';
    acc[sourceType] = (acc[sourceType] ?? 0) + 1;
    return acc;
  }, {});

  const analyticsDrilldownCounts = useMemo(() => ({
    memories: analyticsDrilldown?.memoryIds.length ?? 0,
    specs: analyticsDrilldown?.specIds.length ?? 0,
    files: analyticsDrilldown?.filePaths.length ?? 0,
  }), [analyticsDrilldown]);

  const currentRunCount = recentRunIds.length > 0 ? filteredItems.filter((item) => item.sourceRunId === recentRunIds[0]).length : 0;
  const memoryById = useMemo(() => new Map(items.map((item) => [String(item.id), item])), [items]);
  const explainabilityByMemory = useMemo(() => buildMemoryExplainabilityMap(relations), [relations]);
  const selectedExplainability = selectedMemoryId ? (explainabilityByMemory.get(selectedMemoryId) ?? []) : [];
  const filteredGraph = useMemo(
    () => buildFilteredGraphData(overviewGraph, neighborhoodGraph, filteredItems, selectedMemoryId),
    [overviewGraph, neighborhoodGraph, filteredItems, selectedMemoryId],
  );
  const graphLoading = shouldShowGraph && (overviewGraphLoading || (!overviewGraph && !overviewGraphError));

  // Spec contexts derived from memory items for the spec-centric relevance graph selector
  const availableSpecContexts = useMemo(() => {
    const seen = new Map<string, SpecContextSelection>();
    for (const item of items) {
      if (item.sourceSpecId && !seen.has(item.sourceSpecId)) {
        seen.set(item.sourceSpecId, {
          specSlug: item.sourceSpecId,
          storyId: item.sourceStoryId ?? undefined,
          label: item.sourceStoryId ? `${item.sourceSpecId} / ${item.sourceStoryId}` : item.sourceSpecId,
        });
      }
    }
    return Array.from(seen.values());
  }, [items]);

  // Spec-centric relevance graph data (fetched only when a spec context is selected)
  const specRelevanceGraph = useSpecRelevanceGraph({
    workspaceId: selectedSpecContext ? workspaceId : null,
    specSlug: selectedSpecContext?.specSlug,
  });

  const handleSelectSpecContext = useCallback((value: string) => {
    if (!value) {
      setSelectedSpecContext(null);
      return;
    }
    const ctx = availableSpecContexts.find((c) => c.specSlug === value);
    if (ctx) {
      setSelectedSpecContext(ctx);
    }
  }, [availableSpecContexts]);

  const handleClearSpecContext = useCallback(() => {
    setSelectedSpecContext(null);
  }, []);

  const handleSpecGraphNodeClick = useCallback((memoryEntityId: string) => {
    const memoryId = memoryEntityId;
    if (items.some((item) => String(item.id) === memoryId)) {
      setSelectedSpecContext(null);
      setSelectedMemoryId(memoryId);
    }
  }, [items]);

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  const listSection = (
    <EntriesSection
      filteredItems={filteredItems}
      totalCount={totalCount}
      selectedIds={selectedIds}
      editingId={editingId}
      selectedMemoryId={selectedMemoryId}
      explainabilityByMemory={explainabilityByMemory}
      onToggleSelect={toggleSelect}
      onFocusMemory={setSelectedMemoryId}
      onEdit={setEditingId}
      onSaveEdit={handleSaveEdit}
      onCancelEdit={() => setEditingId(null)}
      onDelete={handleDelete}
      onTogglePin={handleTogglePin}
      onCurateMemory={handleOpenCuration}
      compact={viewMode === 'split'}
    />
  );

  const graphSection = shouldShowGraph ? (
    <GraphView
      graph={filteredGraph}
      selectedMemoryId={selectedMemoryId}
      selectedExplainability={selectedExplainability}
      ontologyError={relationsError}
      onSelectMemory={setSelectedMemoryId}
      filteredItems={filteredItems}
      memoryById={memoryById}
      loading={graphLoading}
      overviewGraph={overviewGraph}
      overviewError={overviewGraphError}
      neighborhoodGraph={neighborhoodGraph}
      neighborhoodError={neighborhoodGraphError}
      loadingNeighborhood={neighborhoodGraphLoading}
    />
  ) : null;

  return (
    <div role="main" aria-label="Memory Ledger" className="flex h-full flex-col overflow-hidden bg-bg">
      <div className="h-full overflow-y-auto">
        <div className={`mx-auto space-y-4 px-4 py-6 sm:px-6 ${activePanelTab === 'candidates' || viewMode !== 'list' ? 'max-w-7xl' : 'max-w-3xl'}`}>
          <MemoryPanelTabs value={activePanelTab} onChange={handlePanelTabChange} />

          {activePanelTab === 'candidates' ? (
            <MemoryCandidateReviewSection
              filters={candidateFilters}
              candidates={candidateItems}
              total={candidateTotal}
              loading={candidateLoading}
              error={candidateError}
              selectedCandidate={selectedCandidate}
              selectedCandidateId={selectedCandidateId}
              previewPath={candidatePreviewPath}
              preview={candidatePreview}
              previewLoading={candidatePreviewLoading}
              previewError={candidatePreviewError}
              editDraft={candidateEditDraft}
              actionNote={candidateActionNote}
              targetKind={candidateTargetKind}
              targetId={candidateTargetId}
              deferUntil={candidateDeferUntil}
              actionBusy={candidateActionBusy}
              actionNotice={candidateActionNotice}
              onFilterChange={handleCandidateFilterChange}
              onSelectCandidate={handleSelectCandidate}
              onPreviewPathChange={setCandidatePreviewPath}
              onEditDraftChange={setCandidateEditDraft}
              onActionNoteChange={setCandidateActionNote}
              onTargetKindChange={setCandidateTargetKind}
              onTargetIdChange={setCandidateTargetId}
              onDeferUntilChange={setCandidateDeferUntil}
              onAction={handleCandidateAction}
              onRetry={fetchCandidates}
            />
          ) : (
            <div id="memory-panel-ledger" role="tabpanel" aria-labelledby="memory-panel-tab-ledger" className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-[11px]">
            <span className="font-medium text-[var(--text)]">{totalCount} memories</span>
            {pinnedCount > 0 && (
              <span className="inline-flex items-center gap-1 text-amber-500">
                <Pin size={10} className="fill-amber-500" />
                {pinnedCount} pinned
              </span>
            )}
            {currentRunCount > 0 && <span className="text-cyan-500">{currentRunCount} this run</span>}
          </div>

          {analyticsDrilldown && (
            <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-3 text-xs text-[var(--text)]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">Analytics drill-down: {analyticsDrilldown.label}</p>
                  <p className="mt-1 max-w-3xl leading-relaxed text-[var(--text)]/80">{analyticsDrilldown.description}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-cyan-100/90">
                    {analyticsDrilldownCounts.memories > 0 && <span className="rounded-full border border-cyan-400/30 px-2 py-0.5">{analyticsDrilldownCounts.memories} memories</span>}
                    {analyticsDrilldownCounts.specs > 0 && <span className="rounded-full border border-cyan-400/30 px-2 py-0.5">{analyticsDrilldownCounts.specs} specs</span>}
                    {analyticsDrilldownCounts.files > 0 && <span className="rounded-full border border-cyan-400/30 px-2 py-0.5">{analyticsDrilldownCounts.files} files</span>}
                    <span className="rounded-full border border-cyan-400/30 px-2 py-0.5">{analyticsDrilldownActive ? `${filteredItems.length} in focus` : 'Focus cleared'}</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setAnalyticsDrilldownActive((current) => !current)}
                    className="rounded-md border border-cyan-400/30 px-2.5 py-1 text-[11px] font-medium text-cyan-100 transition-colors hover:bg-cyan-500/10"
                  >
                    {analyticsDrilldownActive ? 'Show all memories' : 'Refocus drill-down'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      sessionStorage.removeItem(MEMORY_ANALYTICS_DRILLDOWN_STORAGE_KEY);
                      setAnalyticsDrilldown(null);
                      setAnalyticsDrilldownActive(false);
                    }}
                    className="rounded-md border border-cyan-400/30 px-2.5 py-1 text-[11px] font-medium text-cyan-100 transition-colors hover:bg-cyan-500/10"
                  >
                    Clear drill-down
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[180px] flex-1">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="text"
                value={searchInput}
                placeholder="Search memories..."
                onChange={(e) => handleSearchChange(e.target.value)}
                aria-label="Search memories"
                className="w-full rounded-md border border-border bg-bg py-1.5 pl-8 pr-3 text-xs text-[var(--text)] placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent"
              />
            </div>

            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              aria-label="Filter by category"
              className="rounded border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
            >
              <option value="">All categories</option>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>

            <select
              value={filterConfidence}
              onChange={(e) => setFilterConfidence(e.target.value)}
              aria-label="Filter by confidence"
              className="rounded border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
            >
              <option value="">All confidence</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>

            {recentRunIds.length > 0 && (
              <select
                value={filterRunId}
                onChange={(e) => setFilterRunId(e.target.value)}
                aria-label="Filter by source run"
                className="rounded border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
              >
                <option value="">All runs</option>
                {recentRunIds.map((id) => (
                  <option key={id} value={id}>Run #{id}</option>
                ))}
              </select>
            )}

            <select
              value={filterSourceType}
              onChange={(e) => setFilterSourceType(e.target.value)}
              aria-label="Filter by source type"
              className="rounded border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
            >
              <option value="">All sources</option>
              {SOURCE_TYPES.map((sourceType) => (
                <option key={sourceType} value={sourceType}>{SOURCE_TYPE_LABELS[sourceType]}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {CATEGORIES.map((category) => {
              const count = categoryCounts[category] ?? 0;
              if (count === 0) return null;
              const active = filterCategory === category;
              return (
                <button
                  key={category}
                  onClick={() => setFilterCategory(active ? '' : category)}
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    active ? CATEGORY_COLORS[category] : 'bg-surface-200 text-muted hover:bg-surface-300'
                  }`}
                >
                  {category} ({count})
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {SOURCE_TYPES.map((sourceType) => {
              const count = sourceTypeCounts[sourceType] ?? 0;
              if (count === 0) return null;
              const active = filterSourceType === sourceType;
              return (
                <button
                  key={sourceType}
                  onClick={() => setFilterSourceType(active ? '' : sourceType)}
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    active ? SOURCE_TYPE_COLORS[sourceType] : 'bg-surface-200 text-muted hover:bg-surface-300'
                  }`}
                >
                  {SOURCE_TYPE_LABELS[sourceType]} ({count})
                </button>
              );
            })}
          </div>

          <ReviewWorkflowSection
            data={reviewData}
            loading={reviewLoading}
            error={reviewError}
            busyKey={reviewBusyKey}
            onAction={handleReviewAction}
            onFocusMemory={setSelectedMemoryId}
          />

          <ViewModeTabs
            value={viewMode}
            graphIssue={relationsError ?? overviewGraphError ?? reviewData?.staleCandidates.reason ?? reviewData?.hotspots.reason ?? null}
            onChange={setViewMode}
          />

          <div
            id={`memory-view-${viewMode}`}
            role="tabpanel"
            aria-labelledby={`memory-view-tab-${viewMode}`}
            className="space-y-4"
          >
            {viewMode === 'list' && listSection}
            {viewMode === 'graph' && graphSection}
            {viewMode === 'split' && (
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] xl:items-start">
                <div className="min-w-0">{listSection}</div>
                <div className="min-w-0">
                  {/* Spec context selector */}
                  {availableSpecContexts.length > 0 && (
                    <div className="mb-3 flex items-center gap-2" data-testid="spec-context-selector">
                      <Network size={14} className={selectedSpecContext ? 'text-violet-500' : 'text-muted'} />
                      <select
                        value={selectedSpecContext?.specSlug ?? ''}
                        onChange={(e) => handleSelectSpecContext(e.target.value)}
                        aria-label="Select spec context for relevance graph"
                        className="rounded border border-border bg-bg px-2 py-1 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
                      >
                        <option value="">Memory neighborhood</option>
                        {availableSpecContexts.map((ctx) => (
                          <option key={ctx.specSlug} value={ctx.specSlug}>
                            Spec: {ctx.label}
                          </option>
                        ))}
                      </select>
                      {selectedSpecContext && (
                        <button
                          type="button"
                          onClick={handleClearSpecContext}
                          className="rounded px-1.5 py-0.5 text-[10px] text-violet-500 hover:bg-violet-500/10"
                          aria-label="Clear spec context"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  )}

                  {/* Mode indicator */}
                  {selectedSpecContext && (
                    <div
                      className="mb-3 flex items-center gap-2 rounded-lg border border-violet-500/20 bg-violet-500/10 px-3 py-2 text-xs text-violet-300"
                      role="status"
                      aria-label="Spec relevance mode active"
                      data-testid="spec-context-mode-indicator"
                    >
                      <Network size={14} />
                      <span>Spec relevance graph: <strong>{selectedSpecContext.label}</strong></span>
                    </div>
                  )}

                  {/* Right pane: spec-centric graph OR memory neighborhood */}
                  {selectedSpecContext ? (
                    <SpecRelevanceGraphPane
                      data={specRelevanceGraph.data}
                      state={specRelevanceGraph.status}
                      error={specRelevanceGraph.error}
                      onNodeClick={handleSpecGraphNodeClick}
                    />
                  ) : (
                    graphSection
                  )}
                </div>
              </div>
            )}
          </div>
            </div>
          )}
        </div>
      </div>

      <OntologyCurationDrawer
        open={curationOpen}
        onClose={() => setCurationOpen(false)}
        items={items}
        selectedMemoryId={selectedMemoryId}
        relations={relations}
        targetMemoryId={targetMemoryId}
        busyKey={relationMutationKey}
        notice={relationNotice}
        onTargetMemoryChange={setTargetMemoryId}
        onCreateRelation={handleCreateRelation}
        onRemoveRelation={handleRemoveRelation}
      />

      <BulkActionBar
        count={selectedIds.size}
        onDelete={handleBulkDelete}
        onPin={handleBulkPin}
        onClear={() => setSelectedIds(new Set())}
      />

      {undoState && (
        <UndoToast
          message={undoState.message}
          onUndo={() => handleUndelete(undoState.id)}
          onDismiss={() => setUndoState(null)}
        />
      )}
    </div>
  );
}
