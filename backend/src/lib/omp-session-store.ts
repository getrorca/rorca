/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * omp-session-store.ts — Host-side durable mirror of omp RPC session JSONL.
 *
 * The sandboxed omp lane writes its own session file into the ephemeral
 * per-run runtime dir, which is deleted at run end, so Rorca-executed
 * sessions never surface in the operator's OMP app. This store tees every
 * JSONL event of the run stream into a durable, omp-compatible session file
 * under the operator's omp store:
 *
 *   ~/.omp/profiles/rorca/agent/sessions/<cwd-namespace>/<ts>_<sessionId>.jsonl
 *
 * The directory layout and file naming replicate omp 17.x SessionManager
 * conventions — per-cwd namespace dirs (`S_5`/`R_5` encoding) and
 * `<toISOString with ':' and '.' replaced by '-'>_<sessionId>.jsonl` — so
 * `omp --profile rorca --resume [<id-prefix>]` discovers the file from the
 * run worktree's per-cwd namespace dir and the picker/`listAll` glob can
 * find it.
 *
 * The store is a pure tee: it never rewrites or withholds events. Failures
 * surface as thrown Errors so the caller (the execution engine) can contain
 * them without altering the events forwarded to the run.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Default sessions root below a home dir: `.omp/profiles/rorca/agent/sessions`. */
export const OMP_PROFILE_SESSIONS_SUBDIR = path.join('.omp', 'profiles', 'rorca', 'agent', 'sessions');

/**
 * Optional operator-store override. When set, `RORCA_OMP_SESSION_STORE_ROOT`
 * replaces the default `<operator-home>/.omp/profiles/rorca/agent/sessions`
 * root (tests, tooling, or host-side store relocation). Empty/unset keeps the
 * default.
 */
export const OMP_SESSION_STORE_ROOT_ENV = 'RORCA_OMP_SESSION_STORE_ROOT';

/**
 * The operator's home dir. Prefers the passwd entry (`os.userInfo().homedir`)
 * over `os.homedir()` because `os.homedir()` honors a redirected `$HOME`
 * (the sandboxed omp lane runs with `$HOME` pointed at the ephemeral per-run
 * runtime root); the durable operator store must live outside that root so it
 * survives run cleanup. Falls back to `os.homedir()` when the passwd lookup
 * is unavailable.
 */
export function defaultOperatorHomeDir(): string {
  try {
    const info = os.userInfo();
    if (info.homedir) return info.homedir;
  } catch {
    // passwd lookup unavailable (containers, restricted environments)
  }
  return os.homedir();
}

/** Session files are created operator-private (0600). */
export const OMP_SESSION_FILE_MODE = 0o600;

export interface OmpSessionStoreOptions {
  /** Sessions root; defaults to `<operator-home>/.omp/profiles/rorca/agent/sessions`. */
  sessionsRoot?: string;
  /** Home dir used for omp's cwd-namespace encoding; defaults to `defaultOperatorHomeDir()`. */
  homeDir?: string;
  /** Temp dir used for omp's cwd-namespace encoding; defaults to `os.tmpdir()`. */
  tmpDir?: string;
  /** Clock used for the session filename timestamp; defaults to `() => new Date()`. */
  now?: () => Date;
}

interface OpenSession {
  fd: number;
  filePath: string;
}

/**
 * omp-compatible session file name: `<ISO-8601 with ':' and '.' replaced by
 * '-'>_<sessionId>.jsonl`, mirroring omp's SessionManager
 * (`toISOString().replace(/[:.]/g, '-')` plus `_<sessionId>.jsonl`).
 */
export function ompSessionFileName(sessionId: string, startedAt: Date): string {
  return `${startedAt.toISOString().replace(/[:.]/g, '-')}_${sessionId}.jsonl`;
}

/**
 * Per-cwd namespace directory omp uses under the sessions root. Replicates
 * omp 17.x `SessionManager` `S_5`/`R_5`/`myA` encoding:
 *   - cwd inside the home dir  -> `-<relative-with-dashes>` (`-` when equal)
 *   - cwd inside the temp dir  -> `-tmp-<relative-with-dashes>`
 *   - any other absolute path  -> `--<absolute-with-dashes>--`
 * Slashes, backslashes, and colons become dashes, exactly like omp.
 */
