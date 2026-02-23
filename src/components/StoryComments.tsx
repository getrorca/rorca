import { useState, useEffect, useRef } from 'react';
import { Send, CheckCircle2, MessageSquare, X } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';

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

/** Minimal Markdown→HTML (bold, italic, code, lists, links). Escapes HTML first. */
function simpleMarkdown(md: string): string {
  return md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code class="px-1 py-0.5 bg-surface rounded text-[11px]">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-accent underline" target="_blank" rel="noopener">$1</a>')
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
    return <img src={url} alt={name} className="w-6 h-6 rounded-full shrink-0" />;
  }
  const initial = name.charAt(0).toUpperCase();
  return (
    <div className="w-6 h-6 rounded-full shrink-0 bg-accent/20 text-accent flex items-center justify-center text-[10px] font-bold">
      {initial}
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
  const [comments, setComments] = useState<StoryComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [newBody, setNewBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  const handleSubmit = async () => {
    if (!newBody.trim() || submitting) return;
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

      {/* New comment input */}
      <div className="border-t border-border px-3 py-2 flex gap-2">
        <textarea
          value={newBody}
          onChange={e => setNewBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add a comment... (Markdown supported, Cmd+Enter to send)"
          rows={2}
          className="flex-1 bg-surface border border-border rounded px-2 py-1.5 text-xs text-text placeholder:text-muted/50 resize-none focus:outline-none focus:border-accent"
        />
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
