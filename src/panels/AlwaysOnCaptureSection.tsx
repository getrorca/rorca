/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router';
import { AlertTriangle, Check, Clock, Copy, Eye, GitBranch, Shield } from 'lucide-react';
import { CONTEXT_TRUST_TIERS, type ContextTrustTier } from '../../shared/contracts/trust';
import { useGlobalToast } from '../contexts/ToastContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { ApiError, apiFetch, BASE_URL } from '../lib/apiFetch';

type SourceStatus = 'active' | 'healthy' | 'degraded' | 'offline' | 'disabled';
type CandidateStatus = 'all' | 'pending' | 'approved' | 'rejected' | 'duplicate' | 'superseded' | 'conflict' | 'deferred';
type CandidateAction = 'approve' | 'reject' | 'edit-and-approve';

type CaptureStatusResponse = {
  ok: boolean;
  workspace: { id: string; label: string; path: string };
  status: {
    policyMode: string;
    paused: boolean;
    queueDepth: number;
    lastCapturedEvent?: { occurredAt: string | null; eventType: string | null; integrationId: string | null; redactionDiagnostics?: RedactionDiagnostics };
    auditLog: Array<{ id: string; eventType: string; integrationId: string; occurredAt: string; redactionDiagnostics?: RedactionDiagnostics; regulatedFlags?: string[] }>;
  };
  capability: {
    captureCapability: {
      overall: string;
      sources: Record<string, { status?: SourceStatus; reason?: string; tools?: string[]; fallbackSources?: string[]; requiredMetadata?: string[] }>;
      policy: { version: string; availableModes: string[]; rawContentDefault: string };
      distillation: { queueName: string; defaultMode: string; modes: string[] };
    };
  } | { overall: string; sources: Record<string, { status?: SourceStatus; reason?: string; tools?: string[]; fallbackSources?: string[]; requiredMetadata?: string[] }> };
};

type RedactionDiagnostics = {
  redactionCount: number;
  ignoredPathCount: number;
  redactionTypes: string[];
  regulatedSignals: string[];
  regulatedDomainFlags: string[];
  truncated: boolean;
};

type EvidenceSnippet = { text: string; sourceField: string; redacted: boolean };
type CandidatePreview = {
  workspaceRelativePath: string;
  byteLength: number;
  truncated: boolean;
  content: string;
  redactionDiagnostics: RedactionDiagnostics;
};
type Candidate = {
  id: number;
  created_at: string;
  status: Exclude<CandidateStatus, 'all'>;
  category: string | null;
  content: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  provenance: Record<string, unknown> | null;
  related_files: Array<string | { path: string; role?: string | null; hash?: string | null }> | null;
  evidence_snippets: EvidenceSnippet[] | null;
  review_reason: string | null;
  security_sensitive: boolean;
  event_type: string | null;
  source_system: string | null;
  tool_name: string | null;
  host_application: string | null;
  session_id: string | null;
  trust_tier: ContextTrustTier | null;
  source_session_id: string | null;
  git_branch: string | null;
  git_sha: string | null;
  capture_policy: Record<string, unknown> | null;
};

type CanonicalCandidate = {
  id: string;
  createdAt: string;
  reviewStatus: Exclude<CandidateStatus, 'all'>;
  suggestedCategory: string;
  title: string;
  rule: string;
  context: string;
  confidence: 'high' | 'medium' | 'low';
  provenance: Record<string, unknown>;
  relatedFiles: string[];
  securitySensitive: boolean;
  eventType: string | null;
  sourceSystem: string | null;
  trustTier: ContextTrustTier;
  requiresReview: boolean;
};

type CandidateResponse = { items?: CanonicalCandidate[]; candidates?: Candidate[] };

type Filters = {
  sourceSystem: string;
  eventType: string;
  trustTier: string;
  confidence: string;
  status: CandidateStatus;
};

