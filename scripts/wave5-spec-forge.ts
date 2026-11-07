/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * W5 spec-forge runner: pushes forge/specs/pending/wave-5-forgejo-adapter-omp-shim.json
 * through the rorca /api/specs authoring pipeline on a fresh invocation-owned stack.
 *
 * Steps: provision stack (fresh PG16 + migrations; the image build includes the
 * committed spec file) -> seed a workspace -> locate the spec via /api/specs ->
 * read its readiness -> follow the pipeline (preflight -> persist -> lifecycle
 * compile -> approve) adaptively, recording every response and any blocker
 * honestly. The stack is LEFT RUNNING for the wave-run phase; teardown is
 * explicit (--teardown flag or the wave harness).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const PROJECT = 'rorca-wave2-wave5spec-20260806';
const SPEC_FILE = 'forge/specs/pending/wave-5-forgejo-adapter-omp-shim.json';
const SPEC_ID = 'wave-5-forgejo-adapter-omp-shim';
const RECEIPT = path.join(ROOT, 'docs', 'wave5-spec-pipeline-receipt.md');
const secret = (): string => crypto.randomBytes(24).toString('hex');

function compose(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 120_000): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('docker', ['compose', '--project-directory', ROOT, '--project-name', PROJECT, '-f', path.join(ROOT, 'docker-compose.yml'), ...args],
    { encoding: 'utf8', env, timeout: timeoutMs });
  return { ok: result.status === 0, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}
function psql(env: NodeJS.ProcessEnv, user: string, password: string, sql: string): { ok: boolean; stdout: string; stderr: string } {
  return compose(['exec', '-T', '-e', `PGPASSWORD=${password}`, 'db', 'psql', '--no-psqlrc', '-q', '--set', 'ON_ERROR_STOP=1', '-t', '-A', '-U', user, '-d', 'rorca_smoke', '-c', sql], env);
}
function freePort(): Promise<number> {
  const probe = (p: number): Promise<boolean> => new Promise((resolve) => {
    const socket = net.connect(p, '127.0.0.1');
    const done = (v: boolean): void => { socket.destroy(); resolve(v); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
  return (async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const candidate = 63_000 + (crypto.randomBytes(2).readUInt16BE(0) % 900);
      if (!(await probe(candidate))) return candidate;
    }
    throw new Error('no free port in 63000-63899');
  })();
}
function waitHealthy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tick = async (): Promise<void> => {
      attempt += 1;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) { resolve(); return; }
      } catch { /* retry */ }
      if (attempt >= 120) { reject(new Error('stack health timeout')); return; }
      setTimeout(tick, 2000);
    };
    void tick();
  });
}
const json = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 500) }; }
};

