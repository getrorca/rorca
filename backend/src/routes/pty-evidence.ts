/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import { Router, type Request, type Response } from 'express';
import { queryOne } from '../db/index';
import { handleRouteError } from '../lib/async-handler';
import { isSuperUser } from '../lib/auth-utils';
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  RawArchiveIntegrityError,
  TranscriptPersistenceError,
  ValidationError,
} from '../lib/errors';
import {
  getRawPtyArchiveManifest,
  resolveRawArchiveSegmentPath,
  verifyRawPtyArchive,
} from '../lib/pty-raw-archive';
import { listPtyTranscriptEvents } from '../lib/pty-transcript-store';

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface EvidenceIdentity {
  runId: number;
  generationId: string;
  workspaceId: string;
}

function parseIdentity(req: Request): { runId: number; generationId: string } {
  const runId = Number(req.params.runId);
  const generationId = String(req.params.generationId ?? '');
  if (!Number.isSafeInteger(runId) || runId < 1) throw new ValidationError('runId must be a positive safe integer');
  if (!UUID_PATTERN.test(generationId)) throw new ValidationError('generationId must be a UUID');
  return { runId, generationId };
}

async function assertEvidenceAccess(req: Request): Promise<EvidenceIdentity> {
  const identity = parseIdentity(req);
  const generation = await queryOne<{ workspace_id: string }>(
    `SELECT g.workspace_id
     FROM pty_generations g
     JOIN pipeline_runs pr ON pr.id = g.run_id AND pr.workspace_id = g.workspace_id
     WHERE g.run_id = $1 AND g.id = $2`,
    [identity.runId, identity.generationId],
  );
  if (!generation) throw new NotFoundError('PTY generation');
  if (!req.user) throw new ForbiddenError('Authentication required');
  if (!isSuperUser(req.user)) {
    const membership = await queryOne<{ role: string }>(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_auth_id = $2`,
      [generation.workspace_id, req.user.supabaseId],
    );
    if (!membership) throw new ForbiddenError('PTY evidence belongs to another workspace');
  }
  return { ...identity, workspaceId: generation.workspace_id };
}

function assertRawArchiveOperator(req: Request): void {
  if (!isSuperUser(req.user)) {
    throw new ForbiddenError('Raw PTY archive download requires local operator admin access');
  }
}

function handleEvidenceRouteError(res: Response, error: unknown, context: string, fallback: AppError): void {
  // Unknown database/filesystem messages may contain infrastructure paths or
  // connection details. Evidence endpoints expose only bounded AppError shapes.
  handleRouteError(res, error instanceof AppError ? error : fallback, context);
}

interface ArchiveByteRange { start: number; end: number }

function parseArchiveRange(value: string | undefined, length: number): ArchiveByteRange | null {
  if (!value) return null;
  if (length < 1 || value.includes(',')) throw new ValidationError('Archive Range must select one satisfiable byte interval');
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) throw new ValidationError('Archive Range must use bytes=start-end syntax');
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) throw new ValidationError('Archive suffix range is invalid');
    start = Math.max(0, length - suffixLength);
    end = length - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : length - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= length || end < start) {
    throw new ValidationError('Archive Range is unsatisfiable');
  }
  return { start, end: Math.min(end, length - 1) };
}

async function waitForDrainOrClose(res: Response): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (drained: boolean) => {
      if (settled) return;
      settled = true;
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onClose);
      resolve(drained);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onClose);
  });
}

/**
 * @swagger
 * /api/pty-evidence/runs/{runId}/generations/{generationId}/transcript:
 *   get:
 *     tags: [Pipeline]
 *     summary: List one bounded page of normalized PTY transcript events
 *     operationId: listPtyTranscriptEvents
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Generation-scoped readable history is redacted, workspace-authorized, and cursor-paged, making this user-owned local read safe for authenticated API and MCP recovery."
 *     parameters:
 *       - { in: path, name: runId, required: true, schema: { type: integer, minimum: 1 } }
 *       - { in: path, name: generationId, required: true, schema: { type: string, format: uuid } }
 *       - { in: query, name: cursor, schema: { type: string }, description: Opaque generation-bound sequence cursor }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 50 } }
 *     responses:
 *       200: { description: Ordered redacted events, next cursor, and explicit sequence gaps }
 *       400: { description: Malformed cursor }
 *       409: { description: Cursor belongs to another generation }
 *       403: { description: Workspace access denied }
 *       404: { description: Generation not found }
 */
router.get('/runs/:runId/generations/:generationId/transcript', async (req: Request, res: Response) => {
  try {
    const identity = await assertEvidenceAccess(req);
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new ValidationError('limit must be a positive integer');
    }
    const page = await listPtyTranscriptEvents({
      runId: identity.runId,
      generationId: identity.generationId,
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null,
      limit,
    });
    res.status(200).json(page);
  } catch (error) {
    handleEvidenceRouteError(
      res,
      error,
      '[PTY Evidence] Transcript listing',
      new TranscriptPersistenceError('PTY transcript listing is temporarily unavailable'),
    );
  }
});

/**
 * @swagger
 * /api/pty-evidence/runs/{runId}/generations/{generationId}/raw-archive/manifest:
 *   get:
 *     tags: [Pipeline]
 *     summary: Inspect raw PTY archive retention and integrity metadata
 *     operationId: getRawPtyArchiveManifest
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "User-owned local run evidence is a workspace-authorized read; exposing its bounded manifest supports authenticated recovery and MCP automation without mutation."
 *     parameters:
 *       - { in: path, name: runId, required: true, schema: { type: integer, minimum: 1 } }
 *       - { in: path, name: generationId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Restricted manifest with ranges, hashes, sizes, retention, and completion state }
 *       403: { description: Workspace access denied }
 *       404: { description: Archive not found or pruned }
 */
router.get(
  '/runs/:runId/generations/:generationId/raw-archive/manifest',
  async (req: Request, res: Response) => {
    try {
      const identity = await assertEvidenceAccess(req);
      const manifest = await getRawPtyArchiveManifest(identity.runId, identity.generationId);
      res.status(200).json(manifest);
    } catch (error) {
      handleEvidenceRouteError(
        res,
        error,
        '[PTY Evidence] Raw archive manifest',
        new RawArchiveIntegrityError('Raw PTY archive manifest is unavailable'),
      );
    }
  },
);

/**
 * @swagger
 * /api/pty-evidence/runs/{runId}/generations/{generationId}/raw-archive:
 *   get:
 *     tags: [Pipeline]
 *     summary: Stream a verified raw PTY archive as concatenated gzip segments
 *     operationId: downloadRawPtyArchive
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Exact raw terminal bytes can contain secrets and operator input; download is restricted to an explicit local operator action and excluded from MCP."
 *     parameters:
 *       - { in: path, name: runId, required: true, schema: { type: integer, minimum: 1 } }
 *       - { in: path, name: generationId, required: true, schema: { type: string, format: uuid } }
 *       - { in: header, name: Range, required: false, schema: { type: string }, description: Single byte range over the verified concatenated gzip representation }
 *     responses:
 *       200: { description: Complete verified gzip stream containing only this generation's captured terminal bytes }
 *       206: { description: Requested byte range of the verified gzip representation }
 *       400: { description: Malformed, multiple, or unsatisfiable byte range }
 *       403: { description: Workspace access denied or containment validation failed }
 *       404: { description: Archive not found or retention-pruned }
 *       409: { description: Archive is still being written }
 *       422: { description: Missing, corrupt, or discontinuous archive segment }
 */
router.get(
  '/runs/:runId/generations/:generationId/raw-archive',
  async (req: Request, res: Response) => {
    try {
      const identity = await assertEvidenceAccess(req);
      assertRawArchiveOperator(req);
      const archive = await verifyRawPtyArchive(identity.runId, identity.generationId);
      const representationLength = archive.segments.reduce((sum, segment) => sum + segment.compressedSize, 0);
      const range = parseArchiveRange(req.get('Range'), representationLength);
      const responseStart = range?.start ?? 0;
      const responseEnd = range?.end ?? Math.max(0, representationLength - 1);
      const responseLength = representationLength === 0 ? 0 : responseEnd - responseStart + 1;

      res.status(range ? 206 : 200);
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="rorca-run-${identity.runId}-${identity.generationId}-pty.gz"`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', String(responseLength));
      if (range) res.setHeader('Content-Range', `bytes ${responseStart}-${responseEnd}/${representationLength}`);
      res.setHeader('X-Rorca-Archive-Contract', String(archive.contractVersion));
      res.setHeader('X-Rorca-Archive-Segments', String(archive.segments.length));
      res.setHeader('X-Rorca-Archive-Raw-Bytes', String(archive.nextRawOffset));
      res.setHeader('X-Rorca-Archive-Retention-Expires', archive.retentionExpiresAt);
      res.setHeader('X-Content-Type-Options', 'nosniff');

      let representationOffset = 0;
      for (let index = 0; index < archive.segments.length; index += 1) {
        if (res.destroyed || res.writableEnded || !res.socket?.writable) return;
        const segment = archive.segments[index];
        const segmentStart = representationOffset;
        const segmentEnd = segmentStart + segment.compressedSize - 1;
        representationOffset = segmentEnd + 1;
        if (segmentEnd < responseStart || segmentStart > responseEnd) continue;

        // Re-resolve immediately before each stream. No request-controlled path
        // or previously verified absolute path is trusted as filesystem input.
        const segmentPath = resolveRawArchiveSegmentPath(
          archive.workspacePath,
          archive.archiveRootRelative,
          segment.relativePath,
        );
        if (segmentPath !== archive.verifiedPaths[index]) {
          throw new RawArchiveIntegrityError('Raw archive path changed after verification', {
            segmentIndex: segment.segmentIndex,
          });
        }
        const localStart = Math.max(0, responseStart - segmentStart);
        const localEnd = Math.min(segment.compressedSize - 1, responseEnd - segmentStart);
        for await (const chunk of fs.createReadStream(segmentPath, { start: localStart, end: localEnd })) {
          if (res.destroyed || res.writableEnded || !res.socket?.writable) return;
          if (!res.write(chunk)) {
            const drained = await waitForDrainOrClose(res);
            if (!drained) return;
          }
        }
      }
      if (!res.destroyed && !res.writableEnded && res.socket?.writable) res.end();
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      handleEvidenceRouteError(
        res,
        error,
        '[PTY Evidence] Raw archive download',
        new RawArchiveIntegrityError('Raw PTY archive download is unavailable'),
      );
    }
  },
);

export default router;
