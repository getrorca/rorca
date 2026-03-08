-- PR-051: Plan-based feature gating — quota table + default rows
CREATE TABLE IF NOT EXISTS plan_quotas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_name TEXT NOT NULL,
  feature TEXT NOT NULL,
  quota_limit INTEGER NOT NULL DEFAULT -1,
  UNIQUE(plan_name, feature)
);

-- Free plan: limited
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('free', 'specs_per_month', 5);
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('free', 'workspaces', 1);
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('free', 'marketplace_publish', 0);
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('free', 'exa_search', 0);
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('free', 'team_members', 1);

-- Solo plan: moderate
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('solo', 'specs_per_month', -1);
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('solo', 'workspaces', 3);
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('solo', 'marketplace_publish', -1);
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('solo', 'exa_search', -1);
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('solo', 'team_members', 1);

-- Pro plan: generous
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('pro', 'specs_per_month', -1);
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('pro', 'workspaces', -1);
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('pro', 'marketplace_publish', -1);
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('pro', 'exa_search', -1);
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('pro', 'team_members', 5);

-- Team plan: unlimited everything
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('team', 'specs_per_month', -1);
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('team', 'workspaces', -1);
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('team', 'marketplace_publish', -1);
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('team', 'exa_search', -1);
INSERT OR IGNORE INTO plan_quotas (plan_name, feature, quota_limit) VALUES ('team', 'team_members', -1);
