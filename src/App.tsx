import { useState } from 'react';
import { WorkspaceProvider, useWorkspace } from './contexts/WorkspaceContext';
import Shell from './components/Shell';
import Sidebar, { type PanelId } from './components/Sidebar';
import AddWorkspaceModal from './components/AddWorkspaceModal';
import SpecForgePanelPage from './panels/SpecForgePanelPage';
import DirectionStackPanel from './panels/DirectionStackPanel';
import ReviewQueuePanel from './panels/ReviewQueuePanel';
import PipelineMonitorPanel from './panels/PipelineMonitorPanel';
import WorktreesPanel from './panels/WorktreesPanel';
import ArchivePanel from './panels/ArchivePanel';

function AppContent() {
  const [activePanel, setActivePanel] = useState<PanelId>('forge');
  const { workspaces, addWorkspace } = useWorkspace();
  const [showAddModal, setShowAddModal] = useState(false);

  if (workspaces.length === 0) {
    return (
      <Shell>
        <div className="flex flex-col items-center justify-center h-full gap-4">
          <p className="text-muted">No workspace configured.</p>
          <button
            onClick={() => setShowAddModal(true)}
            className="px-4 py-2 text-sm rounded bg-accent text-white hover:opacity-90 transition-opacity"
          >
            Add Workspace
          </button>
        </div>
        {showAddModal && (
          <AddWorkspaceModal
            onClose={() => setShowAddModal(false)}
            onSuccess={(ws) => {
              addWorkspace(ws);
              setShowAddModal(false);
            }}
          />
        )}
      </Shell>
    );
  }

  return (
    <Shell sidebar={<Sidebar activePanel={activePanel} onNavigate={setActivePanel} />}>
      {activePanel === 'forge'     && <SpecForgePanelPage />}
      {activePanel === 'stack'     && <DirectionStackPanel />}
      {activePanel === 'queue'     && <ReviewQueuePanel />}
      {activePanel === 'pipeline'  && <PipelineMonitorPanel />}
      {activePanel === 'worktrees' && <WorktreesPanel />}
      {activePanel === 'archive'   && <ArchivePanel />}
    </Shell>
  );
}

function App() {
  return (
    <WorkspaceProvider>
      <AppContent />
    </WorkspaceProvider>
  );
}

export default App;