const FILTER_PARAMS: Record<keyof Filters, string> = {
  sourceSystem: 'uccSourceSystem',
  eventType: 'uccEventType',
  trustTier: 'uccTrustTier',
  confidence: 'uccConfidence',
  status: 'uccStatus',
};

const SOURCE_LABELS: Record<string, string> = {
  pi: 'Pi',
  claude_code: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  shell: 'Shell',
  vscode: 'VS Code',
  'vscode-fork': 'Cursor/Windsurf/VSCodium',
  repo_daemon: 'Git daemon',
  git_hook: 'Git hook',
  ci: 'CI',
  external_import: 'Imports',
  agent_adapter: 'Agent adapter',
  mcp: 'MCP',
  repoDaemon: 'Git daemon',
  gitHook: 'Git hook',
  shellIntegration: 'Shell',
  vscodeExtension: 'VS Code',
  mcpSlashCommand: 'MCP',
  agentAdapters: 'Agent adapters',
};

const EVENT_TYPES = ['agent_cli_session', 'shell_command', 'ide_session', 'editor_activity', 'explicit_memory', 'git_commit', 'ci_pr'];
const REVIEW_STATUSES: CandidateStatus[] = ['all', 'pending', 'approved', 'rejected', 'duplicate', 'superseded', 'conflict', 'deferred'];
const CONFIDENCE = ['high', 'medium', 'low'];

function initialFilters(searchParams: URLSearchParams): Filters {
  return {
    sourceSystem: searchParams.get(FILTER_PARAMS.sourceSystem) ?? '',
    eventType: searchParams.get(FILTER_PARAMS.eventType) ?? '',
    trustTier: searchParams.get(FILTER_PARAMS.trustTier) ?? '',
    confidence: searchParams.get(FILTER_PARAMS.confidence) ?? '',
    status: (searchParams.get(FILTER_PARAMS.status) as CandidateStatus | null) ?? 'all',
  };
}

function relatedFilePaths(candidate: Candidate): string[] {
  if (!Array.isArray(candidate.related_files)) return [];
  return candidate.related_files.flatMap((item) => {
    if (typeof item === 'string') return item ? [item] : [];
    return item?.path ? [item.path] : [];
  });
}

/**
 * The Always-On panel used to call a retired capture-distillation response.
 * Adapt the canonical context-candidates DTO at this boundary so the compact
 * review view retains its existing presentation without maintaining a second
 * backend contract.
 */
function adaptCandidate(candidate: CanonicalCandidate): Candidate {
  return {
    id: Number(candidate.id),
    created_at: candidate.createdAt,
    status: candidate.reviewStatus,
    category: candidate.suggestedCategory,
    content: candidate.rule,
    confidence: candidate.confidence,
    provenance: candidate.provenance,
    related_files: candidate.relatedFiles.map((path) => ({ path })),
    evidence_snippets: [],
    review_reason: candidate.requiresReview ? 'Explicit review required.' : null,
    security_sensitive: candidate.securitySensitive,
    event_type: candidate.eventType,
    source_system: candidate.sourceSystem,
    tool_name: null,
    host_application: null,
    session_id: null,
    trust_tier: candidate.trustTier,
    source_session_id: null,
    git_branch: null,
    git_sha: null,
    capture_policy: null,
  };
}

function appErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : fallback;
}

function statusStyle(status: SourceStatus | string | undefined): CSSProperties {
  if (status === 'active' || status === 'healthy') return { color: 'var(--status-healthy)', borderColor: 'var(--status-healthy)', background: 'var(--status-healthy-bg)' };
  if (status === 'degraded') return { color: 'var(--status-degraded)', borderColor: 'var(--status-degraded)', background: 'var(--status-degraded-bg)' };
  return { color: 'var(--status-offline)', borderColor: 'var(--status-offline)', background: 'var(--status-offline-bg)' };
}

