/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Plus } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';

interface TagSuggestion {
  name: string;
  count: number;
}

interface TagChipsProps {
  specId: string;
  workspaceId: string;
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  /** Clicking a tag in the list fires this to filter the parent view */
  onTagClick?: (tag: string) => void;
  /** Compact mode hides the add button (used in card list) */
  compact?: boolean;
}

const TAG_COLORS = [
  'bg-accent/15 text-accent border-accent/30',
  'bg-success/15 text-success border-success/30',
  'bg-warning/15 text-warning border-warning/30',
  'bg-error/15 text-error border-error/30',
  'bg-purple-500/15 text-purple-400 border-purple-500/30',
  'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  'bg-pink-500/15 text-pink-400 border-pink-500/30',
  'bg-orange-500/15 text-orange-400 border-orange-500/30',
];

function tagColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

export function TagChips({ specId, workspaceId, tags, onTagsChange, onTagClick, compact }: TagChipsProps) {
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Focus input when adding
  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  // Fetch autocomplete suggestions
  useEffect(() => {
    if (!adding || !workspaceId) {
      setSuggestions([]);
      return;
    }
    const q = input.trim().toLowerCase();
    const params = new URLSearchParams({ workspaceId });
    if (q) params.set('q', q);

    apiFetch<{ tags: TagSuggestion[] }>(`/api/specs/tags/autocomplete?${params}`)
      .then(res => {
        // Filter out already-applied tags
        setSuggestions(res.tags.filter(t => !tags.includes(t.name)));
        setSelectedIdx(-1);
      })
      .catch(() => setSuggestions([]));
  }, [input, adding, workspaceId, tags]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!adding) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setAdding(false);
        setInput('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [adding]);

  const addTag = useCallback(async (name: string) => {
    const normalized = name.trim().toLowerCase();
    if (!normalized || tags.includes(normalized)) return;
    try {
      const res = await apiFetch<{ tags: string[] }>(`/api/specs/${specId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, tags: [normalized] }),
      });
      onTagsChange(res.tags);
    } catch {
      // silent fail
    }
    setInput('');
    setAdding(false);
  }, [specId, workspaceId, tags, onTagsChange]);

  const removeTag = useCallback(async (name: string) => {
    try {
      const res = await apiFetch<{ tags: string[] }>(
        `/api/specs/${specId}/tags/${encodeURIComponent(name)}?workspaceId=${workspaceId}`,
        { method: 'DELETE' }
      );
      onTagsChange(res.tags);
    } catch {
      // silent fail
    }
  }, [specId, workspaceId, onTagsChange]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIdx >= 0 && selectedIdx < suggestions.length) {
        addTag(suggestions[selectedIdx].name);
      } else if (input.trim()) {
        addTag(input);
      }
    } else if (e.key === 'Escape') {
      setAdding(false);
      setInput('');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(prev => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(prev => Math.max(prev - 1, -1));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1" ref={dropdownRef}>
      {tags.map(tag => (
        <span
          key={tag}
          className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded border ${tagColor(tag)} ${onTagClick ? 'cursor-pointer hover:opacity-80' : ''}`}
          onClick={e => { e.stopPropagation(); onTagClick?.(tag); }}
        >
          {tag}
          {!compact && (
            <button
              className="ml-0.5 hover:opacity-60 transition-opacity"
              onClick={e => { e.stopPropagation(); removeTag(tag); }}
            >
              <X size={8} />
            </button>
          )}
        </span>
      ))}

      {!compact && (
        adding ? (
          <div className="relative">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Tag name..."
              className="w-24 px-1.5 py-0.5 text-[10px] bg-panel border border-border rounded text-text placeholder:text-muted/50 focus:outline-none focus:border-accent"
            />
            {suggestions.length > 0 && (
              <div className="absolute top-full left-0 mt-1 w-44 bg-bg border border-border rounded shadow-lg z-50 max-h-40 overflow-y-auto">
                {suggestions.map((s, i) => (
                  <button
                    key={s.name}
                    className={`w-full text-left px-2 py-1 text-[11px] flex items-center justify-between hover:bg-panel transition-colors ${i === selectedIdx ? 'bg-accent/10' : ''}`}
                    onMouseDown={e => { e.preventDefault(); addTag(s.name); }}
                  >
                    <span className={`inline-flex items-center gap-1 px-1 py-0.5 rounded border ${tagColor(s.name)}`}>
                      {s.name}
                    </span>
                    <span className="text-muted text-[9px]">{s.count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button
            className="inline-flex items-center gap-0.5 px-1 py-0.5 text-[10px] text-muted hover:text-text border border-dashed border-border rounded hover:border-accent/50 transition-colors"
            onClick={e => { e.stopPropagation(); setAdding(true); }}
          >
            <Plus size={8} />
            tag
          </button>
        )
      )}
    </div>
  );
}

/** Read-only tag chips for use in card lists — clicking filters by tag */
export function TagChipsReadonly({ tags, onTagClick }: { tags: string[]; onTagClick?: (tag: string) => void }) {
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map(tag => (
        <span
          key={tag}
          className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border ${tagColor(tag)} ${onTagClick ? 'cursor-pointer hover:opacity-80' : ''}`}
          onClick={e => { e.stopPropagation(); onTagClick?.(tag); }}
        >
          {tag}
        </span>
      ))}
    </div>
  );
}
