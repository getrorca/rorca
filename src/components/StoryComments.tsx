/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, CheckCircle2, MessageSquare, X } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useWorkspace } from '../contexts/WorkspaceContext';

interface StoryComment {
  id: string;
  spec_id: string;
  story_id: string;
  user_id: string;
  body: string;
  created_at: string;
  resolved_at: string | null;
  display_name: string;
  avatar_url: string | null;
}

interface TeamMember {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
}

/** Minimal Markdown->HTML (bold, italic, code, lists, links, @mentions). Escapes HTML first. */
function simpleMarkdown(md: string): string {
  return md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code class="px-1 py-0.5 bg-surface rounded text-[11px]">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-accent underline" target="_blank" rel="noopener">$1</a>')
    .replace(/@([\w.\-]+(?:\s[\w.\-]+)?)/g, '<span class="inline-flex items-center px-1 py-0 rounded bg-accent/15 text-accent font-medium cursor-default" title="@$1">@$1</span>')
    .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc">$1</li>')
    .replace(/\n/g, '<br />');
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr + 'Z').getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function Avatar({ name, url }: { name: string; url: string | null }) {
  if (url) {
    return <img src={url} alt={name} width={24} height={24} loading="lazy" className="w-6 h-6 rounded-full shrink-0" />;
  }
  const initial = name.charAt(0).toUpperCase();
  return (
    <div className="w-6 h-6 rounded-full shrink-0 bg-accent/20 text-accent flex items-center justify-center text-[10px] font-bold">
      {initial}
    </div>
  );
}