function capabilityFromStatus(status: CaptureStatusResponse | null) {
  if (!status?.capability) return null;
  const capability = 'captureCapability' in status.capability ? status.capability.captureCapability : status.capability;
  return capability;
}

export default function AlwaysOnCaptureSection() {
  const { workspaceId } = useWorkspace();
  const toast = useGlobalToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => initialFilters(searchParams));
  const [status, setStatus] = useState<CaptureStatusResponse | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<number | null>(null);
  const [previewByPath, setPreviewByPath] = useState<Record<string, CandidatePreview>>({});
  const [editText, setEditText] = useState('');

  useEffect(() => {
    setFilters(initialFilters(searchParams));
  }, [searchParams]);

  const updateFilter = (key: keyof Filters, value: string) => {
    const next = new URLSearchParams(searchParams);
    const param = FILTER_PARAMS[key];
    if (value && !(key === 'status' && value === 'all')) next.set(param, value);
    else next.delete(param);
    setSearchParams(next, { replace: true });
  };

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '50', status: filters.status });
      if (filters.sourceSystem) params.set('sourceSystem', filters.sourceSystem);
      if (filters.eventType) params.set('eventType', filters.eventType);
      if (filters.trustTier) params.set('trustTier', filters.trustTier);
      if (filters.confidence) params.set('confidence', filters.confidence);
      const [nextStatus, nextCandidates] = await Promise.all([
        apiFetch<CaptureStatusResponse>(`/api/context-capture/${encodeURIComponent(workspaceId)}/status`),
        apiFetch<CandidateResponse>(`/api/context-candidates?workspaceId=${encodeURIComponent(workspaceId)}&${params.toString()}`),
      ]);
      const candidateItems = Array.isArray(nextCandidates.items)
        ? nextCandidates.items.map(adaptCandidate)
        : Array.isArray(nextCandidates.candidates)
          ? nextCandidates.candidates
          : [];
      setStatus(nextStatus);
      setCandidates(candidateItems);
      setSelectedCandidateId((current) => current ?? candidateItems[0]?.id ?? null);
    } catch (err) {
      const message = appErrorMessage(err, 'Always-on capture status unavailable.');
      setError(message);
      setCandidates([]);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [filters, workspaceId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!workspaceId) return;
    const es = new EventSource(`${BASE_URL}/api/context-capture/${encodeURIComponent(workspaceId)}/stream`);
    const refresh = () => { void load(); };
    es.addEventListener('capture_event', refresh);
    return () => es.close();
  }, [load, workspaceId]);

  const capability = capabilityFromStatus(status);
  const auditCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const entry of status?.status?.auditLog ?? []) counts[entry.eventType] = (counts[entry.eventType] ?? 0) + 1;
    return counts;
  }, [status]);
  const selected = candidates.find((candidate) => candidate.id === selectedCandidateId) ?? candidates[0] ?? null;
  const selectedFiles = selected ? relatedFilePaths(selected) : [];

  const runAction = async (candidate: Candidate, action: CandidateAction) => {
    if (!workspaceId) return;
    setBusyAction(`${candidate.id}:${action}`);
    try {
      const endpoint = action === 'edit-and-approve' ? 'edit-and-approve' : action;
      const body = action === 'edit-and-approve'
        ? { workspaceId, reviewer: 'local-user', edits: { rule: editText || candidate.content || '' } }
        : { workspaceId, reviewer: 'local-user' };
      await apiFetch(`/api/context-candidates/${candidate.id}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      toast.success(`Candidate ${action.replaceAll('-', ' ')} succeeded.`);
      setEditText('');
      await load();
    } catch (err) {
      toast.error(appErrorMessage(err, `Unable to ${action.replaceAll('-', ' ')} candidate.`));
    } finally {
      setBusyAction(null);
    }
  };

  const loadPreview = async (candidate: Candidate, filePath: string) => {
    if (!workspaceId) return;
    try {
      const params = new URLSearchParams({ workspaceId, path: filePath });
      const response = await apiFetch<{
        preview: { path: string; byteLength: number; truncated: boolean; text: string; redactionApplied: boolean; safety: { findings: Array<{ name: string }> } };
      }>(`/api/context-candidates/${candidate.id}/file-preview?${params.toString()}`);
      setPreviewByPath((current) => ({
        ...current,
        [filePath]: {
          workspaceRelativePath: response.preview.path,
          byteLength: response.preview.byteLength,
          truncated: response.preview.truncated,
          content: response.preview.text,
          redactionDiagnostics: {
            redactionCount: response.preview.redactionApplied ? 1 : 0,
            ignoredPathCount: 0,
            redactionTypes: response.preview.safety.findings.map((finding) => finding.name),
            regulatedSignals: [],
            regulatedDomainFlags: [],
            truncated: response.preview.truncated,
          },
        },
      }));
    } catch (err) {
      toast.error(appErrorMessage(err, 'Unable to load safe file preview.'));
    }
  };

  if (loading) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 p-4" aria-label="Always-On Capture">
        <div className="flex items-center gap-3 text-xs text-muted">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span>Loading always-on capture status…</span>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 p-4" aria-label="Always-On Capture">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]"><AlertTriangle size={16} /> Always-On Capture</div>
        <p className="mt-2 rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">{error}</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-border bg-surface-100/70 p-4" aria-label="Always-On Capture">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">Always-On Capture</h2>
          <p className="mt-0.5 text-[11px] text-muted">Live source health, capability coverage, queue depth, and context candidate review.</p>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[10px] text-muted">
          <span className="rounded-full border border-border bg-bg px-2 py-0.5" aria-label={`Capture queue depth ${status?.status?.queueDepth ?? 0}`}>Queue depth {status?.status?.queueDepth ?? 0}</span>
          <span className="rounded-full border border-border bg-bg px-2 py-0.5">Policy {status?.status?.policyMode ?? 'unknown'}</span>
          <span className="rounded-full border px-2 py-0.5" style={statusStyle(status?.status?.paused ? 'offline' : capability?.overall)} role="status" aria-label={`Capture service ${status?.status?.paused ? 'paused' : capability?.overall ?? 'unknown'}`}>{status?.status?.paused ? 'Paused' : capability?.overall ?? 'Unknown'}</span>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-bg p-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Source status and capabilities</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {Object.entries(capability?.sources ?? {}).map(([source, info]) => (
                <div key={source} className="rounded-md border border-border bg-surface-100 px-2.5 py-2 text-[11px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-[var(--text)]">{SOURCE_LABELS[source] ?? source}</span>
                    <span className="rounded-full border px-2 py-0.5 text-[10px]" style={statusStyle(info.status)} role="status" aria-label={`${SOURCE_LABELS[source] ?? source} ${info.status ?? 'unknown'}`}>{info.status ?? 'unknown'}</span>
                  </div>
                  {info.reason && <p className="mt-1 text-muted">{info.reason}</p>}
                  {info.tools && <p className="mt-1 text-muted">Tools: {info.tools.join(', ')}</p>}
                  {info.fallbackSources && <p className="mt-1 text-muted">Fallbacks: {info.fallbackSources.join(', ')}</p>}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-bg p-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Recent event counts</p>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-muted">
              {Object.keys(auditCounts).length === 0 ? <span>No recent capture events</span> : Object.entries(auditCounts).map(([eventType, count]) => (
                <span key={eventType} className="rounded-full border border-border bg-surface-100 px-2 py-0.5">{eventType}: {count}</span>
              ))}
            </div>
            {status?.status?.lastCapturedEvent?.occurredAt && (
              <p className="mt-2 text-[11px] text-muted">Last event: {status.status.lastCapturedEvent.eventType} via {status.status.lastCapturedEvent.integrationId}</p>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-bg p-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Candidate review filters</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <input aria-label="Filter source system" value={filters.sourceSystem} onChange={(e) => updateFilter('sourceSystem', e.target.value)} placeholder="source system" className="rounded border border-border bg-surface-100 px-2 py-1.5 text-xs text-[var(--text)]" />
              <select aria-label="Filter event type" value={filters.eventType} onChange={(e) => updateFilter('eventType', e.target.value)} className="rounded border border-border bg-surface-100 px-2 py-1.5 text-xs text-[var(--text)]"><option value="">All event types</option>{EVENT_TYPES.map((item) => <option key={item} value={item}>{item}</option>)}</select>
              <select aria-label="Filter trust tier" value={filters.trustTier} onChange={(e) => updateFilter('trustTier', e.target.value)} className="rounded border border-border bg-surface-100 px-2 py-1.5 text-xs text-[var(--text)]"><option value="">All trust tiers</option>{CONTEXT_TRUST_TIERS.map((tier) => <option key={tier} value={tier}>{tier}</option>)}</select>
              <select aria-label="Filter confidence" value={filters.confidence} onChange={(e) => updateFilter('confidence', e.target.value)} className="rounded border border-border bg-surface-100 px-2 py-1.5 text-xs text-[var(--text)]"><option value="">All confidence</option>{CONFIDENCE.map((item) => <option key={item} value={item}>{item}</option>)}</select>
              <select aria-label="Filter review status" value={filters.status} onChange={(e) => updateFilter('status', e.target.value)} className="rounded border border-border bg-surface-100 px-2 py-1.5 text-xs text-[var(--text)]">{REVIEW_STATUSES.map((item) => <option key={item} value={item}>{item}</option>)}</select>
            </div>
          </div>

          <div className="grid gap-3 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <ul className="max-h-[520px] space-y-2 overflow-auto rounded-lg border border-border bg-bg p-2" aria-label="Context memory candidates">
              {candidates.length === 0 && <li className="px-2 py-3 text-xs text-muted">No candidates match the current filters.</li>}
              {candidates.map((candidate) => (
                <li key={candidate.id}>
                  <button type="button" onClick={() => setSelectedCandidateId(candidate.id)} className={`w-full rounded-md border px-2.5 py-2 text-left text-xs transition-colors ${selected?.id === candidate.id ? 'border-accent bg-surface-200' : 'border-border bg-surface-100 hover:bg-surface-200'}`} aria-pressed={selected?.id === candidate.id}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full border border-border px-2 py-0.5 text-[10px]" role="status" aria-label={`Review status ${candidate.status}`}>{candidate.status}</span>
                      <span className="rounded-full border border-border px-2 py-0.5 text-[10px]">{SOURCE_LABELS[candidate.source_system ?? ''] ?? candidate.source_system ?? 'unknown'}</span>
                      <span className="rounded-full border border-border px-2 py-0.5 text-[10px]"><Shield size={10} className="inline" /> {candidate.trust_tier ?? 'local'}</span>
                      {candidate.security_sensitive && <span className="rounded-full border px-2 py-0.5 text-[10px]" style={statusStyle('degraded')}><AlertTriangle size={10} className="inline" /> redaction</span>}
                    </div>
                    <p className="mt-1 line-clamp-2 text-[var(--text)]">{candidate.content}</p>
                  </button>
                </li>
              ))}
            </ul>

            {selected && (
              <div className="rounded-lg border border-border bg-bg p-3 text-xs text-muted" aria-label="Candidate detail">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-[var(--text)]">Candidate #{selected.id}</p>
                    <p className="mt-0.5">{selected.event_type ?? 'unknown event'} · {SOURCE_LABELS[selected.source_system ?? ''] ?? selected.source_system ?? 'unknown source'}</p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(['approve', 'reject'] as CandidateAction[]).map((action) => (
                      <button key={action} type="button" onClick={() => runAction(selected, action)} disabled={busyAction === `${selected.id}:${action}`} className="rounded border border-border bg-surface-100 px-2 py-1 text-[11px] font-medium text-[var(--text)] hover:bg-surface-200 disabled:opacity-60" aria-label={`${action} candidate ${selected.id}`}>{action}</button>
                    ))}
                  </div>
                </div>

                <textarea aria-label="Edit candidate content" value={editText || selected.content || ''} onChange={(event) => setEditText(event.target.value)} className="mt-3 h-20 w-full rounded border border-border bg-surface-100 px-2 py-1.5 text-xs text-[var(--text)]" />
                <button type="button" onClick={() => runAction(selected, 'edit-and-approve')} disabled={busyAction === `${selected.id}:edit-and-approve`} className="mt-2 rounded border border-accent bg-surface-100 px-2 py-1 text-[11px] font-medium text-[var(--text)] hover:bg-surface-200" aria-label={`edit and approve candidate ${selected.id}`}><Check size={11} className="inline" /> Edit and approve</button>

                <div className="mt-3 grid gap-2">
                  <div className="rounded-md border border-border bg-surface-100 p-2">
                    <p className="font-medium text-[var(--text)]">Evidence</p>
                    {(selected.evidence_snippets ?? []).map((snippet, index) => (
                      <p key={`${snippet.sourceField}-${index}`} className="mt-1 rounded border border-border bg-bg px-2 py-1">{snippet.redacted && <span className="mr-1" aria-label="redaction marker">[redacted]</span>}{snippet.sourceField}: {snippet.text}</p>
                    ))}
                  </div>
                  <div className="rounded-md border border-border bg-surface-100 p-2">
                    <p className="font-medium text-[var(--text)]">Provenance and session</p>
                    <p>source session: {selected.source_session_id ?? selected.session_id ?? 'unknown'}</p>
                    <p>source event: {String(selected.provenance?.sourceEventId ?? selected.provenance?.source_event_id ?? selected.id)}</p>
                    <p><GitBranch size={11} className="inline" /> {selected.git_branch ?? 'no branch'} · {selected.git_sha ?? 'no sha'}</p>
                    <p><Clock size={11} className="inline" /> {new Date(selected.created_at).toLocaleString()}</p>
                  </div>
                  <div className="rounded-md border border-border bg-surface-100 p-2">
                    <p className="font-medium text-[var(--text)]">Related files and safe previews</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {selectedFiles.map((filePath) => (
                        <button key={filePath} type="button" onClick={() => loadPreview(selected, filePath)} className="rounded border border-border bg-bg px-2 py-0.5 font-mono text-[10px] hover:bg-surface-200" aria-label={`Preview ${filePath}`}><Eye size={10} className="inline" /> {filePath}</button>
                      ))}
                    </div>
                    {Object.entries(previewByPath).filter(([filePath]) => selectedFiles.includes(filePath)).map(([filePath, preview]) => (
                      <div key={filePath} className="mt-2 rounded border border-border bg-bg p-2">
                        <p className="flex flex-wrap items-center gap-1 text-[11px]"><Copy size={10} /> {preview.workspaceRelativePath} · {preview.byteLength} bytes {preview.truncated ? '· truncated' : ''}</p>
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface-100 p-2 text-[11px] text-[var(--text)]">{preview.content}</pre>
                        <p className="mt-1 text-[10px]">redactions {preview.redactionDiagnostics.redactionCount}; ignored paths {preview.redactionDiagnostics.ignoredPathCount}; types {preview.redactionDiagnostics.redactionTypes.join(', ') || 'none'}</p>
                      </div>
                    ))}
                  </div>
                  <div className="rounded-md border border-border bg-surface-100 p-2">
                    <p className="font-medium text-[var(--text)]">Redaction diagnostics</p>
                    <p>{selected.security_sensitive ? 'Regulated or security-sensitive marker present.' : 'No regulated flag on candidate.'}</p>
                    {selected.review_reason && <p>Review reason: {selected.review_reason}</p>}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
