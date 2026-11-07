/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { closePool, execute, initDb, query } from '../src/db';
import { applySelectedDbModeEnvironment } from '../src/lib/db-strategy';
import {
  assertSealedSpecExportKit,
  SpecExportKitInputSchema,
  inspectSpecExportKit,
  publishSpecExportKit,
  sealSpecExportKit,
} from '../src/lib/spec-export-kit';
import { markCurrentPlanStaleIfMaterialChanged } from '../src/lib/ssdlc-plan-service';

type Classification = 'legacy_complete' | 'legacy_partial';
type WorkspaceRow = { id: string; path: string };

const apply = process.argv.includes('--apply');
const workspaceArgIndex = process.argv.indexOf('--workspace');
const selectedWorkspace = workspaceArgIndex >= 0 ? process.argv[workspaceArgIndex + 1] : null;

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeAtomically(filePath: string, content: string): void {
  const temporary = `${filePath}.export-kit-upgrade-${process.pid}.tmp`;
  const backup = `${filePath}.pre-export-kit-${Date.now()}.bak`;
  fs.copyFileSync(filePath, backup, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const descriptor = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filePath);
}

function specFiles(workspacePath: string): Array<{ state: 'pending' | 'approved'; filePath: string }> {
  return (['pending', 'approved'] as const).flatMap((state) => {
    const directory = path.join(workspacePath, 'forge', 'specs', state);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => ({ state, filePath: path.join(directory, entry.name) }));
  });
}

function sealApprovedGeneration(
  workspacePath: string,
  document: Record<string, unknown>,
): { sealHash: string } {
  const identity = document.exportKitIdentity as { kitPath?: string } | undefined;
  const sealPath = identity?.kitPath
    ? path.join(workspacePath, identity.kitPath, 'approval-receipt.json')
    : '';
  if (sealPath && fs.existsSync(sealPath)) {
    assertSealedSpecExportKit(workspacePath, document);
    return JSON.parse(fs.readFileSync(sealPath, 'utf8')) as { sealHash: string };
  }
  return sealSpecExportKit(workspacePath, document, {
    actorId: 'rorca-legacy-approved-spec-migration',
    approvalReceiptId: null,
  });
}

async function main(): Promise<void> {
  dotenv.config({ path: path.resolve(process.cwd(), '.env') });
  applySelectedDbModeEnvironment();
  await initDb();
  try {
    const workspaces = await query<WorkspaceRow>(
      `SELECT id,path FROM rorca.workspaces ${selectedWorkspace ? 'WHERE id = $1' : ''} ORDER BY id`,
      selectedWorkspace ? [selectedWorkspace] : [],
    );
    const report: Array<Record<string, unknown>> = [];
    for (const workspace of workspaces) {
      for (const candidate of specFiles(workspace.path)) {
        let document: Record<string, unknown>;
        try {
          document = JSON.parse(fs.readFileSync(candidate.filePath, 'utf8')) as Record<string, unknown>;
        } catch (error) {
          report.push({ workspaceId: workspace.id, file: candidate.filePath, status: 'invalid_json', error: String(error) });
          continue;
        }
        const slug = String(document.id ?? document.slug ?? path.basename(candidate.filePath, '.json'));
        if (typeof document.id !== 'string' || document.id.trim() === '') document.id = slug;
        if (typeof document.slug !== 'string' || document.slug.trim() === '') document.slug = slug;
        const classification: Classification = SpecExportKitInputSchema.safeParse(document.exportKit).success
          ? 'legacy_complete'
          : 'legacy_partial';
        const inspection = inspectSpecExportKit(workspace.path, document);
        if (inspection.status === 'current' && inspection.identity) {
          if (!apply) {
            report.push({ workspaceId: workspace.id, slug, state: candidate.state, classification, status: 'already_current' });
            continue;
          }
          const seal = candidate.state === 'approved' ? sealApprovedGeneration(workspace.path, document) : null;
          await execute(
            `INSERT INTO rorca.spec_export_kit_generations
               (workspace_id,spec_slug,spec_material_hash,manifest_hash,kit_path,classification,state,seal_hash,sealed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $7 = 'sealed' THEN clock_timestamp() ELSE NULL END)
             ON CONFLICT (workspace_id,spec_slug,manifest_hash) DO NOTHING`,
            [workspace.id, slug, inspection.identity.specMaterialHash, inspection.identity.manifestHash,
              inspection.identity.kitPath, classification, seal ? 'sealed' : 'draft', seal?.sealHash ?? null],
          );
          if (seal) {
            await execute(
              `UPDATE rorca.spec_export_kit_generations
                  SET state = 'sealed', seal_hash = $4, sealed_at = COALESCE(sealed_at, clock_timestamp())
                WHERE workspace_id = $1 AND spec_slug = $2 AND manifest_hash = $3 AND state = 'draft'`,
              [workspace.id, slug, inspection.identity.manifestHash, seal.sealHash],
            );
          }
          await markCurrentPlanStaleIfMaterialChanged({
            workspaceId: workspace.id,
            workspacePath: workspace.path,
            specSlug: slug,
          });
          report.push({ workspaceId: workspace.id, slug, state: candidate.state, classification, status: 'ledger_reconciled' });
          continue;
        }
        if (inspection.status === 'tampered') {
          report.push({ workspaceId: workspace.id, slug, state: candidate.state, classification, status: 'blocked_tampered', reason: inspection.reason });
          continue;
        }
        if (!apply) {
          report.push({ workspaceId: workspace.id, slug, state: candidate.state, classification, status: 'would_upgrade' });
          continue;
        }
        let identity: ReturnType<typeof publishSpecExportKit>;
        try {
          identity = publishSpecExportKit(workspace.path, document);
        } catch (error) {
          report.push({
            workspaceId: workspace.id,
            slug,
            state: candidate.state,
            classification,
            status: 'blocked_invalid',
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        document.exportKitIdentity = identity;
        const seal = candidate.state === 'approved'
          ? sealApprovedGeneration(workspace.path, document)
          : null;
        writeAtomically(candidate.filePath, canonicalJson(document));
        await execute(
          `INSERT INTO rorca.spec_export_kit_generations
             (workspace_id,spec_slug,spec_material_hash,manifest_hash,kit_path,classification,state,seal_hash,sealed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $7 = 'sealed' THEN clock_timestamp() ELSE NULL END)
           ON CONFLICT (workspace_id,spec_slug,manifest_hash) DO NOTHING`,
          [workspace.id, slug, identity.specMaterialHash, identity.manifestHash, identity.kitPath,
            classification, seal ? 'sealed' : 'draft', seal?.sealHash ?? null],
        );
        if (seal) {
          await execute(
            `UPDATE rorca.spec_export_kit_generations
                SET state = 'sealed', seal_hash = $4, sealed_at = COALESCE(sealed_at, clock_timestamp())
              WHERE workspace_id = $1 AND spec_slug = $2 AND manifest_hash = $3 AND state = 'draft'`,
            [workspace.id, slug, identity.manifestHash, seal.sealHash],
          );
        }
        await markCurrentPlanStaleIfMaterialChanged({
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          specSlug: slug,
        });
        report.push({ workspaceId: workspace.id, slug, state: candidate.state, classification, status: 'upgraded', manifestHash: identity.manifestHash, sealHash: seal?.sealHash ?? null });
      }
    }
    process.stdout.write(`${JSON.stringify({ apply, workspace: selectedWorkspace, specs: report }, null, 2)}\n`);
  } finally {
    await closePool();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
