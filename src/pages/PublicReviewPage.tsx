/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Clock,
  MessageSquare,
  Send,
  AlertTriangle,
  LinkIcon,
  User,
} from 'lucide-react';
import { apiFetch, ApiError } from '../lib/apiFetch';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Story {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  excluded?: boolean;
}

interface ReviewComment {
  id: string;
  spec_id: string;
  story_id: string;
  user_id: string | null;
  body: string;
  created_at: string;
  resolved_at: string | null;
  author_name: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

interface ReviewData {
  specId: string;
  title: string;
  model?: string;
  stories: Story[];
  commentsByStory: Record<string, ReviewComment[]>;
  expiresAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────


function timeAgo(dateStr: string): string {
  const d = dateStr.includes('Z') ? dateStr : dateStr + 'Z';
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function simpleMarkdown(md: string): string {
  return md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code class="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-[11px]">$1</code>')
    .replace(/\n/g, '<br />');
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function PublicReviewPage({ token }: { token: string }) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedStories, setExpandedStories] = useState<Set<string>>(new Set());
  const [commentsByStory, setCommentsByStory] = useState<Record<string, ReviewComment[]>>({});

  // Reviewer name (persisted in localStorage)
  const [reviewerName, setReviewerName] = useState(() =>
    localStorage.getItem('rorca-reviewer-name') || ''
  );
  const [showNamePrompt, setShowNamePrompt] = useState(false);

  // Per-story comment input
  const [activeCommentStory, setActiveCommentStory] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Fetch spec data
  useEffect(() => {
    setLoading(true);
    setError(null);
    apiFetch<ReviewData>(`/api/review/${token}`, { silent: true })
      .then((result) => {
        setData(result);
        setCommentsByStory(result.commentsByStory || {});
        setExpandedStories(new Set(result.stories.map((story) => story.id)));
      })
      .catch((cause: unknown) => {
        if (cause instanceof ApiError && cause.status === 410) {
          setError('This review link has expired.');
        } else if (cause instanceof ApiError && cause.status === 404) {
          setError('Invalid review link. It may have been revoked or is incorrect.');
        } else {
          setError('Failed to load review. Please check your connection.');
        }
      })
      .finally(() => setLoading(false));
  }, [token]);

  const toggleStory = useCallback((storyId: string) => {
    setExpandedStories(prev => {
      const next = new Set(prev);
      if (next.has(storyId)) next.delete(storyId);
      else next.add(storyId);
      return next;
    });
  }, []);

  const handleSubmitComment = async (storyId: string) => {
    if (!commentBody.trim() || submitting) return;

    // Prompt for name if not set
    if (!reviewerName.trim()) {
      setShowNamePrompt(true);
      return;
    }

    setSubmitting(true);
    try {
      const newComment = await apiFetch<ReviewComment>(`/api/review/${token}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          storyId,
          body: commentBody.trim(),
          authorName: reviewerName.trim(),
        }),
        silent: true,
      });
      setCommentsByStory(prev => ({
        ...prev,
        [storyId]: [...(prev[storyId] || []), newComment],
      }));
      setCommentBody('');
      setActiveCommentStory(null);
    } catch (cause: unknown) {
      alert(cause instanceof Error ? cause.message : 'Failed to post comment. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetName = () => {
    if (reviewerName.trim()) {
      localStorage.setItem('rorca-reviewer-name', reviewerName.trim());
      setShowNamePrompt(false);
    }
  };

  // ─── Loading ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
        <div className="text-gray-500 dark:text-gray-400 text-sm">Loading review...</div>
      </div>
    );
  }

  // ─── Error ───────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
        <div className="max-w-md mx-auto text-center p-8">
          <AlertTriangle size={48} className="mx-auto mb-4 text-amber-500" />
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Review Unavailable
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const totalComments = Object.values(commentsByStory).reduce((sum, cs) => sum + cs.length, 0);

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <header className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <LinkIcon size={14} className="text-gray-400" />
                <span className="text-xs text-gray-500 dark:text-gray-400 font-medium uppercase tracking-wider">
                  Spec Review
                </span>
              </div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                {data.title}
              </h1>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {data.stories.length} {data.stories.length === 1 ? 'story' : 'stories'}
                </span>
                {data.model && (
                  <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400">
                    {data.model}
                  </span>
                )}
                <span className="flex items-center gap-1 text-xs text-gray-400">
                  <MessageSquare size={12} />
                  {totalComments} {totalComments === 1 ? 'comment' : 'comments'}
                </span>
              </div>
            </div>
            {/* Reviewer name */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowNamePrompt(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              >
                <User size={12} />
                {reviewerName || 'Set your name'}
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Name prompt modal */}
      {showNamePrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-6 max-w-sm w-full mx-4">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
              Your name for comments
            </h2>
            <input
              type="text"
              value={reviewerName}
              onChange={(e) => setReviewerName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSetName()}
              placeholder="Enter your name..."
              autoFocus
              className="w-full px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:border-blue-500"
            />
            <div className="flex gap-2 mt-4">
              <button
                onClick={handleSetName}
                disabled={!reviewerName.trim()}
                className="flex-1 py-2 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                Save
              </button>
              <button
                onClick={() => setShowNamePrompt(false)}
                className="px-4 py-2 rounded text-sm text-gray-500 border border-gray-200 dark:border-gray-700 hover:text-gray-700 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stories */}
      <main className="max-w-4xl mx-auto px-4 py-6 space-y-3">
        {data.stories.map((story) => {
          const expanded = expandedStories.has(story.id);
          const storyComments = commentsByStory[story.id] || [];
          const isCommenting = activeCommentStory === story.id;

          return (
            <div
              key={story.id}
              className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden"
            >
              {/* Story header */}
              <button
                onClick={() => toggleStory(story.id)}
                className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
              >
                {expanded ? (
                  <ChevronDown size={16} className="text-gray-400 mt-0.5 shrink-0" />
                ) : (
                  <ChevronRight size={16} className="text-gray-400 mt-0.5 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[10px] font-mono text-gray-400 uppercase">{story.id}</span>
                    {story.excluded && (
                      <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-gray-100 dark:bg-gray-800 text-gray-400">
                        Excluded
                      </span>
                    )}
                  </div>
                  <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {story.title}
                  </h3>
                </div>
                {storyComments.length > 0 && (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 shrink-0">
                    <MessageSquare size={10} />
                    {storyComments.length}
                  </span>
                )}
              </button>

              {/* Expanded content */}
              {expanded && (
                <div className="px-4 pb-4 border-t border-gray-100 dark:border-gray-800">
                  {/* Description */}
                  {story.description && (
                    <p className="text-xs text-gray-600 dark:text-gray-400 mt-3 leading-relaxed">
                      {story.description}
                    </p>
                  )}

                  {/* Acceptance criteria */}
                  {story.acceptanceCriteria && story.acceptanceCriteria.length > 0 && (
                    <div className="mt-3">
                      <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                        Acceptance Criteria
                      </h4>
                      <ul className="space-y-1">
                        {story.acceptanceCriteria.map((ac, i) => (
                          <li
                            key={i}
                            className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300"
                          >
                            <span className="text-gray-300 dark:text-gray-600 mt-0.5 shrink-0">-</span>
                            <span>{ac}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Dependencies */}
                  {story.dependsOn && story.dependsOn.length > 0 && (
                    <div className="mt-3">
                      <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
                        Depends On
                      </h4>
                      <div className="flex flex-wrap gap-1">
                        {story.dependsOn.map(dep => (
                          <span
                            key={dep}
                            className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-gray-100 dark:bg-gray-800 text-gray-500"
                          >
                            {dep}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Comments */}
                  {storyComments.length > 0 && (
                    <div className="mt-4 border-t border-gray-100 dark:border-gray-800 pt-3">
                      <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
                        <MessageSquare size={10} />
                        Comments ({storyComments.length})
                      </h4>
                      <div className="space-y-2">
                        {storyComments.map((c) => (
                          <CommentBubble key={c.id} comment={c} />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Add comment */}
                  {isCommenting ? (
                    <div className="mt-3 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
                      <textarea
                        value={commentBody}
                        onChange={(e) => setCommentBody(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            handleSubmitComment(story.id);
                          }
                        }}
                        placeholder={`Add a comment as ${reviewerName || 'Guest'}...`}
                        rows={3}
                        autoFocus
                        className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-xs text-gray-900 dark:text-gray-100 placeholder:text-gray-400 resize-none focus:outline-none focus:border-blue-500"
                      />
                      <div className="flex items-center justify-between mt-2">
                        <span className="text-[10px] text-gray-400">
                          {reviewerName ? `Commenting as ${reviewerName}` : 'Set your name first'}
                        </span>
                        <div className="flex gap-2">
                          <button
                            onClick={() => { setActiveCommentStory(null); setCommentBody(''); }}
                            className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => handleSubmitComment(story.id)}
                            disabled={!commentBody.trim() || submitting}
                            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
                          >
                            <Send size={12} />
                            {submitting ? 'Sending...' : 'Send'}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setActiveCommentStory(story.id)}
                      className="mt-3 flex items-center gap-1.5 text-xs text-gray-400 hover:text-blue-600 transition-colors"
                    >
                      <MessageSquare size={12} />
                      Add a comment
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-200 dark:border-gray-800 py-4 mt-8">
        <div className="max-w-4xl mx-auto px-4 flex items-center justify-between">
          <span className="text-[10px] text-gray-400">
            Shared via Rorca
          </span>
          <span className="flex items-center gap-1 text-[10px] text-gray-400">
            <Clock size={10} />
            Link expires {new Date(data.expiresAt).toLocaleDateString()}
          </span>
        </div>
      </footer>
    </div>
  );
}

// ─── Comment Bubble ──────────────────────────────────────────────────────────

function CommentBubble({ comment }: { comment: ReviewComment }) {
  const name = comment.display_name || comment.author_name || 'Guest';
  const initial = name.charAt(0).toUpperCase();

  return (
    <div className="flex gap-2">
      {comment.avatar_url ? (
        <img
          src={comment.avatar_url}
          alt={name}
          loading="lazy"
          className="w-6 h-6 rounded-full shrink-0"
        />
      ) : (
        <div className="w-6 h-6 rounded-full shrink-0 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center text-[10px] font-bold">
          {initial}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-xs font-medium text-gray-900 dark:text-gray-100">{name}</span>
          <span className="text-[10px] text-gray-400">{timeAgo(comment.created_at)}</span>
          {!comment.user_id && (
            <span className="px-1 py-0 text-[9px] font-medium rounded bg-gray-100 dark:bg-gray-800 text-gray-400">
              Guest
            </span>
          )}
        </div>
        <div
          className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed"
          dangerouslySetInnerHTML={{ __html: simpleMarkdown(comment.body) }}
        />
      </div>
    </div>
  );
}
