/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * useFileWatchSSE — CIE-009: Listen to SSE for context_file_changed WAL events
 * and show toast notifications when context/intent files are externally edited.
 */

import { useRef } from 'react';
import { useWalSSE } from './useWalSSE';
import { useGlobalToast } from '../contexts/ToastContext';
import { useWorkspace } from '../contexts/WorkspaceContext';

const FILE_LABELS: Record<string, string> = {
  'CLAUDE.md': 'CLAUDE.md',
  'AGENTS.md': 'AGENTS.md',
  '.rorca/config.json': 'Config',
  '.rorca/MEMORY.md': 'Memory Ledger',
};

function friendlyFileName(relPath: string): string {
  return FILE_LABELS[relPath] || relPath.split('/').pop() || relPath;
}

function changeVerb(eventKind: string): string {
  switch (eventKind) {
    case 'add': return 'created';
    case 'unlink': return 'deleted';
    default: return 'updated';
  }
}

export function useFileWatchSSE(): void {
  const toast = useGlobalToast();
  const { workspaceId } = useWorkspace();
  const recentRef = useRef(new Set<string>());

  useWalSSE((event) => {
    if (event.event_type !== 'context_file_changed') return;

    // Only show for current workspace
    if (workspaceId && event.workspace_id && event.workspace_id !== workspaceId) return;

    try {
      const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
      if (!payload?.path) return;

      // Deduplicate rapid-fire events for the same file
      const key = `${payload.path}:${payload.eventKind}`;
      if (recentRef.current.has(key)) return;
      recentRef.current.add(key);
      setTimeout(() => recentRef.current.delete(key), 3000);

      const name = friendlyFileName(payload.path);
      const verb = changeVerb(payload.eventKind);
      toast.show(`${name} ${verb} externally — syncing...`, 'success');
    } catch {
      // ignore parse errors
    }
  });
}
