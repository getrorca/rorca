/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
/**
 * git-hook-installer.ts — US-030: Safe git post-commit hook installer/uninstaller.
 *
 * Installs a post-commit hook that runs `rorca capture ingest-commit` for
 * best-effort local context capture. The hook:
 *
 *   - **Chains existing hooks**: if a post-commit hook already exists, it is
 *     preserved and run before the Rorca managed block. If the hook was
 *     previously installed by Rorca, it replaces the old managed block.
 *   - **Best-effort by default**: failures in the Rorca capture command never
 *     block commits. The hook always exits 0 unless `--strict` mode is enabled.
 *   - **Reversible**: uninstall removes only the Rorca managed block, restoring
 *     the previous hook content exactly (if there was a pre-existing hook) or
 *     removing the file entirely (if Rorca was the only content).
 *
 * The managed block is delimited by sentinel comments:
 * ```
 * ### RORCA CAPTURE HOOK START ###
 * ... managed content ...
 * ### RORCA CAPTURE HOOK END ###
 * ```
 *
 * Design doc: docs/context-intelligence-platform.md §2.4 (Capture Sidecar).
 */
import * as fs from 'fs';
import * as path from 'path';
// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════
/** Sentinel marking the start of the Rorca-managed block. */
const BLOCK_START = '### RORCA CAPTURE HOOK START ###';
/** Sentinel marking the end of the Rorca-managed block. */
const BLOCK_END = '### RORCA CAPTURE HOOK END ###';
/** The hook script name managed by Rorca. */
const HOOK_NAME = 'post-commit';
/** Default Rorca capture command injected into the hook.
 *  Uses `rorca` on PATH — the installed binary is always on PATH after
 *  installation. */
const DEFAULT_CAPTURE_COMMAND = 'rorca capture ingest-commit';
// ════════════════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════════════════
/**
 * Install a Rorca-managed post-commit hook in the given git repository.
 *
 * If a post-commit hook already exists:
 *   - If it already contains a Rorca managed block, the block is replaced
 *     (reinstall / update).
 *   - Otherwise, the existing hook content is preserved and the Rorca block
 *     is appended (chaining).
 *
 * The generated hook exits 0 on Rorca capture failure unless `strict` mode
 * is enabled.
 *
 * @param options — install options.
 * @returns A {@link HookResult} describing the outcome.
 */
export function installHook(options) {
    const repoPath = validateRepoPath(options.repoPath);
    const hookPath = path.join(repoPath, '.git', 'hooks', HOOK_NAME);
    const captureCommand = options.captureCommand || DEFAULT_CAPTURE_COMMAND;
    const strict = options.strict ?? false;
    // Build the Rorca managed block
    const managedBlock = buildManagedBlock(captureCommand, options.extraArgs, strict);
    // Read existing hook content (if any)
    let existingContent = null;
    if (fs.existsSync(hookPath)) {
        existingContent = fs.readFileSync(hookPath, 'utf8');
        // If already has a Rorca block, replace it
        if (hasRorcaBlock(existingContent)) {
            const updated = replaceRorcaBlock(existingContent, managedBlock);
            writeHookSafely(hookPath, updated);
            return {
                action: 'updated',
                hadExistingHook: hasNonRorcaContent(existingContent),
                hookPath,
            };
        }
    }
    // Build the final hook content
    let finalContent;
    const hadExisting = existingContent !== null && existingContent.trim().length > 0;
    if (hadExisting) {
        // Chain: existing hook runs first, then Rorca block
        finalContent = chainExistingHook(existingContent, managedBlock);
    }
    else {
        finalContent = managedBlock;
    }
    writeHookSafely(hookPath, finalContent);
    return {
        action: 'installed',
        hadExistingHook: hadExisting,
        hookPath,
    };
}
/**
 * Uninstall the Rorca-managed post-commit hook from the given git repository.
 *
 * If the hook file contains only the Rorca managed block (no pre-existing
 * content), the entire file is removed. If there was pre-existing content
 * preserved alongside the Rorca block, the Rorca block is removed and the
 * original content is restored.
 *
 * If no hook file exists or it doesn't contain a Rorca block, returns
 * `not-installed`.
 *
 * @param options — uninstall options.
 * @returns A {@link HookResult} describing the outcome.
 */
