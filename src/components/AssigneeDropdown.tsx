/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useRef } from 'react';
import { UserCircle, ChevronDown, X } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';

export interface Assignee {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
}

interface Props {
  assignee?: Assignee | null;
  onAssign: (userId: string | null) => Promise<void>;
  workspaceId: string;
  size?: 'sm' | 'md';
}

export function AssigneeAvatar({ assignee, size = 'sm' }: { assignee: Assignee; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'w-5 h-5' : 'w-6 h-6';
  const textSize = size === 'sm' ? 'text-[8px]' : 'text-[10px]';

  if (assignee.avatarUrl) {
    return (
      <img
        src={assignee.avatarUrl}
        alt={assignee.displayName}
        loading="lazy"
        className={`${dim} rounded-full object-cover`}
        title={assignee.displayName}
      />
    );
  }

  const initials = assignee.displayName
    .split(' ')
    .map(p => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div
      className={`${dim} rounded-full bg-accent/20 text-accent flex items-center justify-center ${textSize} font-bold`}
      title={assignee.displayName}
    >
      {initials}
    </div>
  );
}

export function AssigneeDropdown({ assignee, onAssign, workspaceId, size = 'sm' }: Props) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Assignee[]>([]);
  const [loading, setLoading] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Fetch members on open
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    apiFetch<{ members: Assignee[] }>(`/api/users/workspace-members?workspaceId=${workspaceId}`)
      .then(data => setMembers(data.members))
      .catch(() => setMembers([]))
      .finally(() => setLoading(false));
  }, [open, workspaceId]);

  const handleSelect = async (userId: string | null) => {
    setAssigning(true);
    try {
      await onAssign(userId);
      setOpen(false);
    } catch {
      // Error handled by parent
    } finally {
      setAssigning(false);
    }
  };

  const btnClass = size === 'sm'
    ? 'px-1.5 py-0.5 text-[10px] gap-1'
    : 'px-2 py-1 text-xs gap-1.5';

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className={`inline-flex items-center ${btnClass} rounded border border-border hover:border-accent/40 text-muted hover:text-text transition-colors`}
        title={assignee ? `Assigned to ${assignee.displayName}` : 'Assign'}
      >
        {assignee ? (
          <>
            <AssigneeAvatar assignee={assignee} size={size} />
            <span className="max-w-[80px] truncate">{assignee.displayName}</span>
          </>
        ) : (
          <>
            <UserCircle size={size === 'sm' ? 12 : 14} />
            <span>Assign</span>
          </>
        )}
        <ChevronDown size={size === 'sm' ? 10 : 12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 right-0 w-56 max-h-64 overflow-y-auto rounded-md border border-border bg-bg shadow-lg">
          {loading ? (
            <div className="px-3 py-2 text-xs text-muted">Loading...</div>
          ) : (
            <>
              {assignee && (
                <button
                  onClick={() => handleSelect(null)}
                  disabled={assigning}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted hover:bg-panel transition-colors border-b border-border disabled:opacity-50"
                >
                  <X size={12} />
                  Unassign
                </button>
              )}
              {members.length === 0 && !loading && (
                <div className="px-3 py-2 text-xs text-muted">No team members found</div>
              )}
              {members.map(m => (
                <button
                  key={m.id}
                  onClick={() => handleSelect(m.id)}
                  disabled={assigning || m.id === assignee?.id}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors disabled:opacity-50 ${
                    m.id === assignee?.id ? 'bg-accent/10 text-accent' : 'text-text hover:bg-panel'
                  }`}
                >
                  <AssigneeAvatar assignee={m} size="sm" />
                  <div className="flex-1 text-left min-w-0">
                    <div className="truncate font-medium">{m.displayName}</div>
                    <div className="truncate text-muted text-[10px]">{m.email}</div>
                  </div>
                  {m.id === assignee?.id && (
                    <span className="text-[10px] text-accent">Current</span>
                  )}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
