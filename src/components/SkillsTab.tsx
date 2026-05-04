/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Wrench, Loader2, RefreshCw, CheckCircle2, XCircle, Circle, X } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useIsMobile } from '../hooks/useIsMobile';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SkillEntry {
  name: string;
  relevance: number | null;
  reason: string | null;
  description: string | null;
  category: string | null;
}

interface PerStorySkills {
  storyId: string;
  storyTitle: string;
  storyStatus: string;
  skills: SkillEntry[];
}

interface SkillFrequency {
  name: string;
  count: number;
  passRate: number;
  category: string | null;
}

interface SkillsSummary {
  totalSkillInjections: number;
  uniqueSkills: string[];
  skillFrequency: SkillFrequency[];
  storiesWithSkills: number;
  storiesWithoutSkills: number;
}

interface SkillsData {
  runId: number;
  perStory: PerStorySkills[];
  summary: SkillsSummary;
}

// ─── Status Icons ───────────────────────────────────────────────────────────

function StoryStatusIcon({ status }: { status: string }) {
  if (status === 'pass') return <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />;
  if (status === 'fail') return <XCircle size={14} className="text-red-500 shrink-0" />;
  return <Circle size={14} className="text-gray-400 shrink-0" />;
}

// ─── Skill Badge ────────────────────────────────────────────────────────────