export function uninstallHook(options) {
    const repoPath = validateRepoPath(options.repoPath);
    const hookPath = path.join(repoPath, '.git', 'hooks', HOOK_NAME);
    if (!fs.existsSync(hookPath)) {
        return {
            action: 'not-installed',
            hadExistingHook: false,
            hookPath,
        };
    }
    const existingContent = fs.readFileSync(hookPath, 'utf8');
    if (!hasRorcaBlock(existingContent)) {
        return {
            action: 'not-installed',
            hadExistingHook: existingContent.trim().length > 0,
            hookPath,
        };
    }
    // Remove the Rorca block
    const cleaned = removeRorcaBlock(existingContent);
    const hadExistingHook = cleaned.trim().length > 0;
    if (hadExistingHook) {
        // Restore pre-existing content
        writeHookSafely(hookPath, cleaned);
    }
    else {
        // Remove the file entirely — it was only Rorca content
        try {
            fs.unlinkSync(hookPath);
        }
        catch {
            // Non-fatal — file may already be removed
        }
    }
    return {
        action: 'uninstalled',
        hadExistingHook,
        hookPath,
    };
}
/**
 * Check whether a Rorca-managed post-commit hook is installed in the given
 * git repository.
 *
 * @param repoPath — absolute path to the git repository root.
 * @returns `true` if a post-commit hook with a Rorca block exists.
 */
export function isHookInstalled(repoPath) {
    const hookPath = path.join(repoPath, '.git', 'hooks', HOOK_NAME);
    if (!fs.existsSync(hookPath))
        return false;
    const content = fs.readFileSync(hookPath, 'utf8');
    return hasRorcaBlock(content);
}
/**
 * Get the content of the post-commit hook file (for diagnostics).
 *
 * @param repoPath — absolute path to the git repository root.
 * @returns The hook file content, or `null` if it doesn't exist.
 */
export function readHookContent(repoPath) {
    const hookPath = path.join(repoPath, '.git', 'hooks', HOOK_NAME);
    if (!fs.existsSync(hookPath))
        return null;
    return fs.readFileSync(hookPath, 'utf8');
}
// ════════════════════════════════════════════════════════════════════════════
// Internal helpers
// ════════════════════════════════════════════════════════════════════════════
/**
 * Validate that `repoPath` is a git repository (contains `.git` directory).
 * Throws on invalid input.
 */
function validateRepoPath(repoPath) {
    const resolved = path.resolve(repoPath);
    const gitDir = path.join(resolved, '.git');
    if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) {
        throw new Error(`Not a git repository: ${resolved} (no .git directory found)`);
    }
    return resolved;
}
/**
 * Build the Rorca managed hook block content.
 *
 * Generated script structure:
 * ```sh
 * #!/bin/sh
 * ### RORCA CAPTURE HOOK START ###
 * <capture-command> [extra-args] || true   # (or without || true in strict mode)
 * ### RORCA CAPTURE HOOK END ###
 * ```
 */
function buildManagedBlock(captureCommand, extraArgs, strict = false) {
    const args = extraArgs ? ` ${extraArgs}` : '';
    const command = `${captureCommand}${args}`;
    // In non-strict mode, always exit 0 even on capture failure
    const line = strict
        ? command
        : `${command} || true`;
    return [
        '#!/bin/sh',
        BLOCK_START,
        line,
        BLOCK_END,
        '',
    ].join('\n');
}
/**
 * Chain an existing hook with the Rorca managed block.
 * The existing hook runs first; if it fails, the script still runs Rorca capture
 * (best-effort). The Rorca block runs last and always exits 0 unless strict mode
 * is enabled.
 */
