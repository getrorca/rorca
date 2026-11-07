/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import { getLifecyclePortfolio } from '../api/lifecycle';

interface WorkspaceBootstrapBannerProps {
  onSetUpNow: () => void;
}

const DISMISS_KEY_PREFIX = 'rorca_bootstrap_banner_dismissed_';
const WIZARD_COMPLETE_PREFIX = 'rorca_wizard_completed_';

export default function WorkspaceBootstrapBanner({ onSetUpNow }: WorkspaceBootstrapBannerProps) {
  const { workspaceId } = useWorkspace();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!workspaceId) { setVisible(false); return; }

    // Already completed wizard — never show
    if (localStorage.getItem(`${WIZARD_COMPLETE_PREFIX}${workspaceId}`)) {
      setVisible(false);
      return;
    }

    // Dismissed this session — don't show
    if (sessionStorage.getItem(`${DISMISS_KEY_PREFIX}${workspaceId}`)) {
      setVisible(false);
      return;
    }

    // Check health + whether .rorca/config.json exists
    let cancelled = false;
    apiFetch<{ score: number }>(`/api/workspaces/${workspaceId}/health`)
      .then(async (data) => {
        if (data.score >= 40) { setVisible(false); return; }
        // A workspace with any compiled lifecycle plan is already set up — suppress the banner.
        const portfolio = await getLifecyclePortfolio(workspaceId, { sort: 'current_view' }, { limit: 1 });
        if (!cancelled) setVisible(portfolio.kpis.evaluatedSpecs === 0);
      })
      .catch(() => { if (!cancelled) setVisible(false); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  if (!visible || !workspaceId) return null;

  const handleDismiss = () => {
    setVisible(false);
    sessionStorage.setItem(`${DISMISS_KEY_PREFIX}${workspaceId}`, '1');
  };

  return (
    <div className="flex items-center justify-between px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20">
      <div className="flex items-center gap-2.5">
        <Sparkles size={14} className="text-amber-500 shrink-0" />
        <p className="text-sm text-[var(--text)]">
          This workspace isn't set up yet — your specs will work better with context.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onSetUpNow}
          className="inline-flex items-center px-3 py-1 text-xs font-medium rounded-md bg-amber-500/20 text-amber-600 hover:bg-amber-500/30 transition-colors"
        >
          Set up now
        </button>
        <button
          onClick={handleDismiss}
          className="p-1 rounded hover:bg-amber-500/10 text-muted hover:text-[var(--text)] transition-colors"
          aria-label="Dismiss setup banner"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
