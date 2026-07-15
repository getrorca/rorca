/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
/**
 * ingest-commit.ts — US-029: ingest-commit and ingest-git commands.
 *
 * Converts git commit metadata (US-028) into context events and conservative
 * pending memory candidates, deduplicated by SHA / idempotency key.
 *
 * Key behaviors:
 *   - Single-commit ingest: `ingestCommit()` extracts metadata, creates a
 *     `context_event` (kind='commit') and zero or more `memory_candidate`
 *     entries, then submits them to the ingestion API or queues them offline.
 *   - Range ingest: `ingestGitRange()` scans `since..HEAD`, deduplicates by
 *     SHA, and calls `ingestCommit()` for each commit.
 *   - Noise detection: commits whose subject matches common noise patterns
 *     (WIP, fix typo, etc.) produce no memory candidates (but always produce
 *     a context event for provenance).
 *   - Idempotency: idempotency keys are `commit:<workspaceId>:<sha>` for
 *     events and `candidate:<workspaceId>:<sha>` for candidates, so reruns
 *     are safe.
 *
 * Design doc: docs/context-intelligence-platform.md §2.4, §5 (data flow).
 */
import simpleGit from 'simple-git';
import { extractCommitMetadata } from './commit-metadata';
import { contextEventSchema, memoryCandidateSchema, } from './capture-contracts';
import { CaptureClient, CaptureQueue } from './capture-client';
// ════════════════════════════════════════════════════════════════════════════
// Noise detection
// ════════════════════════════════════════════════════════════════════════════
/** Commit subject patterns that indicate a "noise" commit that should not
 *  produce memory candidates. The context event is always captured for
 *  provenance, but no candidate is created for these. */
const NOISE_PATTERNS = [
    /^wip\b/i,
    /^fix typo/i,
    /^fix\s+typo/i,
    /^cleanup\s*$/i,
    /^clean\s*up\s*$/i,
    /^chore\s*[\(\[]?\s*deps?\s*[\)\]]?/i,
    /^bump\s+version/i,
    /^update\s+changelog/i,
    /^\.$/,
    /^tmp\b/i,
    /^temp\b/i,
    /^savepoint/i,
    /^checkpoint/i,
    /^nits?\s*$/i,
    /^lint\s*fix/i,
    /^format/i,
    /^revert\s/i,
];
/**
 * Heuristic that classifies a commit as "noise" based on its message subject.
 * Noise commits always produce a context event for provenance but never
 * produce memory candidates.
 */
export function isNoiseCommit(message) {
    const subject = message.subject.trim();
    // Very short messages are likely noise
    if (subject.length < 4)
        return true;
    // Check against known noise patterns
    return NOISE_PATTERNS.some((pattern) => pattern.test(subject));
}
// ════════════════════════════════════════════════════════════════════════════
// Event / Candidate builders
// ════════════════════════════════════════════════════════════════════════════
/** Build a context event from commit metadata. */
export function buildContextEvent(meta, workspaceId) {
    const now = new Date().toISOString();
    const event = {
        schemaVersion: 'v1',
        idempotencyKey: `commit:${workspaceId}:${meta.sha}`,
        workspaceId,
        kind: 'commit',
        source: 'rorca-capture',
        payload: {
            sha: meta.sha,
            branch: meta.branch,
            author: meta.author,
            timestamp: meta.timestamp,
            message: meta.message,
            parents: meta.parents,
            files: meta.files.map((f) => f.path),
            diffStats: meta.diffStats,
        },
        gitSha: meta.sha,
        occurredAt: meta.timestamp,
        capturedAt: now,
    };
    // Validate against the contract
    return contextEventSchema.parse(event);
}
/** Conventional commit prefix → memory category mapping. */
const CONVENTIONAL_CATEGORY_MAP = {
    feat: 'Pattern',
    fix: 'Bug Fix',
    docs: 'Documentation',
    style: 'Style',
    refactor: 'Pattern',
    perf: 'Performance',
    test: 'Testing',
    chore: 'Maintenance',
    ci: 'CI/CD',
    build: 'Build',
    revert: 'Maintenance',
    security: 'Security',
};
/** Detect category from conventional commit prefix. */
function detectCategory(subject) {
    const match = subject.match(/^(\w+)(?:\([^)]*\))?(!)?\s*:/);
    if (match) {
        return CONVENTIONAL_CATEGORY_MAP[match[1].toLowerCase()] ?? 'General';
    }
    return 'General';
}
/** Build zero or more memory candidates from commit metadata.
 *  Noise commits return an empty array. */
export function buildCandidates(meta, workspaceId) {
    const { subject, body } = meta.message;
    // Noise commits produce no candidates
    if (isNoiseCommit(meta.message)) {
        return [];
    }
    const now = new Date().toISOString();
    const eventKey = `commit:${workspaceId}:${meta.sha}`;
    const category = detectCategory(subject);
    const sourceEventKey = eventKey;
    // Confidence heuristic: more files + more lines = more likely meaningful
    const confidence = Math.min(0.9, 0.3 + meta.files.length * 0.02 + (meta.diffStats.insertions + meta.diffStats.deletions) * 0.001);
    const candidate = {
        schemaVersion: 'v1',
        idempotencyKey: `candidate:${workspaceId}:${meta.sha}`,
        workspaceId,
        status: 'pending',
        title: subject.slice(0, 200),
        body: body || subject,
        category: meta.files.length > 0 ? category : `${category} (no files)`,
        trust: 'unverified',
        confidence: Math.round(confidence * 100) / 100,
        sourceEventKey,
        relatedFiles: meta.files.map((f) => f.path),
        createdAt: now,
    };
    // Validate
    memoryCandidateSchema.parse(candidate);
    return [candidate];
}
// ════════════════════════════════════════════════════════════════════════════
// Core ingest functions
// ════════════════════════════════════════════════════════════════════════════
/**
 * Ingest a single commit: extract metadata, create context event + candidates,
 * and submit to the Rorca backend (or queue offline).
 *
 * @param options — Ingest options + optional SHA (defaults to HEAD).
 * @returns Per-commit result.
 */
