/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { useActiveSettingsTab } from '../routes';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SettingsTab =
  // Workspace group
  | 'general' | 'env-vars' | 'hooks' | 'agents' | 'context' | 'github'
  // Execution group
  | 'providers' | 'direction' | 'pipeline' | 'pty-recovery'
  // FinOps group
  | 'finops'
  // System group
  | 'shortcuts' | 'system' | 'developer';

// ─── Lazy-loaded sub-components ──────────────────────────────────────────────

const DirectionSettings = {
  WsGeneralSection: lazy(() =>
    import('./settings/DirectionSettingsTab').then((m) => ({ default: m.WsGeneralSection })),
  ),
  WsDirectionSection: lazy(() =>
    import('./settings/DirectionSettingsTab').then((m) => ({ default: m.WsDirectionSection })),
  ),
  WsContextSection: lazy(() =>
    import('./settings/DirectionSettingsTab').then((m) => ({ default: m.WsContextSection })),
  ),
  WsEnvVarsSection: lazy(() =>
    import('./settings/DirectionSettingsTab').then((m) => ({ default: m.WsEnvVarsSection })),
  ),
  WsPipelineSection: lazy(() =>
    import('./settings/DirectionSettingsTab').then((m) => ({ default: m.WsPipelineSection })),
  ),
  WsHooksSection: lazy(() =>
    import('./settings/DirectionSettingsTab').then((m) => ({ default: m.WsHooksSection })),
  ),
  WsAgentsSection: lazy(() =>
    import('./settings/DirectionSettingsTab').then((m) => ({ default: m.WsAgentsSection })),
  ),
};

const GitHubSettingsPanel = lazy(() => import('./GitHubSettingsPanel'));

const ProviderSettingsTab = lazy(() =>
  import('./settings/ProviderSettingsTab').then((m) => ({ default: m.ProviderSettingsTab })),
);

const ShortcutsSettingsTab = lazy(() =>
  import('./settings/ShortcutsSettingsTab').then((m) => ({ default: m.ShortcutsSettingsTab })),
);

const FinOpsSettingsTab = lazy(() =>
  import('./settings/FinOpsSettingsTab').then((m) => ({ default: m.FinOpsSettingsTab })),
);

const UnifiedActivitySection = lazy(() =>
  import('./settings/UnifiedActivitySection').then((m) => ({ default: m.UnifiedActivitySection })),
);

const DeadLetterQueueSection = lazy(() =>
  import('./settings/DeadLetterQueueSection').then((m) => ({ default: m.DeadLetterQueueSection })),
);

const DeveloperToolsSection = lazy(() =>
  import('./settings/DeveloperToolsSection'),
);

const KnowledgeGraphSection = lazy(() =>
  import('./settings/KnowledgeGraphSection').then((m) => ({ default: m.KnowledgeGraphSection })),
);

const PtyRecoverySettingsTab = lazy(() => import('./settings/PtyRecoverySettingsTab'));


// ─── Loading fallback ────────────────────────────────────────────────────────

function TabLoader() {
  return (
    <div className="flex items-center justify-center h-48 text-muted">
      <Loader2 className="w-5 h-5 animate-spin" />
    </div>
  );
}

// ─── Shell ───────────────────────────────────────────────────────────────────

export default function SettingsPanel() {
  const activeTab = useActiveSettingsTab();
  const isWideLayoutTab = activeTab === 'providers';

  return (
    <div
      aria-label="Settings"
      className="h-full flex flex-col overflow-y-auto"
    >
      <h1 className="sr-only">Settings</h1>
      <div className={`p-4 sm:p-6 w-full ${isWideLayoutTab ? 'max-w-none' : 'mx-auto max-w-4xl'}`}>
        <Suspense fallback={<TabLoader />}>
          {/* Workspace group */}
          {activeTab === 'general' && <DirectionSettings.WsGeneralSection />}
          {activeTab === 'env-vars' && <DirectionSettings.WsEnvVarsSection />}
          {activeTab === 'hooks' && <DirectionSettings.WsHooksSection />}
          {activeTab === 'agents' && <DirectionSettings.WsAgentsSection />}
          {activeTab === 'context' && <DirectionSettings.WsContextSection />}
          {activeTab === 'github' && <GitHubSettingsPanel />}
          {/* Execution group */}
          {activeTab === 'providers' && <ProviderSettingsTab />}
          {activeTab === 'direction' && <DirectionSettings.WsDirectionSection />}
          {activeTab === 'pipeline' && <DirectionSettings.WsPipelineSection />}
          {activeTab === 'pty-recovery' && <PtyRecoverySettingsTab />}
          {/* FinOps group */}
          {activeTab === 'finops' && <FinOpsSettingsTab />}
          {activeTab === 'shortcuts' && <ShortcutsSettingsTab />}
          {/* System group */}
          {activeTab === 'system' && (
            <>
              <KnowledgeGraphSection />
              <hr className="border-border my-6" />
              <DeadLetterQueueSection />
              <hr className="border-border my-6" />
              <UnifiedActivitySection />
            </>
          )}
          {activeTab === 'developer' && <DeveloperToolsSection />}
        </Suspense>
      </div>
    </div>
  );
}
