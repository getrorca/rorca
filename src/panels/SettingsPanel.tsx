import { lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { useActiveSettingsTab } from '../routes';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SettingsTab =
  // Workspace-scoped
  | 'general' | 'direction' | 'context' | 'providers' | 'github' | 'env-vars' | 'pipeline' | 'hooks' | 'agents'
  // Account-scoped
  | 'shortcuts' | 'account' | 'billing'
  // Aggregate tabs
  | 'analytics' | 'system';

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

const ProviderSettingsTab = lazy(() =>
  import('./settings/ProviderSettingsTab').then((m) => ({ default: m.ProviderSettingsTab })),
);

const GitHubSettingsTab = lazy(() =>
  import('./settings/GitHubSettingsTab').then((m) => ({ default: m.GitHubSettingsTab })),
);

const ShortcutsSettingsTab = lazy(() =>
  import('./settings/ShortcutsSettingsTab').then((m) => ({ default: m.ShortcutsSettingsTab })),
);

const AccountSettingsTab = lazy(() =>
  import('./settings/AccountSettingsTab').then((m) => ({ default: m.AccountSettingsTab })),
);

const BillingSection = lazy(() =>
  import('./settings/AccountSettingsTab').then((m) => ({ default: m.BillingSection })),
);

const AnalyticsSection = lazy(() =>
  import('./settings/AccountSettingsTab').then((m) => ({ default: m.AnalyticsSection })),
);

const SystemSection = lazy(() =>
  import('./settings/AccountSettingsTab').then((m) => ({ default: m.SystemSection })),
);

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

  return (
    <div
      role="main"
      aria-label="Settings"
      className="h-full flex flex-col overflow-y-auto"
    >
      <div className="p-4 sm:p-6 mx-auto w-full max-w-4xl">
        <Suspense fallback={<TabLoader />}>
          {/* Workspace-scoped tabs */}
          {activeTab === 'general' && <DirectionSettings.WsGeneralSection />}
          {activeTab === 'direction' && <DirectionSettings.WsDirectionSection />}
          {activeTab === 'context' && <DirectionSettings.WsContextSection />}
          {activeTab === 'providers' && <ProviderSettingsTab />}
          {activeTab === 'github' && <GitHubSettingsTab />}
          {activeTab === 'env-vars' && <DirectionSettings.WsEnvVarsSection />}
          {activeTab === 'pipeline' && <DirectionSettings.WsPipelineSection />}
          {activeTab === 'hooks' && <DirectionSettings.WsHooksSection />}
          {activeTab === 'agents' && <DirectionSettings.WsAgentsSection />}
          {/* Account-scoped tabs */}
          {activeTab === 'account' && <AccountSettingsTab />}
          {activeTab === 'billing' && <BillingSection />}
          {activeTab === 'shortcuts' && <ShortcutsSettingsTab />}
          {/* Aggregate tabs */}
          {activeTab === 'analytics' && <AnalyticsSection />}
          {activeTab === 'system' && <SystemSection />}
        </Suspense>
      </div>
    </div>
  );
}
