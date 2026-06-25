/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { DatabaseCapability } from '../contexts/CapabilitiesContext';

export type DbMode = DatabaseCapability['dbMode'];
export type GraphMode = DatabaseCapability['graphMode'];

export interface DatabaseModeSetupGuide {
  mode: DbMode;
  label: string;
  summary: string;
  startupGuide: string[];
  graphExpectation: 'full' | 'lite';
  graphSummary: string;
  tradeoffs: string[];
  bestFor: string[];
}

export interface GraphModeGuide {
  mode: 'full' | 'lite';
  label: string;
  summary: string;
  tradeoffs: string[];
  bestFor: string[];
}

export interface DatabaseSetupGuidance {
  selectedMode: DbMode;
  byopConfigured: boolean;
  selectionPersistsAcrossSessions: boolean;
  selectionNote: string;
  validationFlow: string;
  byop: {
    secretSafeInput: string;
    validationChecks: string[];
    examples: string[];
  };
  modes: DatabaseModeSetupGuide[];
  graphModes: GraphModeGuide[];
}

export const defaultDatabaseSetupGuidance: DatabaseSetupGuidance = {
  selectedMode: 'native',
  byopConfigured: false,
  selectionPersistsAcrossSessions: true,
  selectionNote: 'Your database mode choice is saved for the next startup/session before Rorca bootstraps a local database or validates a hosted connection.',
  validationFlow: 'Native and Docker selections save immediately. BYOP only runs connection validation when you explicitly save a DATABASE_URL.',
  byop: {
    secretSafeInput: 'Paste the full DATABASE_URL in the secure BYOP field. Rorca stores it outside your repo and only shows redacted host/database details later.',
    validationChecks: [
      'Reachable PostgreSQL connection over SSL/TLS',
      'Valid database name and hostname',
      'pgvector extension installed',
    ],
    examples: ['Supabase', 'Neon', 'Railway', 'self-hosted Postgres'],
  },
  modes: [
    {
      mode: 'native',
      label: 'Local / native Postgres',
      summary: 'Use a Postgres instance you run directly on your machine.',
      startupGuide: [
        'Install or start local PostgreSQL on your machine.',
        'Use the standard local Rorca Postgres connection on localhost.',
        'Choose this when you want the lightest local setup and are okay with Graph Lite unless AGE is installed manually.',
      ],
      graphExpectation: 'lite',
      graphSummary: 'Usually starts in Graph Lite. Full Graph is available only if Apache AGE is installed locally.',
      tradeoffs: [
        'Fastest path when you already have local Postgres.',
        'No Docker dependency.',
        'Manual Apache AGE setup is required for Full Graph.',
      ],
      bestFor: ['Existing local Postgres users', 'Minimal local tooling', 'Quick first install'],
    },
    {
      mode: 'docker',
      label: 'Docker Postgres with AGE',
      summary: 'Run the recommended containerized Postgres stack with Apache AGE support.',
      startupGuide: [
        'Make sure Docker Desktop or another Docker runtime is running.',
        'Run `rorca db start` to provision the managed Docker Postgres with AGE.',
        'Choose this when you want the smoothest path to Full Graph features.',
      ],
      graphExpectation: 'full',
      graphSummary: 'Best default for Full Graph because AGE ships with the Docker path.',
      tradeoffs: [
        'Best Full Graph experience.',
        'Requires Docker and local container resources.',
        'Slightly heavier than native/local Postgres.',
      ],
      bestFor: ['Recommended default', 'Knowledge graph demos', 'Users who want AGE without manual installs'],
    },
    {
      mode: 'byop',
      label: 'Bring your own Postgres',
      summary: 'Connect a hosted Postgres instance such as Supabase or Neon.',
      startupGuide: [
        'Create or choose a hosted Postgres database.',
        'Copy the full postgres:// or postgresql:// connection string with SSL enabled.',
        'Paste it into the secure DATABASE_URL field and validate it before saving.',
      ],
      graphExpectation: 'lite',
      graphSummary: 'Usually runs in Graph Lite unless your hosted Postgres already has Apache AGE installed.',
      tradeoffs: [
        'Best for cloud-hosted or shared environments.',
        'Requires secret-safe connection handling.',
        'pgvector is required and Apache AGE is optional for Full Graph.',
      ],
      bestFor: ['Supabase / Neon projects', 'Hosted environments', 'Teams reusing an existing Postgres'],
    },
  ],
  graphModes: [
    {
      mode: 'full',
      label: 'Full Graph',
      summary: 'AGE-backed graph traversal, richer graph admin views, and the best graph tooling experience.',
      tradeoffs: [
        'Requires Apache AGE on the selected Postgres instance.',
        'Best fit for Docker mode or a custom local/hosted Postgres with AGE already installed.',
      ],
      bestFor: ['Knowledge graph exploration', 'Graph-backed admin tools', 'AGE-enabled Postgres setups'],
    },
    {
      mode: 'lite',
      label: 'Graph Lite',
      summary: 'Keeps knowledge, relevance, and memory workflows usable with relational/semantic fallbacks when AGE is unavailable.',
      tradeoffs: [
        'No AGE-backed graph traversal or full graph visualisation features.',
        'Great compatibility mode for native/local or hosted Postgres without AGE.',
      ],
      bestFor: ['Fast onboarding', 'Hosted Postgres without AGE', 'Users who want fewer setup dependencies'],
    },
  ],
};

export function getDatabaseModeGuide(setup: DatabaseSetupGuidance, mode: DbMode): DatabaseModeSetupGuide {
  return setup.modes.find((entry) => entry.mode === mode) ?? setup.modes[0];
}