export function ompSessionNamespaceDir(cwd: string, homeDir: string, tmpDir: string): string {
  const resolved = path.resolve(cwd);
  const home = path.resolve(homeDir);
  const tmp = path.resolve(tmpDir);

  const relHome = path.relative(home, resolved);
  if (relHome === '' || (!relHome.startsWith('..') && !path.isAbsolute(relHome))) {
    return dashJoin('-', relHome);
  }
  const relTmp = path.relative(tmp, resolved);
  if (relTmp === '' || (!relTmp.startsWith('..') && !path.isAbsolute(relTmp))) {
    return dashJoin('-tmp', relTmp);
  }
  return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

function dashJoin(prefix: string, relative: string): string {
  const encoded = relative.replace(/[/\\:]/g, '-');
  if (!encoded) return prefix;
  return prefix.endsWith('-') ? `${prefix}${encoded}` : `${prefix}-${encoded}`;
}


/**
 * Standard omp `session` header entry. omp's session listings (`hT0`/`uT0`)
 * require a `{"type":"session","id":...}` entry inside the first 4096 bytes,
 * otherwise `--resume`/the picker drop the file — so the tee writes it once
 * when the file is created, before the first mirrored event.
 */
function buildSessionHeaderEntry(sessionId: string, startedAt: Date, cwd: string): string {
  const entry = {
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: startedAt.toISOString(),
    cwd: path.resolve(cwd),
  };
  return `${JSON.stringify(entry)}\n`;
}

/** Throws when any path component between `root` (exclusive) and `target` is a symlink. */
function assertNoSymlinkChain(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative) return;
  let current = root;
  for (const segment of relative.split(path.sep)) {
    if (!segment || segment === '.') continue;
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return; // component does not exist yet — nothing to follow
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`OmpSessionStoreRefusedSymlink: refusing to write through symlink ${current}`);
    }
  }
}

/**
 * Durable, omp-compatible session mirror. One instance is owned by a single
 * omp RPC story lane; sessions are keyed by omp session id. All methods are
 * synchronous so appends are strictly ordered and `close()` can fsync before
 * the caller tears the lane down.
 */
export class OmpSessionStore {
  readonly sessionsRoot: string;
  private readonly homeDir: string;
  private readonly tmpDir: string;
  private readonly now: () => Date;
  private readonly openSessions = new Map<string, OpenSession>();

  constructor(options: OmpSessionStoreOptions = {}) {
    const operatorHome = defaultOperatorHomeDir();
    const envRoot = process.env[OMP_SESSION_STORE_ROOT_ENV]?.trim();
    this.sessionsRoot = options.sessionsRoot
      ?? (envRoot || path.join(operatorHome, OMP_PROFILE_SESSIONS_SUBDIR));
    this.homeDir = options.homeDir ?? operatorHome;
    this.tmpDir = options.tmpDir ?? os.tmpdir();
    this.now = options.now ?? (() => new Date());
  }

  /** True when the session currently has an open durable file. */
  isOpen(sessionId: string): boolean {
    return this.openSessions.has(sessionId);
  }

  /** Durable file path for an open session, or undefined when not open. */
  filePathFor(sessionId: string): string | undefined {
    return this.openSessions.get(sessionId)?.filePath;
  }

  /**
   * Open (or reuse) the durable session file for `sessionId` in the per-cwd
   * namespace dir of `cwd`. Idempotent: a second open for the same session —
   * e.g. a duplicate `session_started` event — returns the already-open file
   * path without appending anything. When the file is newly created, omp's
   * standard `session` header entry is written first so omp's listings and
   * `--resume` discover the file. The file is created 0600 and writes never
   * follow symlinks (component checks plus O_NOFOLLOW on open). Throws on
   * failure; the caller decides how to contain it.
   */
  open(sessionId: string, cwd: string): string {
    const existing = this.openSessions.get(sessionId);
    if (existing) return existing.filePath;

    const namespaceDir = ompSessionNamespaceDir(cwd, this.homeDir, this.tmpDir);
    const dirPath = path.join(this.sessionsRoot, namespaceDir);
    assertNoSymlinkChain(this.sessionsRoot, dirPath);
    fs.mkdirSync(dirPath, { recursive: true });

    const startedAt = this.now();
    const fileName = ompSessionFileName(sessionId, startedAt);
    const filePath = path.join(dirPath, fileName);
    assertNoSymlinkChain(this.sessionsRoot, filePath);

    const fileExisted = fs.existsSync(filePath);
    const fd = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
      OMP_SESSION_FILE_MODE,
    );
    try {
      fs.fchmodSync(fd, OMP_SESSION_FILE_MODE);
      if (!fileExisted) {
        fs.writeSync(fd, buildSessionHeaderEntry(sessionId, startedAt, cwd));
      }
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
    this.openSessions.set(sessionId, { fd, filePath });
    return filePath;
  }

  /**
   * Append one JSONL line to the session's durable file. No-op when the
   * session is not open (e.g. after `close()`). Throws on write failure;
   * the caller contains it so the run stream is never altered.
   */
  append(sessionId: string, line: string): void {
    const session = this.openSessions.get(sessionId);
    if (!session) return;
    fs.writeSync(session.fd, line);
  }

  /**
   * fsync + close the session's durable file so it survives run cleanup.
   * Idempotent: a second close (or closing a never-opened session) is a no-op.
   */
  close(sessionId: string): void {
    const session = this.openSessions.get(sessionId);
    if (!session) return;
    this.openSessions.delete(sessionId);
    try {
      fs.fsyncSync(session.fd);
    } finally {
      fs.closeSync(session.fd);
    }
  }
}