async function main(): Promise<void> {
  const transcript: string[] = [];
  const record = (label: string, detail: string): void => {
    transcript.push(`- **${label}**: ${detail}`);
    console.log(`[specforge] ${label}: ${detail.slice(0, 300)}`);
  };
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env, RORCA_POSTGRES_DATABASE: 'rorca_smoke', RORCA_POSTGRES_BOOTSTRAP_USER: 'rorca_smoke_bootstrap',
    RORCA_POSTGRES_BOOTSTRAP_PASSWORD: secret(), RORCA_MIGRATION_DATABASE_USER: 'rorca_smoke_migrator',
    RORCA_MIGRATION_DATABASE_PASSWORD: secret(), RORCA_RUNTIME_DATABASE_USER: 'rorca_smoke_runtime',
    RORCA_RUNTIME_DATABASE_PASSWORD: secret(), RORCA_CANONICAL_WRITER_DATABASE_USER: 'rorca_smoke_writer',
    RORCA_CANONICAL_WRITER_DATABASE_PASSWORD: secret(), JWT_SECRET: secret(), RORCA_INTERNAL_SERVICE_TOKEN: secret(),
    RORCA_DISPATCH_RECEIVER_TOKEN: secret(), RORCA_PORT: String(port),
    RORCA_MIGRATION_DATABASE_URL: '', RORCA_RUNTIME_DATABASE_URL: '', RORCA_CANONICAL_WRITER_DATABASE_URL: '',
  };
  env.RORCA_MIGRATION_DATABASE_URL = `postgres://${env.RORCA_MIGRATION_DATABASE_USER}:${env.RORCA_MIGRATION_DATABASE_PASSWORD}@db:5432/rorca_smoke`;
  env.RORCA_RUNTIME_DATABASE_URL = `postgres://${env.RORCA_RUNTIME_DATABASE_USER}:${env.RORCA_RUNTIME_DATABASE_PASSWORD}@db:5432/rorca_smoke`;
  env.RORCA_CANONICAL_WRITER_DATABASE_URL = `postgres://${env.RORCA_CANONICAL_WRITER_DATABASE_USER}:${env.RORCA_CANONICAL_WRITER_DATABASE_PASSWORD}@db:5432/rorca_smoke`;
  const migrator = env.RORCA_MIGRATION_DATABASE_USER!;
  const migratorPw = env.RORCA_MIGRATION_DATABASE_PASSWORD!;
  const workspaceId = 'workspace:wave5';
  try {
    record('provisioning', `project=${PROJECT} port=${port}`);
    const down = compose(['down', '--volumes', '--remove-orphans', '--rmi', 'local'], env, 300_000);
    if (!down.ok) throw new Error(`compose down failed: ${down.stderr.slice(-300)}`);
    const up = compose(['up', '--build', '--detach', 'rorca', 'worker'], env, 900_000);
    if (!up.ok) throw new Error(`compose up failed: ${up.stderr.slice(-800)}`);
    await waitHealthy(port);
    record('stack ready', `health OK on 127.0.0.1:${port}`);

    const wks = psql(env, migrator, migratorPw, `INSERT INTO rorca.workspaces(id,label,path) VALUES('${workspaceId}','${workspaceId}','/app') ON CONFLICT DO NOTHING`);
    if (!wks.ok) throw new Error(`workspace seed failed: ${wks.stderr}`);

    const specJson = fs.readFileSync(path.join(ROOT, SPEC_FILE), 'utf8');
    const copy = spawnSync('docker', ['compose', '--project-directory', ROOT, '--project-name', PROJECT, '-f', path.join(ROOT, 'docker-compose.yml'),
      'exec', '-T', 'rorca', 'sh', '-c', `mkdir -p /app/forge/specs/pending && cat > /app/forge/specs/pending/${SPEC_ID}.json`],
      { encoding: 'utf8', env, input: specJson, timeout: 60_000 });
    if (copy.status !== 0) throw new Error(`spec materialization failed: ${String(copy.stderr).slice(-300)}`);
    record('spec materialized', `/app/forge/specs/pending/${SPEC_ID}.json (${specJson.length} bytes)`);

    const base = `http://127.0.0.1:${port}`;
    const get = async (p: string): Promise<{ status: number; body: unknown }> => {
      const response = await fetch(`${base}${p}`);
      return { status: response.status, body: await json(response) };
    };
    const post = async (p: string, body: unknown): Promise<{ status: number; body: unknown }> => {
      const response = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await json(response) };
    };

    const listing = await get(`/api/specs?workspaceId=${workspaceId}`);
    record('specs listing (informational)', `${listing.status} ${JSON.stringify(listing.body).slice(0, 200)}`);

    const readiness = await get(`/api/specs/${SPEC_ID}/readiness?workspaceId=${workspaceId}`);
    record('readiness', `${readiness.status} ${JSON.stringify(readiness.body).slice(0, 300)}`);

    const validate = await post(`/api/specs/${SPEC_ID}/validate`, { workspaceId });
    record('validate', `${validate.status} ${JSON.stringify(validate.body).slice(0, 300)}`);

    const preflight = await post('/api/specs/authoring/preflight', { workspaceId });
    record('authoring preflight', `${preflight.status} ${JSON.stringify(preflight.body).slice(0, 400)}`);


    const forge = await post('/api/specs/forge', { workspaceId, brief: 'Wave 5 — Forgejo adapter + omp primary shim (see docs/wave5-forgejo-omp-plan.md)', storyCount: 10, model: 'deepseek/deepseek-v4-flash:high', storyPrefix: 'W5' });
    record('skill-first forge (best effort)', `${forge.status} ${JSON.stringify(forge.body).slice(0, 400)}`);
    let persist: { status: number; body: unknown } | null = null;
    if (preflight.status === 200 || preflight.status === 201) {
      const body = preflight.body as Record<string, unknown>;
      const plan = (body.authoringPlan ?? body.plan ?? body) as Record<string, unknown>;
      const persistBody: Record<string, unknown> = { workspaceId, title: 'Wave 5 — Forgejo Adapter + Oh My Pi Primary Shim', slug: SPEC_ID };
      const acceptedPlanHash = (plan.acceptedPlanHash ?? plan.planHash ?? (body as any).acceptedPlanHash) as string | undefined;
      if (acceptedPlanHash) persistBody.acceptedPlanHash = acceptedPlanHash;
      persist = await post('/api/specs/persist', persistBody);
      record('persist', `${persist.status} ${JSON.stringify(persist.body).slice(0, 400)}`);
    }

    const compile = await post(`/api/specs/${SPEC_ID}/lifecycle/compile`, { workspaceId });
    record('lifecycle compile', `${compile.status} ${JSON.stringify(compile.body).slice(0, 400)}`);

    const approve = await post(`/api/specs/${SPEC_ID}/approve`, { workspaceId });
    record('approve', `${approve.status} ${JSON.stringify(approve.body).slice(0, 400)}`);

    const receipt = [
      '# Wave 5 Spec Pipeline Receipt',
      '',
      `| Field | Receipt |`,
      `|---|---|`,
      `| Date | ${new Date().toISOString()} |`,
      `| Spec | ${SPEC_FILE} (id ${SPEC_ID}, 10 stories W5-001..W5-010) |`,
      `| Stack | ${PROJECT} on 127.0.0.1:${port} (left RUNNING for the wave-run phase) |`,
      `| Workspace | ${workspaceId} |`,
      '',
      '## Transcript',
      '',
      ...transcript,
      '',
      '## Blockers / notes',
      '',
      '- If preflight/persist/compile/approve returned non-2xx, the exact responses above are the blocker evidence; the interactive authoring flow (planner input, provider-human confirmations) may be required.',
      '- LLM spec generation (POST /api/specs/generate) requires provider keys in the API env (absent here); drafting used the wave-4 schema + best-model authoring.',
      '',
    ].join('\n');
    fs.writeFileSync(RECEIPT, receipt);
    record('receipt written', RECEIPT);
  } finally {
    if (process.argv.includes('--teardown')) {
      const down = compose(['down', '--volumes', '--remove-orphans', '--rmi', 'local'], env, 300_000);
      record('teardown', down.ok ? 'compose down OK' : `compose down failed: ${down.stderr.slice(-200)}`);
    }
  }
}

void main().catch((error) => {
  console.error('[specforge] fatal:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