export async function ingestCommit(options) {
    const { workspaceId, workspacePath, backendUrl, apiKey, dryRun, sha, ignoreMatcher } = options;
    // Extract metadata (throws on invalid repo/SHA)
    const meta = await extractCommitMetadata(workspacePath, {
        sha: sha || 'HEAD',
        ignoreMatcher,
    });
    // Build event + candidates
    const event = buildContextEvent(meta, workspaceId);
    const candidates = buildCandidates(meta, workspaceId);
    const noise = candidates.length === 0;
    // Dry run: return without submitting
    if (dryRun) {
        return {
            commitSha: meta.sha,
            subject: meta.message.subject,
            event: { created: false, queued: false },
            candidates: candidates.map(() => ({ created: false, queued: false })),
            noise,
            idempotencyKey: event.idempotencyKey,
        };
    }
    // Online / offline submission
    const client = new CaptureClient({ baseUrl: backendUrl, apiKey });
    const queue = new CaptureQueue(workspacePath);
    // Submit context event (online first, fall back to queue)
    let eventResult;
    try {
        const res = await client.submitEvent(event);
        eventResult = { id: res.id, created: res.created, queued: false };
    }
    catch {
        queue.enqueueEvent(event);
        eventResult = { created: false, queued: true };
    }
    // Submit memory candidates
    const candidateResults = [];
    for (const candidate of candidates) {
        try {
            const res = await client.submitCandidate(candidate);
            candidateResults.push({ id: res.id, created: res.created, queued: false });
        }
        catch {
            queue.enqueueCandidate(candidate);
            candidateResults.push({ created: false, queued: true });
        }
    }
    return {
        commitSha: meta.sha,
        subject: meta.message.subject,
        event: eventResult,
        candidates: candidateResults,
        noise,
        idempotencyKey: event.idempotencyKey,
    };
}
/**
 * Get the list of unique commit SHAs between `since` and HEAD.
 * Deduplicates by SHA (merge commits can appear multiple times in git log).
 */
async function getCommitRangeShas(workspacePath, since) {
    const git = simpleGit(workspacePath);
    // Validate repo
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
        throw new Error(`Not a git repository: ${workspacePath}`);
    }
    // Resolve 'since' ref
    const resolvedSince = (await git.raw(['rev-parse', '--verify', since])).trim();
    if (!resolvedSince) {
        throw new Error(`Invalid 'since' ref: ${since}`);
    }
    // Get log between since..HEAD, deduplicate
    const log = await git.log({ from: resolvedSince, to: 'HEAD' });
    const seen = new Set();
    const shas = [];
    for (const commit of log.all) {
        if (!seen.has(commit.hash)) {
            seen.add(commit.hash);
            shas.push(commit.hash);
        }
    }
    return shas;
}
/**
 * Ingest a range of commits: scan `since..HEAD`, deduplicate by SHA,
 * and call `ingestCommit()` for each commit.
 *
 * @param options — Ingest options + `since` ref (branch, tag, or SHA).
 * @returns Aggregate result with per-commit breakdown.
 */
export async function ingestGitRange(options) {
    const { workspacePath, since } = options;
    // Get unique commit SHAs in range
    const shas = await getCommitRangeShas(workspacePath, since);
    // Ingest each commit
    const results = [];
    for (const sha of shas) {
        try {
            const result = await ingestCommit({ ...options, sha });
            results.push(result);
        }
        catch (err) {
            // Record failure but continue with remaining commits
            const message = err instanceof Error ? err.message : String(err);
            results.push({
                commitSha: sha,
                subject: `[error: ${message.slice(0, 80)}]`,
                event: { created: false, queued: false },
                candidates: [],
                noise: true,
                idempotencyKey: `commit:${options.workspaceId}:${sha}`,
            });
        }
    }
    return {
        range: `${since}..HEAD`,
        commits: shas.length,
        ingested: results.filter((r) => !r.noise).length,
        noise: results.filter((r) => r.noise).length,
        results,
    };
}
/**
 * Re-run idempotency: re-ingest commits that were already processed.
 * Since idempotency keys are SHA-based, this is safe — the backend will
 * return the existing row with `created: false`.
 *
 * Useful for testing and recovery scenarios.
 */
export async function ingestGitRangeIdempotent(options) {
    // First run
    const first = await ingestGitRange(options);
    // Second run (idempotent)
    const second = await ingestGitRange(options);
    // Merge results — second run should show all created: false
    return {
        ...second,
        // Use first-pass ingested/noise counts for accuracy
        ingested: first.ingested,
        noise: first.noise,
        results: first.results,
    };
}
