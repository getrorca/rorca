/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Users } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';

interface Team {
  id: string;
  name: string;
  slug: string;
}

type LayerTab = 1 | 2;

const LAYER_LABELS: Record<LayerTab, string> = {
  1: 'Team Standards',
  2: 'Team Conventions',
};

export default function TeamDirectionPanel() {
  const { workspaceId } = useWorkspace();
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<LayerTab>(1);

  // Layer content
  const [l1, setL1Raw] = useState('');
  const [l2, setL2Raw] = useState('');
  const [savedL1, setSavedL1] = useState('');
  const [savedL2, setSavedL2] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [_isDirty, setIsDirty] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Preview
  const [synthesized, setSynthesized] = useState('');
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const synthTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load teams list
  useEffect(() => {
    apiFetch<{ items: Team[]; total: number; hasMore: boolean; cursor?: string }>('/api/teams')
      .then((data) => {
        // API may return array or {teams: [...]}
        const list = data.items;
        setTeams(list);
        if (list.length > 0 && !selectedTeamId) {
          setSelectedTeamId(list[0].id);
        }
      })
      .catch(console.error);
  }, []);

  // Load team direction layers when team changes
  useEffect(() => {
    if (!selectedTeamId) return;
    apiFetch<{ l1: string; l2: string }>(`/api/teams/${selectedTeamId}/direction`)
      .then((data) => {
        setL1Raw(data.l1);
        setL2Raw(data.l2);
        setSavedL1(data.l1);
        setSavedL2(data.l2);
        setIsDirty(false);
      })
      .catch(console.error);
  }, [selectedTeamId]);

  // Auto-save helper
  const saveLayer = useCallback(
    (layer: 1 | 2, value: string) => {
      if (!selectedTeamId) return;
      setIsSaving(true);
      apiFetch<{ ok: boolean }>(`/api/teams/${selectedTeamId}/direction`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layer, contentYaml: value }),
      })
        .then(() => {
          if (layer === 1) setSavedL1(value);
          else setSavedL2(value);
          setIsDirty(false);
        })
        .catch(console.error)
        .finally(() => setIsSaving(false));
    },
    [selectedTeamId],
  );

  const setContent = useCallback(
    (value: string) => {
      if (activeTab === 1) setL1Raw(value);
      else setL2Raw(value);
      setIsDirty(true);

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveLayer(activeTab, value);
      }, 500);
    },
    [activeTab, saveLayer],
  );

  // Synthesized preview (debounced)
  const doPreview = useCallback(() => {
    if (!selectedTeamId) return;
    setIsSynthesizing(true);
    apiFetch<{ synthesized: string }>(`/api/teams/${selectedTeamId}/direction/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, specBrief: '(preview)' }),
    })
      .then((data) => setSynthesized(data.synthesized))
      .catch(console.error)
      .finally(() => setIsSynthesizing(false));
  }, [selectedTeamId, workspaceId]);

  useEffect(() => {
    if (synthTimerRef.current) clearTimeout(synthTimerRef.current);
    synthTimerRef.current = setTimeout(doPreview, 400);
    return () => {
      if (synthTimerRef.current) clearTimeout(synthTimerRef.current);
    };
  }, [l1, l2, doPreview]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const activeContent = activeTab === 1 ? l1 : l2;
  const layerIsDirty = activeTab === 1 ? l1 !== savedL1 : l2 !== savedL2;

  const handleCopy = () => {
    navigator.clipboard.writeText(synthesized).catch(console.error);
  };

  if (teams.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center text-center max-w-md px-6">
          <Users size={48} className="text-[var(--text-muted)] opacity-40 mb-4" />
          <h3 className="text-lg font-semibold text-[var(--text)] mb-2">No team direction layers</h3>
          <p className="text-sm text-[var(--text-muted)]">
            Team direction layers let you share L1 and L2 conventions across all team members. Create a team in Settings to add team-scoped direction.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      role="main"
      aria-label="Team Direction"
      className="flex flex-col sm:flex-row h-full gap-px bg-border"
    >
      {/* Column 1: Team selector + L1/L2 editor */}
      <div className="flex-1 flex flex-col bg-bg min-w-0 min-h-[40%] sm:min-h-0">
        {/* Team selector */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <label htmlFor="team-direction-select" className="text-xs font-medium text-muted whitespace-nowrap">Team:</label>
          <select
            id="team-direction-select"
            value={selectedTeamId ?? ''}
            onChange={(e) => setSelectedTeamId(e.target.value)}
            className="flex-1 text-xs bg-panel border border-border rounded px-2 py-1 text-text"
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>

        {/* Tab bar */}
        <div
          role="tablist"
          aria-label="Direction layers"
          className="flex border-b border-border"
        >
          {([1, 2] as const).map((n) => (
            <button
              key={n}
              role="tab"
              aria-selected={activeTab === n}
              aria-controls={`team-direction-panel-${n}`}
              id={`team-direction-tab-${n}`}
              onClick={() => setActiveTab(n)}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors relative ${
                activeTab === n
                  ? 'text-text border-b-2 border-accent'
                  : 'text-muted hover:text-text'
              }`}
            >
              {LAYER_LABELS[n]}
              {(n === 1 ? l1 !== savedL1 : l2 !== savedL2) && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning ml-1.5 opacity-60" aria-label="Unsaved changes" />
              )}
              {isSaving && layerIsDirty && activeTab === n && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent ml-1.5 animate-pulse" aria-label="Saving" />
              )}
            </button>
          ))}
        </div>

        {/* Info banner */}
        <div className="px-3 py-2 text-xs text-muted border-b border-border bg-panel/50">
          Team direction layers apply to all workspaces in this team. They override global defaults but are overridden by workspace-specific Project layers.
        </div>

        {/* Editor */}
        <textarea
          id={`team-direction-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`team-direction-tab-${activeTab}`}
          value={activeContent}
          onChange={(e) => setContent(e.target.value)}
          aria-label={`${LAYER_LABELS[activeTab]} content (YAML)`}
          className="flex-1 w-full p-3 font-mono text-sm bg-bg text-text border-none outline-none resize-none"
          placeholder={`Enter ${LAYER_LABELS[activeTab]} content (YAML)...`}
          spellCheck={false}
        />
      </div>

      {/* Column 2: Synthesized preview */}
      <div className="flex-1 flex flex-col bg-bg min-w-0 min-h-[40%] sm:min-h-0">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-xs font-medium text-muted">
            Merged Preview
            <span className="ml-2 text-muted opacity-60">
              {synthesized.length.toLocaleString()} chars
            </span>
          </span>
          <button
            onClick={handleCopy}
            aria-label="Copy merged preview to clipboard"
            className="px-2 py-1 text-xs text-muted hover:text-text transition-colors"
          >
            Copy
          </button>
        </div>
        <div className="px-3 py-2 text-xs text-muted border-b border-border bg-panel/50">
          Shows how team Standards/Conventions merge with global layers and workspace Project context.
          Team layers override global defaults.
        </div>
        <div
          className="flex-1 overflow-auto p-3"
          aria-label="Merged direction preview"
          aria-live="polite"
          aria-busy={isSynthesizing}
        >
          {isSynthesizing ? (
            <div className="flex items-center gap-2 text-muted text-sm" aria-label="Synthesizing preview">
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Synthesizing...
            </div>
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-sm text-text">
              {synthesized || <span className="text-muted">No output yet. Add content to team layers.</span>}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