function MentionDropdown({
  members,
  filter,
  selectedIndex,
  onSelect,
  position,
}: {
  members: TeamMember[];
  filter: string;
  selectedIndex: number;
  onSelect: (member: TeamMember) => void;
  position: { top: number; left: number };
}) {
  const filtered = members.filter(m =>
    m.displayName.toLowerCase().includes(filter.toLowerCase()) ||
    m.email.toLowerCase().includes(filter.toLowerCase())
  ).slice(0, 6);

  if (filtered.length === 0) return null;

  return (
    <div
      className="absolute z-50 bg-panel border border-border rounded shadow-lg py-1 max-h-40 overflow-y-auto w-52"
      style={{ bottom: position.top, left: position.left }}
    >
      {filtered.map((m, i) => (
        <button
          key={m.id}
          onMouseDown={e => { e.preventDefault(); onSelect(m); }}
          className={`w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-surface transition-colors ${
            i === selectedIndex ? 'bg-surface' : ''
          }`}
        >
          <Avatar name={m.displayName} url={m.avatarUrl} />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-text truncate">{m.displayName}</div>
            <div className="text-[10px] text-muted truncate">{m.email}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

export function StoryComments({
  specId,
  storyId,
  onClose,
  onCountChange,
}: {
  specId: string;
  storyId: string;
  onClose: () => void;
  onCountChange?: (unresolvedCount: number) => void;
}) {
  const { workspaceId } = useWorkspace();
  const [comments, setComments] = useState<StoryComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [newBody, setNewBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Mention autocomplete state
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [mentionActive, setMentionActive] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionStartIdx, setMentionStartIdx] = useState(0);
  const [mentionSelectedIdx, setMentionSelectedIdx] = useState(0);

  // Fetch team members once for autocomplete
  useEffect(() => {
    if (!workspaceId) return;
    apiFetch<{ members: TeamMember[] }>(`/api/users/workspace-members?workspaceId=${workspaceId}`)
      .then(data => setMembers(data.members))
      .catch(() => {});
  }, [workspaceId]);

  const getFilteredMembers = useCallback(() => {
    return members.filter(m =>
      m.displayName.toLowerCase().includes(mentionFilter.toLowerCase()) ||
      m.email.toLowerCase().includes(mentionFilter.toLowerCase())
    ).slice(0, 6);
  }, [members, mentionFilter]);

  const fetchComments = async () => {
    try {
      const data = await apiFetch<{ comments: StoryComment[] }>(
        `/api/specs/${specId}/stories/${storyId}/comments`
      );
      setComments(data.comments);
      const unresolved = data.comments.filter(c => !c.resolved_at).length;
      onCountChange?.(unresolved);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchComments();
  }, [specId, storyId]);

  const insertMention = (member: TeamMember) => {
    const before = newBody.slice(0, mentionStartIdx);
    const after = newBody.slice(textareaRef.current?.selectionStart ?? newBody.length);
    const inserted = `@${member.displayName} `;
    setNewBody(before + inserted + after);
    setMentionActive(false);
    setMentionFilter('');
    setMentionSelectedIdx(0);
    // Restore focus and cursor position
    setTimeout(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        const pos = before.length + inserted.length;
        ta.selectionStart = pos;
        ta.selectionEnd = pos;
      }
    }, 0);
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart;
    setNewBody(value);

    // Check if we're in a mention context
    const textBeforeCursor = value.slice(0, cursorPos);
    const atIdx = textBeforeCursor.lastIndexOf('@');

    if (atIdx >= 0) {
      const charBeforeAt = atIdx > 0 ? textBeforeCursor[atIdx - 1] : ' ';
      const textAfterAt = textBeforeCursor.slice(atIdx + 1);
      // Activate if @ is at start or preceded by whitespace, and no spaces yet in filter (or one space for two-word names)
      const spaceCount = (textAfterAt.match(/ /g) || []).length;
      if ((charBeforeAt === ' ' || charBeforeAt === '\n' || atIdx === 0) && spaceCount <= 1 && !/\n/.test(textAfterAt)) {
        setMentionActive(true);
        setMentionStartIdx(atIdx);
        setMentionFilter(textAfterAt);
        setMentionSelectedIdx(0);
        return;
      }
    }

    setMentionActive(false);
  };

  const handleSubmit = async () => {
    if (!newBody.trim() || submitting) return;
    setMentionActive(false);
    setSubmitting(true);
    try {
      const comment = await apiFetch<StoryComment>(
        `/api/specs/${specId}/stories/${storyId}/comments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: newBody.trim() }),
        }
      );
      setComments(prev => [...prev, comment]);
      setNewBody('');
      const unresolved = [...comments, comment].filter(c => !c.resolved_at).length;
      onCountChange?.(unresolved);
      // Scroll to bottom
      setTimeout(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }), 50);
    } catch {
      // silently fail
    } finally {
      setSubmitting(false);
    }
  };

  const handleResolve = async (commentId: string) => {
    if (resolving) return;
    setResolving(commentId);
    try {
      const updated = await apiFetch<StoryComment>(
        `/api/specs/${specId}/stories/${storyId}/comments/${commentId}/resolve`,
        { method: 'POST' }
      );
      setComments(prev => prev.map(c => c.id === commentId ? updated : c));
      const newComments = comments.map(c => c.id === commentId ? updated : c);
      const unresolved = newComments.filter(c => !c.resolved_at).length;
      onCountChange?.(unresolved);
    } catch {
      // silently fail
    } finally {
      setResolving(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (mentionActive) {
      const filtered = getFilteredMembers();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionSelectedIdx(prev => Math.min(prev + 1, filtered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionSelectedIdx(prev => Math.max(prev - 1, 0));
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && filtered.length > 0) {
        e.preventDefault();
        insertMention(filtered[mentionSelectedIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionActive(false);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const unresolvedComments = comments.filter(c => !c.resolved_at);
  const resolvedComments = comments.filter(c => c.resolved_at);

  return (
    <div className="border border-border rounded bg-panel mt-2">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-1.5 text-xs font-medium text-text">
          <MessageSquare size={12} />
          Comments ({unresolvedComments.length} open)
        </div>
        <button onClick={onClose} className="text-muted hover:text-text transition-colors">
          <X size={14} />
        </button>
      </div>

      <div ref={listRef} className="max-h-64 overflow-y-auto">
        {loading ? (
          <div className="px-3 py-4 text-xs text-muted text-center">Loading...</div>
        ) : comments.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted text-center">No comments yet</div>
        ) : (
          <div className="divide-y divide-border/50">
            {unresolvedComments.map(c => (
              <div key={c.id} className="px-3 py-2.5 flex gap-2">
                <Avatar name={c.display_name} url={c.avatar_url} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-medium text-text">{c.display_name}</span>
                    <span className="text-[10px] text-muted">{timeAgo(c.created_at)}</span>
                  </div>
                  <div
                    className="text-xs text-muted leading-relaxed prose-inline"
                    dangerouslySetInnerHTML={{ __html: simpleMarkdown(c.body) }}
                  />
                  <button
                    onClick={() => handleResolve(c.id)}
                    disabled={resolving === c.id}
                    className="mt-1 inline-flex items-center gap-0.5 text-[10px] text-muted hover:text-success transition-colors disabled:opacity-50"
                  >
                    <CheckCircle2 size={10} />
                    {resolving === c.id ? 'Resolving...' : 'Resolve'}
                  </button>
                </div>
              </div>
            ))}
            {resolvedComments.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-[10px] font-medium text-muted bg-surface/50">
                  Resolved ({resolvedComments.length})
                </div>
                {resolvedComments.map(c => (
                  <div key={c.id} className="px-3 py-2 flex gap-2 opacity-50">
                    <Avatar name={c.display_name} url={c.avatar_url} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-xs font-medium text-text line-through">{c.display_name}</span>
                        <span className="text-[10px] text-muted">{timeAgo(c.created_at)}</span>
                        <CheckCircle2 size={10} className="text-success" />
                      </div>
                      <div
                        className="text-xs text-muted leading-relaxed line-through"
                        dangerouslySetInnerHTML={{ __html: simpleMarkdown(c.body) }}
                      />
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* New comment input with @mention autocomplete */}
      <div className="border-t border-border px-3 py-2 flex gap-2 relative">
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={newBody}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onBlur={() => setTimeout(() => setMentionActive(false), 150)}
            placeholder="Add a comment... (@ to mention, Cmd+Enter to send)"
            rows={2}
            className="w-full bg-surface border border-border rounded px-2 py-1.5 text-xs text-text placeholder:text-muted/50 resize-none focus:outline-none focus:border-accent"
          />
          {mentionActive && (
            <MentionDropdown
              members={members}
              filter={mentionFilter}
              selectedIndex={mentionSelectedIdx}
              onSelect={insertMention}
              position={{ top: 4, left: 0 }}
            />
          )}
        </div>
        <button
          onClick={handleSubmit}
          disabled={!newBody.trim() || submitting}
          className="shrink-0 self-end px-2.5 py-1.5 rounded bg-accent text-white text-xs font-medium hover:bg-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Send size={12} />
        </button>
      </div>
    </div>
  );
}
