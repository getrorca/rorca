/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  AlertTriangle,
  Blocks,
  ChevronDown,
  Compass,
  Copy,
  Eye,
  FileText,
  FolderOpen,
  History,
  ListChecks,
  MoreHorizontal,
  Search,
} from 'lucide-react';
import type {
  LifecycleSourceArtifact,
  LifecycleSourceArtifactAction,
  LifecycleSourceArtifactPreview,
  LifecycleSourceMaterial,
  LifecycleSourceSynthesisSection,
} from '../types/lifecycle';
import LifecycleHashChip from './LifecycleHashChip';
import LifecycleMarkdown from './LifecycleMarkdown';
import SlideOver from './SlideOver';

export type LifecycleSourceView = 'overview' | 'synthesis' | 'sources';

export interface LifecycleSourceActionError {
  relativePath: string;
  action: LifecycleSourceArtifactAction;
  line?: number | null;
  column?: number | null;
  message: string;
  remediation: string;
}

interface LifecycleSourceWorkspaceProps {
  source: LifecycleSourceMaterial;
  view: LifecycleSourceView;
  workspaceId: string;
  specId: string;
  pending: string | null;
  onOpen?: (
    relativePath: string,
    action: LifecycleSourceArtifactAction,
    line?: number | null,
    column?: number | null,
  ) => void;
  actionError?: LifecycleSourceActionError | null;
  onDismissActionError?: () => void;
  onRead?: (
    relativePath: string,
    startLine?: number | null,
    endLine?: number | null,
  ) => Promise<LifecycleSourceArtifactPreview>;
}

interface StoredArtifactSnapshot {
  name: string;
  contentHash: string;
}

interface StoredSectionSnapshot {
  key: string;
  id: string;
  title: string;
  fingerprint: string;
}

interface StoredSourceSnapshot {
  packageId: string;
  packageHash: string;
  observedAt: string;
  artifacts: StoredArtifactSnapshot[];
  sections: StoredSectionSnapshot[];
}

interface StoredSourceHistory {
  current: StoredSourceSnapshot;
  previous: StoredSourceSnapshot | null;
}

interface GenerationDelta {
  previousPackageId: string;
  currentPackageId: string;
  addedArtifacts: string[];
  updatedArtifacts: string[];
  removedArtifacts: string[];
  addedSections: string[];
  updatedSectionKeys: Set<string>;
  updatedSections: string[];
  removedSections: string[];
}

interface PreviewTarget {
  artifact: LifecycleSourceArtifact;
  startLine: number | null;
  endLine: number | null;
}

const HISTORY_SCHEMA = 'rorca:lifecycle-source-history:v1';
const EXPANDED_SCHEMA = 'rorca:lifecycle-source-expanded:v1';