function SkillBadge({
  skill,
  isExpanded,
  onClick,
}: {
  skill: SkillEntry;
  isExpanded: boolean;
  onClick: () => void;
}) {
  const colorClass =
    skill.relevance != null && skill.relevance >= 8
      ? 'bg-emerald-500/10 text-emerald-500'
      : skill.relevance != null && skill.relevance >= 5
        ? 'bg-blue-500/10 text-blue-500'
        : 'bg-gray-500/10 text-gray-400';

  const tooltipText = skill.relevance != null
    ? `${skill.name} (relevance: ${skill.relevance}) — ${skill.reason || 'No reason provided'}`
    : skill.name;

  return (
    <span
      className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full cursor-pointer hover:ring-1 hover:ring-accent/30 transition-all ${colorClass} ${isExpanded ? 'ring-1 ring-accent/50' : ''}`}
      title={tooltipText}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
    >
      {skill.name}
    </span>
  );
}

// ─── Expanded Skill Content ─────────────────────────────────────────────────

function ExpandedSkillContent({
  skillName,
  contentCache,
  onCacheSet,
  onClose,
}: {
  skillName: string;
  contentCache: Map<string, string>;
  onCacheSet: (name: string, content: string) => void;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(contentCache.get(skillName) ?? null);
  const [loading, setLoading] = useState(!contentCache.has(skillName));
  const [notFound, setNotFound] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentCache.has(skillName)) {
      setContent(contentCache.get(skillName)!);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ content: string }>(`/api/skills/${encodeURIComponent(skillName)}/content`);
        if (cancelled) return;
        const text = res.content ?? '';
        setContent(text);
        onCacheSet(skillName, text);
      } catch {
        if (cancelled) return;
        setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [skillName, contentCache, onCacheSet]);

  // Animate in
  useEffect(() => {
    const el = panelRef.current;
    if (el) {
      el.style.maxHeight = '0px';
      el.style.opacity = '0';
      requestAnimationFrame(() => {
        el.style.maxHeight = `${el.scrollHeight + 50}px`;
        el.style.opacity = '1';
      });
    }
  }, []);

  const wordCount = content ? content.split(/\s+/).length : 0;
  const estimatedTokens = content ? Math.ceil(content.length / 4) : 0;

  return (
    <div
      ref={panelRef}
      className="overflow-hidden"
      style={{ transition: 'max-height 150ms ease-in-out, opacity 150ms ease-in-out' }}
    >
      <div className="mt-2 ml-6 bg-bg rounded-lg border border-border/50 p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-xs">{skillName}</span>
            {content && (
              <span className="text-[10px] text-muted">
                {wordCount} words (~{estimatedTokens} tokens)
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-0.5 rounded hover:bg-border/50 transition-colors text-muted hover:text-[var(--text)]"
            aria-label="Close skill content"
          >
            <X size={12} />
          </button>
        </div>
        {loading ? (
          <div className="flex items-center gap-1.5 text-muted text-xs py-2">
            <Loader2 size={12} className="animate-spin" />
            Loading skill content...
          </div>
        ) : notFound ? (
          <span className="text-muted italic text-xs">
            Skill content unavailable (may have been uninstalled)
          </span>
        ) : (
          <pre className="text-xs font-mono bg-bg rounded p-3 max-h-[300px] overflow-y-auto whitespace-pre-wrap border border-border/50">
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}

// ─── Bar Chart Row ──────────────────────────────────────────────────────────

function BarChartRow({ skill, maxCount }: { skill: SkillFrequency; maxCount: number }) {
  const barWidth = maxCount > 0 ? (skill.count / maxCount) * 100 : 0;
  const barColor =
    skill.passRate >= 0.8
      ? 'bg-emerald-500'
      : skill.passRate >= 0.5
        ? 'bg-blue-500'
        : 'bg-red-500';

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-mono w-[120px] shrink-0 truncate text-right">
        {skill.name}
      </span>
      <div className="flex-1 flex items-center gap-2 min-w-0">
        <div className="flex-1 h-5 bg-border/30 rounded overflow-hidden">
          <div
            className={`h-full rounded ${barColor} transition-all`}
            style={{ width: `${barWidth}%` }}
          />
        </div>
        <span className="text-[10px] text-muted shrink-0 whitespace-nowrap">
          {skill.count} use{skill.count !== 1 ? 's' : ''}, {Math.round(skill.passRate * 100)}% pass
        </span>
      </div>
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

interface SkillsTabProps {
  runId: number;
}

export default function SkillsTab({ runId }: SkillsTabProps) {
  const [data, setData] = useState<SkillsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMobile = useIsMobile();
  // Track expanded skill per story: Map<storyId, skillName>
  const [expandedSkills, setExpandedSkills] = useState<Map<string, string>>(new Map());
  // Cache skill content across all expansions: Map<skillName, content>
  const [skillContentCache] = useState<Map<string, string>>(() => new Map());

  const handleSkillClick = useCallback((storyId: string, skillName: string) => {
    setExpandedSkills((prev) => {
      const next = new Map(prev);
      if (next.get(storyId) === skillName) {
        next.delete(storyId);
      } else {
        next.set(storyId, skillName);
      }
      return next;
    });
  }, []);

  const handleCacheSet = useCallback((name: string, content: string) => {
    skillContentCache.set(name, content);
  }, [skillContentCache]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch<SkillsData>(`/api/pipeline/runs/${runId}/skills`);
      setData(result);
    } catch (err: any) {
      setError(err.message || 'Failed to load skill data');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const maxCount = useMemo(() => {
    if (!data) return 0;
    return Math.max(...data.summary.skillFrequency.map((s) => s.count), 1);
  }, [data]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm gap-2">
        <Loader2 size={16} className="animate-spin" />
        Loading skill data...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <span className="text-sm text-red-400">{error}</span>
        <button
          onClick={fetchData}
          className="flex items-center gap-1.5 text-xs text-accent hover:underline"
        >
          <RefreshCw size={12} />
          Retry
        </button>
      </div>
    );
  }

  if (!data || data.summary.totalSkillInjections === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted">
        <Wrench size={32} className="opacity-30" />
        <span className="text-sm font-medium">No skills were used in this run</span>
        <span className="text-xs text-muted">
          Install skills from the Marketplace and match them to your spec before running.
        </span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Summary header — sticky */}
      <div className="shrink-0 border-b border-border bg-panel/50 p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">
            Run Skill Summary
          </span>
          <button
            onClick={fetchData}
            className="p-1 rounded hover:bg-bg transition-colors text-muted hover:text-[var(--text)]"
            title="Refresh skills"
            aria-label="Refresh skills"
          >
            <RefreshCw size={13} />
          </button>
        </div>

        {/* Stat cards */}
        <div className={`flex gap-3 ${isMobile ? 'flex-col' : ''}`}>
          <div className="bg-bg rounded-lg p-3 flex-1">
            <div className="text-[10px] uppercase tracking-wide text-muted mb-1">Skills Used</div>
            <div className="text-2xl font-bold">{data.summary.uniqueSkills.length}</div>
            <div className="text-[10px] font-mono text-muted mt-1">
              {data.summary.uniqueSkills.join(', ')}
            </div>
          </div>
          <div className="bg-bg rounded-lg p-3 flex-1">
            <div className="text-[10px] uppercase tracking-wide text-muted mb-1">Stories with Skills</div>
            <div className="text-2xl font-bold">
              {data.summary.storiesWithSkills}
              <span className="text-sm font-normal text-muted">
                {' '}/ {data.summary.storiesWithSkills + data.summary.storiesWithoutSkills}
              </span>
            </div>
          </div>
          <div className="bg-bg rounded-lg p-3 flex-1">
            <div className="text-[10px] uppercase tracking-wide text-muted mb-1">Total Injections</div>
            <div className="text-2xl font-bold">{data.summary.totalSkillInjections}</div>
          </div>
        </div>

        {/* Skill frequency bar chart */}
        {data.summary.skillFrequency.length > 0 && (
          <div className="mt-4 space-y-1.5">
            {isMobile ? (
              // Mobile: list format
              data.summary.skillFrequency.map((skill) => (
                <div key={skill.name} className="text-xs text-muted">
                  <span className="font-mono">{skill.name}</span>: {skill.count} use{skill.count !== 1 ? 's' : ''}, {Math.round(skill.passRate * 100)}% pass
                </div>
              ))
            ) : (
              // Desktop: horizontal bar chart
              data.summary.skillFrequency.map((skill) => (
                <BarChartRow key={skill.name} skill={skill} maxCount={maxCount} />
              ))
            )}
          </div>
        )}
      </div>

      {/* Per-story detail section */}
      <div className="flex-1 overflow-y-auto p-4">
        {data.perStory.map((story, i) => {
          const expandedSkill = expandedSkills.get(story.storyId);
          return (
            <div
              key={story.storyId}
              className={i < data.perStory.length - 1 ? 'border-b border-border/50' : ''}
            >
              <div className="py-2 flex items-center gap-2">
                <StoryStatusIcon status={story.storyStatus} />

                <span className="font-mono text-xs bg-panel rounded px-1.5 py-0.5 shrink-0">
                  {story.storyId}
                </span>

                <span className="text-sm truncate min-w-0 flex-1">
                  {story.storyTitle}
                </span>

                <div className="flex flex-wrap gap-1 shrink-0">
                  {story.skills.length > 0 ? (
                    story.skills.map((skill) => (
                      <SkillBadge
                        key={skill.name}
                        skill={skill}
                        isExpanded={expandedSkill === skill.name}
                        onClick={() => handleSkillClick(story.storyId, skill.name)}
                      />
                    ))
                  ) : (
                    <span className="text-muted text-xs italic">No skills</span>
                  )}
                </div>
              </div>

              {expandedSkill && (
                <ExpandedSkillContent
                  key={expandedSkill}
                  skillName={expandedSkill}
                  contentCache={skillContentCache}
                  onCacheSet={handleCacheSet}
                  onClose={() => setExpandedSkills((prev) => {
                    const next = new Map(prev);
                    next.delete(story.storyId);
                    return next;
                  })}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
