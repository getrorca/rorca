/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useNavigate } from 'react-router-dom';
import { ArrowRight, Compass } from 'lucide-react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useGlobalToast } from '../../contexts/ToastContext';
import {
  WsGeneralSection as WsGeneralSectionBase,
  WsContextSection as WsContextSectionBase,
  WsEnvVarsSection as WsEnvVarsSectionBase,
  WsPipelineSection as WsPipelineSectionBase,
  WsHooksSection as WsHooksSectionBase,
} from '../WorkspaceSettingsPanel';
import AgentsEditorSection from '../../components/AgentsEditorSection';
import type { SettingsTab } from '../SettingsPanel';

// ─── Workspace Section Wrappers (delegate to WorkspaceSettingsPanel sections) ─

function WsNoWorkspace() {
  return (
    <div className="h-48 flex items-center justify-center text-muted text-sm">
      Select a workspace to manage these settings.
    </div>
  );
}

export function WsGeneralSection() {
  const { workspaceId } = useWorkspace();
  const { show } = useGlobalToast();
  if (!workspaceId) return <WsNoWorkspace />;
  return <WsGeneralSectionBase workspaceId={workspaceId} showToast={show} />;
}

// ULT-008: Direction editor removed from Settings — link to Direction panel instead
export function WsDirectionSection() {
  const navigate = useNavigate();
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-[var(--text)]">Direction</h2>
      <p className="text-sm text-muted">
        Direction layers (Standards, Conventions, Project) are managed in the dedicated Direction panel
        with auto-save, AI Setup, and a synthesized preview.
      </p>
      <button
        onClick={() => navigate('/direction')}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-accent text-white rounded hover:bg-accent/90 transition-colors"
      >
        <Compass size={14} />
        Edit Direction
        <ArrowRight size={14} />
      </button>
    </div>
  );
}

export function WsContextSection() {
  const { workspaceId } = useWorkspace();
  const { show } = useGlobalToast();
  if (!workspaceId) return <WsNoWorkspace />;
  return <WsContextSectionBase workspaceId={workspaceId} showToast={show} />;
}

export function WsEnvVarsSection() {
  const { workspaceId } = useWorkspace();
  const { show } = useGlobalToast();
  if (!workspaceId) return <WsNoWorkspace />;
  return <WsEnvVarsSectionBase workspaceId={workspaceId} showToast={show} />;
}

export function WsPipelineSection() {
  const { workspaceId } = useWorkspace();
  const { show } = useGlobalToast();
  if (!workspaceId) return <WsNoWorkspace />;
  return <WsPipelineSectionBase workspaceId={workspaceId} showToast={show} />;
}

export function WsHooksSection() {
  const { workspaceId } = useWorkspace();
  const { show } = useGlobalToast();
  if (!workspaceId) return <WsNoWorkspace />;
  return <WsHooksSectionBase workspaceId={workspaceId} showToast={show} />;
}

export function WsAgentsSection() {
  const { workspaceId } = useWorkspace();
  const { show } = useGlobalToast();
  if (!workspaceId) return <WsNoWorkspace />;
  return <AgentsEditorSection workspaceId={workspaceId} showToast={show} />;
}

// Re-export SettingsTab type so other sub-components can use it if needed
export type { SettingsTab };