function readable(value: string): string {
  const normalized = value.replace(/[-_]/g, ' ');
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

function basename(value: string): string {
  return value.split('/').at(-1) ?? value;
}

function storageKey(prefix: string, workspaceId: string, specId: string, lens: string): string {
  return `${prefix}:${workspaceId}:${specId}:${lens}`;
}

function sectionKey(section: Pick<LifecycleSourceSynthesisSection, 'title' | 'sourcePath'>): string {
  return `${section.sourcePath}::${section.title}`;
}

/** Non-authoritative display checksum used only to compare browser-observed section text. */
function displayFingerprint(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function currentSnapshot(source: Extract<LifecycleSourceMaterial, { state: 'available' }>): StoredSourceSnapshot {
  const latestModifiedAt = source.artifacts.reduce(
    (latest, artifact) => artifact.modifiedAt > latest ? artifact.modifiedAt : latest,
    '',
  );
  return {
    packageId: source.package.packageId,
    packageHash: source.package.contentHash,
    observedAt: latestModifiedAt || new Date(0).toISOString(),
    artifacts: source.artifacts.map((artifact) => ({ name: artifact.name, contentHash: artifact.contentHash })),
    sections: source.synthesis.sections.map((section) => ({
      key: sectionKey(section),
      id: section.id,
      title: section.title,
      fingerprint: displayFingerprint(`${section.sourceContentHash ?? ''}\n${section.startLine}\n${section.endLine}`),
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseStoredSnapshot(value: unknown): StoredSourceSnapshot | null {
  if (!isRecord(value)
    || typeof value.packageId !== 'string'
    || typeof value.packageHash !== 'string'
    || typeof value.observedAt !== 'string'
    || !Array.isArray(value.artifacts)
    || !Array.isArray(value.sections)) return null;
  const artifacts = value.artifacts.flatMap((entry) => (
    isRecord(entry) && typeof entry.name === 'string' && typeof entry.contentHash === 'string'
      ? [{ name: entry.name, contentHash: entry.contentHash }]
      : []
  ));
  const sections = value.sections.flatMap((entry) => (
    isRecord(entry)
      && typeof entry.key === 'string'
      && typeof entry.id === 'string'
      && typeof entry.title === 'string'
      && typeof entry.fingerprint === 'string'
      ? [{ key: entry.key, id: entry.id, title: entry.title, fingerprint: entry.fingerprint }]
      : []
  ));
  if (artifacts.length !== value.artifacts.length || sections.length !== value.sections.length) return null;
  return {
    packageId: value.packageId,
    packageHash: value.packageHash,
    observedAt: value.observedAt,
    artifacts,
    sections,
  };
}

function readHistory(key: string): StoredSourceHistory | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!isRecord(parsed)) return null;
    const current = parseStoredSnapshot(parsed.current);
    const previous = parsed.previous === null ? null : parseStoredSnapshot(parsed.previous);
    return current && (parsed.previous === null || previous) ? { current, previous } : null;
  } catch {
    return null;
  }
}

function hasStoredValue(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function compareSnapshots(previous: StoredSourceSnapshot, current: StoredSourceSnapshot): GenerationDelta {
  const previousArtifacts = new Map(previous.artifacts.map((artifact) => [artifact.name, artifact.contentHash]));
  const currentArtifacts = new Map(current.artifacts.map((artifact) => [artifact.name, artifact.contentHash]));
  const previousSections = new Map(previous.sections.map((section) => [section.key, section]));
  const currentSections = new Map(current.sections.map((section) => [section.key, section]));
  const updatedSectionKeys = new Set(current.sections
    .filter((section) => previousSections.has(section.key)
      && previousSections.get(section.key)?.fingerprint !== section.fingerprint)
    .map((section) => section.key));
  return {
    previousPackageId: previous.packageId,
    currentPackageId: current.packageId,
    addedArtifacts: current.artifacts.filter((artifact) => !previousArtifacts.has(artifact.name)).map((artifact) => artifact.name),
    updatedArtifacts: current.artifacts.filter((artifact) => previousArtifacts.has(artifact.name)
      && previousArtifacts.get(artifact.name) !== artifact.contentHash).map((artifact) => artifact.name),
    removedArtifacts: previous.artifacts.filter((artifact) => !currentArtifacts.has(artifact.name)).map((artifact) => artifact.name),
    addedSections: current.sections.filter((section) => !previousSections.has(section.key)).map((section) => section.title),
    updatedSectionKeys,
    updatedSections: current.sections.filter((section) => updatedSectionKeys.has(section.key)).map((section) => section.title),
    removedSections: previous.sections.filter((section) => !currentSections.has(section.key)).map((section) => section.title),
  };
}

function packageFamily(packageId: string): string {
  return packageId.replace(/-[0-9a-f]{12}$/i, '');
}

function observeGeneration(key: string, current: StoredSourceSnapshot): GenerationDelta | null {
  const history = readHistory(key);
  if (!history) {
    localStorage.setItem(key, JSON.stringify({ current, previous: null } satisfies StoredSourceHistory));
    return null;
  }
  const sameCurrentFamily = packageFamily(history.current.packageId) === packageFamily(current.packageId);
  const previous = history.previous && packageFamily(history.previous.packageId) === packageFamily(current.packageId)
    ? history.previous
    : null;
  if (
    history.current.packageId === current.packageId
    && history.current.packageHash === current.packageHash
  ) {
    if (previous !== history.previous) {
      localStorage.setItem(key, JSON.stringify({ current: history.current, previous } satisfies StoredSourceHistory));
    }
    return previous ? compareSnapshots(previous, current) : null;
  }
  if (!sameCurrentFamily) {
    localStorage.setItem(key, JSON.stringify({ current, previous: null } satisfies StoredSourceHistory));
    return null;
  }
  localStorage.setItem(key, JSON.stringify({ current, previous: history.current } satisfies StoredSourceHistory));
  return compareSnapshots(history.current, current);
}

function setQueryValues(values: Record<string, string | null>): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

function queryValue(name: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(name);
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

function SourceArtifactButton({
  artifact,
  action,
  line,
  pending,
  onOpen,
}: {
  artifact: LifecycleSourceArtifact;
  action: LifecycleSourceArtifactAction;
  line?: number | null;
  pending: string | null;
  onOpen?: LifecycleSourceWorkspaceProps['onOpen'];
}) {
  const key = `${action}:${artifact.relativePath}:${line ?? ''}`;
  const label = action === 'open'
    ? `Open ${artifact.relativePath} in editor${line ? ` at line ${line}` : ''}`
    : `Reveal ${artifact.relativePath} in folder`;
  return (
    <button
      type="button"
      onClick={() => onOpen?.(artifact.relativePath, action, line)}
      disabled={!onOpen || pending !== null}
      aria-label={label}
      className="lifecycle-source-action focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait disabled:opacity-60"
    >
      {action === 'open' ? <FileText size={13} aria-hidden="true" /> : <FolderOpen size={13} aria-hidden="true" />}
      {pending === key ? 'Opening…' : action === 'open' ? 'Open' : 'Reveal'}
    </button>
  );
}

const LENS_PROFILES = {
  planning: {
    sequence: '01',
    eyebrow: 'Planning lens',
    title: 'Intent, scope, and delivery shape',
    question: 'What are we building, why now, and what is the delivery path?',
    description: 'Mission, boundaries, workstreams, decisions, assumptions, risks, and open questions.',
    primarySource: 'PRD + plan',
    icon: Compass,
  },
  requirements: {
    sequence: '02',
    eyebrow: 'Requirements lens',
    title: 'Behavior and acceptance contract',
    question: 'What must the product do—and how will we know it is correct?',
    description: 'Functional and non-functional requirements, success measures, and acceptance criteria.',
    primarySource: 'PRD',
    icon: ListChecks,
  },
  design: {
    sequence: '03',
    eyebrow: 'Design lens',
    title: 'Architecture and system boundaries',
    question: 'How will the system satisfy the requirements safely?',
    description: 'Components, state, data, authorization, integrations, migration, and verification design.',
    primarySource: 'SDD',
    icon: Blocks,
  },
} as const;

function LensIdentity({
  source,
}: {
  source: Extract<LifecycleSourceMaterial, { state: 'available' }>;
}) {
  const profile = LENS_PROFILES[source.lens];
  const Icon = profile.icon;
  return (
    <div className="lifecycle-lens-identity" data-lens={source.lens}>
      <div className="lifecycle-lens-identity__mark" aria-hidden="true">
        <Icon size={18} />
        <span>{profile.sequence}</span>
      </div>
      <div className="min-w-0">
        <p className="lifecycle-source-summary__eyebrow">{profile.eyebrow}</p>
        <h3 className="lifecycle-lens-identity__title">{profile.title}</h3>
        <p className="lifecycle-lens-identity__question">{profile.question}</p>
        <p className="lifecycle-lens-identity__description">{profile.description}</p>
      </div>
      <div className="lifecycle-lens-identity__meta" aria-label="Lens source summary">
        <span>{source.synthesis.sections.length} extracted section{source.synthesis.sections.length === 1 ? '' : 's'}</span>
        <span>Primary source · {profile.primarySource}</span>
      </div>
    </div>
  );
}

function PackageContext({
  source,
}: {
  source: Extract<LifecycleSourceMaterial, { state: 'available' }>;
}) {
  return (
    <div className="lifecycle-source-context">
      <div className="min-w-0">
        <span className="lifecycle-source-summary__eyebrow">Source package</span>
        <strong className="truncate" title={source.package.title}>{source.package.title}</strong>
      </div>
      <div className="lifecycle-source-context__facts">
        <span className="lifecycle-badge" data-tone="muted">
          {source.package.authoritative ? 'Authoritative' : 'Draft'}
        </span>
        <span>{Math.round(source.match.confidence * 100)}% matched</span>
        <span>{source.artifacts.length} files</span>
      </div>
    </div>
  );
}

function PackageSummary({
  source,
  delta,
}: {
  source: Extract<LifecycleSourceMaterial, { state: 'available' }>;
  delta: GenerationDelta | null;
}) {
  const caveatCount = source.inventory.warnings.length
    + source.inventory.contradictions.length
    + source.inventory.uncertainties.length
    + (source.package.authoritative ? 0 : 1);
  const changedCount = delta
    ? delta.addedArtifacts.length + delta.updatedArtifacts.length + delta.removedArtifacts.length
      + delta.addedSections.length + delta.updatedSections.length + delta.removedSections.length
    : 0;
  return (
    <div className="lifecycle-source-summary">
      <div className="lifecycle-source-summary__title">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-[var(--text)]">{source.package.title}</h3>
          <p className="mt-1 truncate text-xs text-muted" title={source.package.packageId}>{source.package.packageId}</p>
        </div>
        <span className="lifecycle-badge" data-tone="muted" title="Not published and cannot satisfy lifecycle gates">
          {source.package.authoritative ? 'Authoritative source' : 'Draft source'}
        </span>
      </div>
      <div className="lifecycle-source-summary__grid">
        <div>
          <span className="lifecycle-source-summary__eyebrow">Package</span>
          <strong>{readable(source.package.status)}</strong>
          <span>{readable(source.package.publicationStatus)}</span>
        </div>
        <div>
          <span className="lifecycle-source-summary__eyebrow">Coverage</span>
          <strong>{source.inventory.evidenceCount} selected</strong>
          <span>{source.inventory.excludedCount} excluded · {source.artifacts.length} files</span>
        </div>
        <div>
          <span className="lifecycle-source-summary__eyebrow">Provenance</span>
          <strong>{Math.round(source.match.confidence * 100)}% match confidence</strong>
          <span>{source.match.referencesMatched.length} matching spec sources</span>
        </div>
      </div>
      <div className="lifecycle-source-summary__meta">
        <LifecycleHashChip value={source.package.contentHash} label="source package hash" />
        <span>{source.match.rationale}</span>
      </div>
      {delta && changedCount > 0 && (
        <details className="lifecycle-source-change-summary">
          <summary>
            <History size={13} aria-hidden="true" />
            What changed: {changedCount} package item{changedCount === 1 ? '' : 's'} since the previous version observed in this browser
          </summary>
          <GenerationChanges delta={delta} />
        </details>
      )}
      {caveatCount > 0 && (
        <details className="lifecycle-source-caveats">
          <summary><AlertTriangle size={13} aria-hidden="true" /> {caveatCount} source caveat{caveatCount === 1 ? '' : 's'}</summary>
          <div className="mt-2 space-y-2 text-xs text-muted">
            {!source.package.authoritative && <p>This package is traceable input, not completion evidence. It cannot satisfy a lifecycle gate.</p>}
            {[...source.inventory.warnings, ...source.inventory.contradictions, ...source.inventory.uncertainties]
              .map((message) => <p key={message}>{message}</p>)}
          </div>
        </details>
      )}
    </div>
  );
}

function GenerationChanges({ delta }: { delta: GenerationDelta }) {
  const groups = [
    ['Added sections', delta.addedSections, 'current'],
    ['Updated sections', delta.updatedSections, 'updated'],
    ['Stale / removed sections', delta.removedSections, 'stale'],
    ['Added files', delta.addedArtifacts, 'current'],
    ['Updated files', delta.updatedArtifacts, 'updated'],
    ['Removed files', delta.removedArtifacts, 'stale'],
  ] as const;
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2" aria-label="Package generation changes">
      {groups.filter(([, items]) => items.length > 0).map(([label, items, tone]) => (
        <div key={label}>
          <p className="text-xs font-semibold text-[var(--text)]">{label}</p>
          <ul className="mt-1 space-y-1 text-xs text-muted">
            {items.map((item) => <li key={item}><span className="lifecycle-source-freshness" data-tone={tone}>{tone}</span> {item}</li>)}
          </ul>
        </div>
      ))}
    </div>
  );
}

function PreviewDrawer({
  target,
  preview,
  loading,
  error,
  restoreFocusRef,
  pending,
  onClose,
  onOpen,
  allowHostActions,
}: {
  target: PreviewTarget | null;
  preview: LifecycleSourceArtifactPreview | null;
  loading: boolean;
  error: string | null;
  restoreFocusRef: RefObject<HTMLElement | null>;
  pending: string | null;
  onClose: () => void;
  onOpen?: LifecycleSourceWorkspaceProps['onOpen'];
  allowHostActions: boolean;
}) {
  const copyPath = async () => {
    if (target) await navigator.clipboard.writeText(target.artifact.relativePath);
  };
  return (
    <SlideOver
      isOpen={target !== null}
      onClose={onClose}
      title={target ? `Source · ${target.artifact.name}` : 'Source preview'}
      ariaLabel="Lifecycle source preview"
      desktopMaxWidth={760}
      fullScreenBelowDesktop
      restoreFocusRef={restoreFocusRef}
      contentClassName="p-0"
    >
      {target && (
        <div className="lifecycle-source-preview">
          <div className="lifecycle-source-preview__toolbar">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-[var(--text)]" title={target.artifact.relativePath}>{target.artifact.relativePath}</p>
              <p className="mt-1 text-xs text-muted">
                {preview ? `Lines ${preview.startLine}–${preview.endLine} of ${preview.totalLines}` : readable(target.artifact.role)}
              </p>
            </div>
            <button type="button" onClick={() => { void copyPath(); }} className="lifecycle-source-action" aria-label={`Copy path ${target.artifact.relativePath}`}>
              <Copy size={13} aria-hidden="true" /> Copy path
            </button>
            {allowHostActions && (
              <>
                <SourceArtifactButton artifact={target.artifact} action="open" line={target.startLine} pending={pending} onOpen={onOpen} />
                <SourceArtifactButton artifact={target.artifact} action="reveal" pending={pending} onOpen={onOpen} />
              </>
            )}
          </div>
          {loading && <div className="lifecycle-empty-hint m-4" role="status">Loading bounded source preview…</div>}
          {error && <div className="m-4 rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error" role="alert">{error}</div>}
          {preview && !loading && (
            <div className="lifecycle-source-preview__content">
              {preview.stale && (
                <div className="mb-4 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-[var(--text)]" role="status">
                  This file changed after the lifecycle projection. Refresh the phase before relying on this passage.
                </div>
              )}
              {preview.contentType === 'markdown'
                ? <LifecycleMarkdown content={preview.content} />
                : <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-[var(--text)]">{preview.content}</pre>}
              {preview.truncated && (
                <p className="mt-4 text-xs text-warning">
                  This is a bounded preview.{allowHostActions ? ' Open the artifact for the complete file.' : ''}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </SlideOver>
  );
}

export default function LifecycleSourceWorkspace({
  source,
  view,
  workspaceId,
  specId,
  pending,
  onOpen,
  actionError = null,
  onDismissActionError,
  onRead,
}: LifecycleSourceWorkspaceProps) {
  const [sourceQuery, setSourceQuery] = useState('');
  const [synthesisQuery, setSynthesisQuery] = useState('');
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);
  const [preview, setPreview] = useState<LifecycleSourceArtifactPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [generationDelta, setGenerationDelta] = useState<GenerationDelta | null>(null);
  const [sectionPreviews, setSectionPreviews] = useState<Record<string, LifecycleSourceArtifactPreview>>({});
  const [sectionLoading, setSectionLoading] = useState<Set<string>>(() => new Set());
  const [sectionErrors, setSectionErrors] = useState<Record<string, string>>({});
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(() => queryValue('sourceSection'));
  const synthesisSearchRef = useRef<HTMLInputElement>(null);
  const sourceSearchRef = useRef<HTMLInputElement>(null);
  const previewTriggerRef = useRef<HTMLElement | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const deepLinkedPreviewRef = useRef<string | null>(null);
  const requestedSectionsRef = useRef(new Set<string>());

  const available = source.state === 'available' ? source : null;
  const rawArtifactAccess = available?.authority.status === 'verified'
    && available.package.authoritative === true
    && !onRead;
  const boundedPreviewAccess = Boolean(available && onRead);
  const expandedKey = available
    ? storageKey(EXPANDED_SCHEMA, workspaceId, specId, available.lens)
    : '';
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(expandedKey) ?? '[]');
      return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []);
    } catch {
      return new Set();
    }
  });

  const snapshot = useMemo(() => available ? currentSnapshot(available) : null, [available]);
  useEffect(() => {
    if (!available || !snapshot) return;
    const key = storageKey(HISTORY_SCHEMA, workspaceId, specId, available.lens);
    try {
      setGenerationDelta(observeGeneration(key, snapshot));
    } catch {
      setGenerationDelta(null);
    }
  }, [available, snapshot, specId, workspaceId]);
  useEffect(() => {
    requestedSectionsRef.current.clear();
    setSectionPreviews({});
    setSectionLoading(new Set());
    setSectionErrors({});
  }, [available?.package.contentHash]);


  useEffect(() => {
    if (!available) return;
    const ids = new Set(available.synthesis.sections.map((section) => section.id));
    const hadStoredExpansion = hasStoredValue(expandedKey);
    setExpandedSections((current) => {
      const retained = new Set([...current].filter((id) => ids.has(id)));
      if (retained.size === 0 && !hadStoredExpansion && available.synthesis.sections[0]) {
        retained.add(available.synthesis.sections[0].id);
      }
      return retained;
    });
  }, [available, expandedKey]);

  useEffect(() => {
    if (!expandedKey) return;
    try {
      localStorage.setItem(expandedKey, JSON.stringify([...expandedSections]));
    } catch {
      // Browser storage is an optional UX enhancement.
    }
  }, [expandedKey, expandedSections]);
  const loadSection = useCallback((section: LifecycleSourceSynthesisSection) => {
    if (!onRead || requestedSectionsRef.current.has(section.id)) return;
    requestedSectionsRef.current.add(section.id);
    setSectionLoading((current) => new Set(current).add(section.id));
    setSectionErrors((current) => {
      const next = { ...current };
      delete next[section.id];
      return next;
    });
    void onRead(section.sourcePath, section.startLine, section.endLine)
      .then((loaded) => {
        setSectionPreviews((current) => ({ ...current, [section.id]: loaded }));
      })
      .catch((error: unknown) => {
        setSectionErrors((current) => ({
          ...current,
          [section.id]: error instanceof Error ? error.message : 'Could not load this source passage.',
        }));
      })
      .finally(() => {
        setSectionLoading((current) => {
          const next = new Set(current);
          next.delete(section.id);
          return next;
        });
      });
  }, [onRead]);

  useEffect(() => {
    if (!available) return;
    for (const section of available.synthesis.sections) {
      if (expandedSections.has(section.id) && !sectionPreviews[section.id]) loadSection(section);
    }
  }, [available, expandedSections, loadSection, sectionPreviews]);


  const filteredSections = useMemo(() => {
    if (!available) return [];
    const needle = synthesisQuery.trim().toLocaleLowerCase();
    if (!needle) return available.synthesis.sections;
    return available.synthesis.sections.filter((section) => `${section.title}\n${sectionPreviews[section.id]?.content ?? section.content ?? ''}\n${section.sourcePath}`.toLocaleLowerCase().includes(needle));
  }, [available, sectionPreviews, synthesisQuery]);

  const filteredArtifacts = useMemo(() => {
    if (!available) return [];
    const needle = sourceQuery.trim().toLocaleLowerCase();
    if (!needle) return available.artifacts;
    return available.artifacts.filter((artifact) => `${artifact.name}\n${artifact.label}\n${artifact.role}\n${artifact.relativePath}`.toLocaleLowerCase().includes(needle));
  }, [available, sourceQuery]);

  const closePreview = useCallback(() => {
    setPreviewTarget(null);
    setPreview(null);
    setPreviewError(null);
    setQueryValues({ source: null, sourceLine: null, sourceEnd: null });
  }, []);

  const openPreview = useCallback(async (
    artifact: LifecycleSourceArtifact,
    startLine: number | null = null,
    endLine: number | null = null,
    trigger?: HTMLElement,
  ) => {
    if (!boundedPreviewAccess || !onRead) return;
    previewTriggerRef.current = trigger ?? null;
    setPreviewTarget({ artifact, startLine, endLine });
    setPreview(null);
    setPreviewError(null);
    setQueryValues({
      source: artifact.relativePath,
      sourceLine: startLine ? String(startLine) : null,
      sourceEnd: endLine ? String(endLine) : null,
    });
    setPreviewLoading(true);
    try {
      setPreview(await onRead(artifact.relativePath, startLine, endLine));
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'Could not load the source preview.');
    } finally {
      setPreviewLoading(false);
    }
  }, [boundedPreviewAccess, onRead]);

  const activateSection = useCallback((section: LifecycleSourceSynthesisSection) => {
    setSelectedSectionId(section.id);
    setExpandedSections((current) => new Set(current).add(section.id));
    setQueryValues({ sourceSection: section.id });
    window.requestAnimationFrame(() => {
      const target = sectionRefs.current.get(section.id);
      target?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      target?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    if (!available || view !== 'synthesis') return;
    const sectionId = queryValue('sourceSection');
    const section = available.synthesis.sections.find((candidate) => candidate.id === sectionId);
    if (section) activateSection(section);
  }, [activateSection, available, view]);

  useEffect(() => {
    if (!available || !boundedPreviewAccess || !onRead) return;
    const relativePath = queryValue('source');
    if (!relativePath || deepLinkedPreviewRef.current === relativePath) return;
    const artifact = available.artifacts.find((candidate) => candidate.relativePath === relativePath);
    if (!artifact) return;
    const start = Number(queryValue('sourceLine')) || null;
    const end = Number(queryValue('sourceEnd')) || null;
    deepLinkedPreviewRef.current = relativePath;
    void openPreview(artifact, start, end);
  }, [available, boundedPreviewAccess, onRead, openPreview]);

  useEffect(() => {
    if (!available) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      if (event.key === '/') {
        event.preventDefault();
        (view === 'synthesis' ? synthesisSearchRef.current : view === 'sources' ? sourceSearchRef.current : null)?.focus();
        return;
      }
      if (view !== 'synthesis' || filteredSections.length === 0) return;
      const currentIndex = Math.max(0, filteredSections.findIndex((section) => section.id === selectedSectionId));
      if (event.key === '[' || event.key === ']') {
        event.preventDefault();
        const direction = event.key === ']' ? 1 : -1;
        const next = filteredSections[(currentIndex + direction + filteredSections.length) % filteredSections.length];
        if (next) activateSection(next);
      } else if (event.key.toLocaleLowerCase() === 'o' && rawArtifactAccess) {
        const current = filteredSections[currentIndex];
        if (current) onOpen?.(current.sourcePath, 'open', current.startLine);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activateSection, available, filteredSections, onOpen, rawArtifactAccess, selectedSectionId, view]);

  if (!available) {
    const heading = source.lens === 'planning' ? 'Planning source bundle' : source.lens === 'requirements' ? 'Requirements synthesis' : 'Design synthesis';
    return (
      <section className="lifecycle-source-workspace" aria-labelledby="phase-source-material-heading" data-testid="lifecycle-source-material">
        <h3 id="phase-source-material-heading" className="lifecycle-phase-view__heading">{heading}</h3>
        <div className="lifecycle-empty-hint"><p className="text-sm text-muted">{source.state === 'available' ? 'Source material is unavailable.' : source.rationale}</p></div>
      </section>
    );
  }

  const artifactByPath = new Map(available.artifacts.map((artifact) => [artifact.relativePath, artifact]));
  const updatedSectionKeys = generationDelta?.updatedSectionKeys ?? new Set<string>();

  return (
    <section className="lifecycle-source-workspace" aria-label={`${readable(available.lens)} source intelligence`} data-testid="lifecycle-source-material" data-view={view}>
      <LensIdentity source={available} />
      {!rawArtifactAccess && view === 'sources' && (
        <div className="lifecycle-source-authority-note" role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>Preview is available. Editor open and folder reveal stay locked until this package is canonically published.</span>
        </div>
      )}
      {actionError && (
        <div className="mb-4 rounded-md border border-error/30 bg-error/10 p-3" role="alert">
          <p className="text-sm font-semibold text-[var(--text)]">
            Could not {actionError.action} {actionError.relativePath}.
          </p>
          <p className="mt-1 text-xs text-error">{actionError.message}</p>
          <p className="mt-1 text-xs text-muted">{actionError.remediation}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onOpen?.(actionError.relativePath, actionError.action, actionError.line, actionError.column)}
              disabled={!onOpen || pending !== null}
              className="rounded-md bg-accent px-3 py-2 text-xs font-medium text-[var(--accent-contrast)] hover:bg-accent-hover disabled:cursor-wait disabled:opacity-60"
            >
              {pending ? 'Retrying…' : `Retry ${actionError.action}`}
            </button>
            {onDismissActionError && (
              <button
                type="button"
                onClick={onDismissActionError}
                className="rounded-md border border-border px-3 py-2 text-xs font-medium text-muted hover:text-[var(--text)]"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}
      {view === 'overview' && (
        <div className="space-y-3">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h3 className="lifecycle-phase-view__heading">Source intelligence</h3>
              <p className="text-xs text-muted">The exact source package behind this lifecycle projection.</p>
            </div>
          </div>
          <PackageSummary source={available} delta={generationDelta} />
        </div>
      )}

      {view === 'synthesis' && (
        <div className="lifecycle-synthesis-reader">
          <div className="lifecycle-synthesis-outline">
            <div className="lifecycle-source-search">
              <Search size={14} aria-hidden="true" />
              <input
                ref={synthesisSearchRef}
                type="search"
                value={synthesisQuery}
                onChange={(event) => setSynthesisQuery(event.target.value)}
                placeholder="Search synthesis"
                aria-label="Search synthesis"
                data-lifecycle-source-search
              />
              <kbd>/</kbd>
            </div>
            <nav aria-label="Synthesis sections">
              <p className="lifecycle-source-summary__eyebrow">Sections · {filteredSections.length}</p>
              <ul className="mt-2 space-y-1">
                {filteredSections.map((section) => (
                  <li key={section.id}>
                    <button
                      type="button"
                      onClick={() => activateSection(section)}
                      aria-current={selectedSectionId === section.id ? 'location' : undefined}
                      className="lifecycle-synthesis-outline__item"
                    >
                      <span>{section.title}</span>
                      {(section.freshness === 'stale' || updatedSectionKeys.has(sectionKey(section))) && (
                        <span className="lifecycle-source-freshness" data-tone={section.freshness === 'stale' ? 'stale' : 'updated'}>
                          {section.freshness === 'stale' ? 'stale' : 'updated'}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
            <p className="mt-4 text-[11px] leading-4 text-muted">
              <kbd>[</kbd>/<kbd>]</kbd> sections{rawArtifactAccess ? <> · <kbd>O</kbd> open source</> : ''}
            </p>
          </div>

          <div className="min-w-0">
            <PackageContext source={available} />
            <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-[var(--text)]">{available.synthesis.title}</h3>
                <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">{available.synthesis.description}</p>
              </div>
              <button
                type="button"
                onClick={() => setExpandedSections(new Set(filteredSections.map((section) => section.id)))}
                className="lifecycle-source-action"
              >Expand all</button>
            </div>
            {filteredSections.length === 0 ? (
              <div className="lifecycle-empty-hint mt-4" role="status">No synthesis sections match “{synthesisQuery}”.</div>
            ) : (
              <div className="mt-4 space-y-3">
                {filteredSections.map((section) => {
                  const artifact = artifactByPath.get(section.sourcePath);
                  const expanded = synthesisQuery.trim() !== '' || expandedSections.has(section.id);
                  const updated = updatedSectionKeys.has(sectionKey(section));
                  const loadedSection = sectionPreviews[section.id];
                  const sectionBody = loadedSection?.content ?? section.content ?? '';
                  const loadingSection = sectionLoading.has(section.id);
                  const sectionError = sectionErrors[section.id];
                  return (
                    <article
                      key={section.id}
                      ref={(node) => {
                        if (node) sectionRefs.current.set(section.id, node);
                        else sectionRefs.current.delete(section.id);
                      }}
                      id={`source-section-${section.id}`}
                      tabIndex={-1}
                      className="lifecycle-synthesis-section focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      aria-labelledby={`source-section-heading-${section.id}`}
                    >
                      <div className="lifecycle-synthesis-section__header">
                        <button
                          type="button"
                          onClick={() => setExpandedSections((current) => {
                            const next = new Set(current);
                            if (next.has(section.id)) next.delete(section.id);
                            else next.add(section.id);
                            return next;
                          })}
                          aria-expanded={expanded}
                          className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          <span className="flex items-center gap-2">
                            <ChevronDown size={15} className={`shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`} aria-hidden="true" />
                            <span id={`source-section-heading-${section.id}`} className="text-base font-semibold text-[var(--text)]">{section.title}</span>
                            {(section.freshness === 'stale' || updated) && (
                              <span className="lifecycle-source-freshness" data-tone={section.freshness === 'stale' ? 'stale' : 'updated'}>
                                {section.freshness === 'stale' ? 'stale' : 'updated'}
                              </span>
                            )}
                          </span>
                        </button>
                        {artifact && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            {onRead ? (
                              <button
                                type="button"
                                onClick={(event) => { void openPreview(artifact, section.startLine, section.endLine, event.currentTarget); }}
                                className="lifecycle-citation-chip"
                                aria-label={`Preview ${section.sourcePath} lines ${section.startLine} to ${section.endLine}`}
                              >
                                {basename(section.sourcePath)} · {section.startLine}–{section.endLine}
                              </button>
                            ) : (
                              <span className="lifecycle-citation-chip">
                                {basename(section.sourcePath)} · {section.startLine}–{section.endLine}
                              </span>
                            )}
                            {rawArtifactAccess && (
                              <SourceArtifactButton artifact={artifact} action="open" line={section.startLine} pending={pending} onOpen={onOpen} />
                            )}
                          </div>
                        )}
                      </div>
                      {expanded && (
                        <div className="lifecycle-synthesis-section__content">
                          {loadingSection && <p className="text-sm text-muted" role="status">Loading cited source passage…</p>}
                          {sectionError && (
                            <div className="rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error" role="alert">
                              <p>{sectionError}</p>
                              <button
                                type="button"
                                className="lifecycle-source-action mt-2"
                                onClick={() => {
                                  requestedSectionsRef.current.delete(section.id);
                                  loadSection(section);
                                }}
                              >Retry preview</button>
                            </div>
                          )}
                          {sectionBody && <LifecycleMarkdown content={sectionBody} />}
                          {!loadingSection && !sectionError && !sectionBody && (
                            <p className="text-sm text-muted" role="status">No source passage is available for this section.</p>
                          )}
                          {(loadedSection?.truncated ?? section.truncated) && (
                            <p className="mt-3 text-xs text-warning">This section is a bounded dashboard preview.</p>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
            {generationDelta?.removedSections.length ? (
              <div className="mt-5 rounded-lg border border-warning/30 bg-warning/10 p-4">
                <h4 className="text-sm font-semibold text-[var(--text)]">Stale sections removed by this package generation</h4>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {generationDelta.removedSections.map((title) => <li key={title} className="lifecycle-source-freshness" data-tone="stale">{title}</li>)}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {view === 'sources' && (
        <div className="space-y-4">
          <PackageContext source={available} />
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-[var(--text)]">Package files</h3>
              <p className="mt-1 text-sm text-muted">
                {rawArtifactAccess
                  ? 'Preview content or send the canonical artifact to your editor.'
                  : 'Preview the exact projected content without granting host-file access.'}
              </p>
            </div>
            <div className="lifecycle-source-search w-full sm:w-72">
              <Search size={14} aria-hidden="true" />
              <input
                ref={sourceSearchRef}
                type="search"
                value={sourceQuery}
                onChange={(event) => setSourceQuery(event.target.value)}
                placeholder="Search files"
                aria-label="Search source files"
                data-lifecycle-source-search
              />
              <kbd>/</kbd>
            </div>
          </div>
          <div className="lifecycle-source-files" role="table" aria-label="Raw export artifacts">
            <div className="lifecycle-source-files__header" role="row">
              <span role="columnheader">File</span>
              <span role="columnheader">Role</span>
              <span role="columnheader">Size</span>
              <span role="columnheader" className="sr-only">Actions</span>
            </div>
            {filteredArtifacts.map((artifact) => (
              <div key={artifact.relativePath} className="lifecycle-source-files__row" role="row">
                <span className="min-w-0" role="cell">
                  <span className="block truncate text-sm font-medium text-[var(--text)]" title={artifact.relativePath}>{artifact.name}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted">{artifact.label}</span>
                </span>
                <span className="text-xs text-muted" role="cell">{readable(artifact.role)}</span>
                <span className="text-xs tabular-nums text-muted" role="cell">{formatBytes(artifact.sizeBytes)}</span>
                <span className="flex items-center justify-end gap-1.5" role="cell">
                  <button
                    type="button"
                    onClick={(event) => { void openPreview(artifact, null, null, event.currentTarget); }}
                    disabled={!onRead}
                    title={onRead ? undefined : 'Preview is unavailable'}
                    className="lifecycle-source-action disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Eye size={13} aria-hidden="true" /> Preview
                  </button>
                  <details className="lifecycle-source-menu">
                    <summary role="button" aria-label={`More actions for ${artifact.relativePath}`}><MoreHorizontal size={15} aria-hidden="true" /></summary>
                    <div>
                      {rawArtifactAccess && (
                        <>
                          <SourceArtifactButton artifact={artifact} action="open" pending={pending} onOpen={onOpen} />
                          <SourceArtifactButton artifact={artifact} action="reveal" pending={pending} onOpen={onOpen} />
                        </>
                      )}
                      <button type="button" className="lifecycle-source-action" onClick={() => { void navigator.clipboard.writeText(artifact.relativePath); }}>
                        <Copy size={13} aria-hidden="true" /> Copy path
                      </button>
                    </div>
                  </details>
                </span>
              </div>
            ))}
          </div>
          {filteredArtifacts.length === 0 && <div className="lifecycle-empty-hint" role="status">No source files match “{sourceQuery}”.</div>}
        </div>
      )}

      <PreviewDrawer
        target={previewTarget}
        preview={preview}
        loading={previewLoading}
        error={previewError}
        restoreFocusRef={previewTriggerRef}
        pending={pending}
        onClose={closePreview}
        allowHostActions={rawArtifactAccess}
        onOpen={onOpen}
      />
    </section>
  );
}