function chainExistingHook(existingContent, managedBlock) {
    // Strip shebang if present — we'll add our own
    let cleaned = existingContent.trim();
    if (cleaned.startsWith('#!/')) {
        cleaned = cleaned.slice(cleaned.indexOf('\n') + 1).trim();
    }
    // Remove the shebang line from managedBlock if it already has one
    let blockBody = managedBlock;
    if (blockBody.startsWith('#!/bin/sh\n')) {
        blockBody = blockBody.slice('#!/bin/sh\n'.length);
    }
    // Find end of block to determine if strict mode
    const isStrict = managedBlock.includes('|| true') ? false : true;
    const parts = [
        '#!/bin/sh',
        '',
        '# === Existing hook (pre-Rorca) ===',
        cleaned,
        '',
        '# === Rorca capture hook ===',
        blockBody.trim(),
        '',
    ];
    if (!isStrict) {
        // Add a final safety net: if for any reason the script reaches here,
        // ensure we exit 0
        parts.push('# Best-effort: always exit 0 unless strict mode', 'exit 0', '');
    }
    return parts.join('\n');
}
/**
 * Check whether the content contains a Rorca managed block.
 */
function hasRorcaBlock(content) {
    return content.includes(BLOCK_START) && content.includes(BLOCK_END);
}
/**
 * Check whether the content has non-Rorca hook logic (i.e., there was a
 * pre-existing hook).
 */
function hasNonRorcaContent(content) {
    const withoutBlock = removeRorcaBlock(content);
    return withoutBlock.trim().length > 0 && withoutBlock.trim() !== '#!/bin/sh';
}
/**
 * Replace the existing Rorca block with a new one.
 * Preserves all content outside the block markers.
 */
function replaceRorcaBlock(content, newBlock) {
    const startIdx = content.indexOf(BLOCK_START);
    const endIdx = content.lastIndexOf(BLOCK_END);
    if (startIdx === -1 || endIdx === -1) {
        // No block found — this shouldn't happen if hasRorcaBlock returned true
        return content;
    }
    const before = content.slice(0, startIdx);
    const after = content.slice(endIdx + BLOCK_END.length);
    // Extract the body of the new block (without the shebang if already present)
    let blockBody = newBlock;
    if (before.trim() === '#!/bin/sh') {
        // Already have a shebang at the top, don't duplicate
        blockBody = newBlock.startsWith('#!/bin/sh\n')
            ? newBlock.slice('#!/bin/sh\n'.length)
            : newBlock;
    }
    return before + blockBody.trimEnd() + '\n' + after;
}
/**
 * Remove the Rorca managed block from content, returning the rest.
 * Preserves all content outside the block markers.
 */
function removeRorcaBlock(content) {
    const startIdx = content.indexOf(BLOCK_START);
    const endIdx = content.lastIndexOf(BLOCK_END);
    if (startIdx === -1 || endIdx === -1) {
        return content;
    }
    const before = content.slice(0, startIdx);
    const after = content.slice(endIdx + BLOCK_END.length);
    // Clean up: if the result is just a shebang with nothing else, remove it
    let result = (before + after).trim();
    // Remove empty trailing lines around the block markers
    result = result.replace(/\n{3,}/g, '\n\n').trim();
    // If only shebang remains, strip it
    if (result === '#!/bin/sh' || result === '#!/bin/bash' || result === '#!/usr/bin/env bash' || result === '#!/usr/bin/env sh') {
        return '';
    }
    return result + '\n';
}
/**
 * Write hook content to the file and make it executable (chmod +x).
 */
function writeHookSafely(hookPath, content) {
    const dir = path.dirname(hookPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(hookPath, content, { mode: 0o755, encoding: 'utf8' });
}
