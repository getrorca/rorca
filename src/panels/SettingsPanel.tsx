import { lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { useActiveSettingsTab } from '../routes';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SettingsTab =
  // Workspace group
  | 'general' | 'env-vars' | 'hooks' | 'agents' | 'context' | 'team'
  // Execution group
  | 'providers' | 'direction' | 'pipeline'
  // Integrations group
  | 'integrations' | 'github' | 'slack' | 'linear' | 'vercel' | 'audit-log'
  // Account group
  | 'account' | 'billing' | 'shortcuts' | 'notifications'
  // System group
  | 'system' | 'api-keys' | 'developer';

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


const UnifiedActivitySection = lazy(() =>
  import('./settings/UnifiedActivitySection').then((m) => ({ default: m.UnifiedActivitySection })),
);

const DeadLetterQueueSection = lazy(() =>
  import('./settings/DeadLetterQueueSection').then((m) => ({ default: m.DeadLetterQueueSection })),
);


const ApiKeysSection = lazy(() =>
  import('./settings/ApiKeysSection'),
);

const DeveloperToolsSection = lazy(() =>
  import('./settings/DeveloperToolsSection'),
);

const KnowledgeGraphSection = lazy(() =>
  import('./settings/KnowledgeGraphSection').then((m) => ({ default: m.KnowledgeGraphSection })),
);

const IntegrationPlaceholder = lazy(() =>
  import('./settings/IntegrationPlaceholder'),
);

const IntegrationsHubTab = lazy(() =>
  import('./settings/IntegrationsHubTab').then((m) => ({ default: m.IntegrationsHubTab })),
);

const IntegrationAuditLogTab = lazy(() =>
  import('./settings/IntegrationAuditLogTab').then((m) => ({ default: m.IntegrationAuditLogTab })),
);

const TeamSettingsTab = lazy(() =>
  import('./settings/TeamSettingsTab').then((m) => ({ default: m.TeamSettingsTab })),
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
      aria-label="Settings"
      className="h-full flex flex-col overflow-y-auto"
    >
      <h1 className="sr-only">Settings</h1>
      <div className="p-4 sm:p-6 mx-auto w-full max-w-4xl">
        <Suspense fallback={<TabLoader />}>
          {/* Workspace group */}
          {activeTab === 'general' && <DirectionSettings.WsGeneralSection />}
          {activeTab === 'env-vars' && <DirectionSettings.WsEnvVarsSection />}
          {activeTab === 'hooks' && <DirectionSettings.WsHooksSection />}
          {activeTab === 'agents' && <DirectionSettings.WsAgentsSection />}
          {activeTab === 'team' && <TeamSettingsTab />}
          {activeTab === 'context' && <DirectionSettings.WsContextSection />}
          {/* Execution group */}
          {activeTab === 'providers' && <ProviderSettingsTab />}
          {activeTab === 'direction' && <DirectionSettings.WsDirectionSection />}
          {activeTab === 'pipeline' && <DirectionSettings.WsPipelineSection />}
          {/* Integrations group */}
          {activeTab === 'integrations' && <IntegrationsHubTab />}
          {activeTab === 'audit-log' && <IntegrationAuditLogTab />}
          {activeTab === 'github' && <GitHubSettingsTab />}
          {activeTab === 'slack' && <IntegrationPlaceholder name="Slack" description="Get run notifications, approve specs via interactive buttons, and receive failure alerts — all in your team's Slack channels." />}
          {activeTab === 'linear' && <IntegrationPlaceholder name="Linear" description="Import Linear issues as specs, sync story progress to sub-issues, and auto-update parent issues when runs complete." />}
          {activeTab === 'vercel' && <IntegrationPlaceholder name="Vercel" description="Auto-deploy on run completion, get preview URLs in Run View, and promote to production with one click." />}
          {/* Account group */}
          {activeTab === 'account' && <AccountSettingsTab />}
          {activeTab === 'billing' && <IntegrationPlaceholder name="Billing" description="Manage your subscription, invoices, and payment method. Coming soon." />}
          {activeTab === 'shortcuts' && <ShortcutsSettingsTab />}
          {activeTab === 'notifications' && <IntegrationPlaceholder name="Notifications" description="Configure email, webhook, and in-app notification preferences. Coming soon." />}
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
          {activeTab === 'api-keys' && <ApiKeysSection />}
          {activeTab === 'developer' && <DeveloperToolsSection />}
        </Suspense>
      </div>
    </div>
  );
}
