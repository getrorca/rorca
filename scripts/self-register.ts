#!/usr/bin/env npx tsx
/**
 * Self-register: Register ~/rorcha/ as a workspace in its own SQLite DB,
 * populate the Direction Stack with Rorcha's own architecture context.
 *
 * Usage: npx tsx scripts/self-register.ts
 *   or:  npm run self-register  (from project root)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_BASE = process.env.RORCHA_API_URL || 'http://localhost:3030';
const RORCHA_PATH = path.resolve(__dirname, '..');

async function apiFetch<T>(urlPath: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${urlPath}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts?.headers },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

async function main() {
  console.log(`Registering Rorcha workspace from: ${RORCHA_PATH}`);
  console.log(`API: ${API_BASE}`);

  // 1. Create workspace (idempotent — 409 means already exists)
  let workspaceId = 'rorcha';
  try {
    const result = await apiFetch<{ workspace: { id: string } }>('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({
        id: 'rorcha',
        label: 'Rorcha',
        path: RORCHA_PATH,
        domains: ['typescript', 'vite', 'express', 'sqlite'],
      }),
    });
    workspaceId = result.workspace.id;
    console.log('Created workspace:', workspaceId);
  } catch (err: any) {
    if (err.message?.includes('409')) {
      console.log('Workspace already exists (409) — continuing with updates.');
    } else {
      throw err;
    }
  }

  // 2. Seed L1 (global brain) from Rorcha's own README
  const readmePath = path.join(RORCHA_PATH, 'README.md');
  const readmeContent = fs.existsSync(readmePath)
    ? fs.readFileSync(readmePath, 'utf8')
    : '# Rorcha\nSpec-driven orchestration engine.';

  const l1Yaml = `global:\n  readme: |\n${readmeContent
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n')}`;

  await apiFetch('/api/direction', {
    method: 'PUT',
    body: JSON.stringify({
      layer: 1,
      contentYaml: l1Yaml,
    }),
  });
  console.log('Seeded L1 (Global Brain) from README.md');

  // 3. Seed L3 (project brief) — Rorcha's own architecture
  const l3Yaml = `project:
  name: Rorcha
  type: standalone-tool
  stack: [vite, react, express, sqlite, better-sqlite3, simple-git]
  purpose: AI spec orchestration dashboard
  target_users: developers using Claude Code
  key_modules:
    - Direction Stack (L1-L5 context layering)
    - Spec Forge (LLM-powered spec generation)
    - Review Queue (approval workflow)
    - Pipeline (execution orchestration)
    - Archive (searchable spec history)
    - Worktree Manager (git worktree CRUD)`;

  await apiFetch('/api/direction', {
    method: 'PUT',
    body: JSON.stringify({
      layer: 3,
      workspaceId,
      contentYaml: l3Yaml,
    }),
  });
  console.log('Seeded L3 (Project Brief) with Rorcha architecture');

  console.log('\nSelf-registered! Workspace ID:', workspaceId);
  console.log('Next steps:');
  console.log('  1. Open Rorcha UI → workspace selector shows "Rorcha"');
  console.log('  2. Direction Stack Composer → L1 tab shows README content');
  console.log('  3. Spec Forge → select Rorcha workspace → generate a spec');
}

main().catch((err) => {
  console.error('Self-register failed:', err.message);
  process.exit(1);
});
