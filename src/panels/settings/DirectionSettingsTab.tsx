import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useGlobalToast } from '../../contexts/ToastContext';
import {
  WsGeneralSection as WsGeneralSectionBase,
  WsDirectionSection as WsDirectionSectionBase,
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

export function WsDirectionSection() {
  const { workspaceId } = useWorkspace();
  const { show } = useGlobalToast();
  if (!workspaceId) return <WsNoWorkspace />;
  return <WsDirectionSectionBase workspaceId={workspaceId} showToast={show} />;
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
