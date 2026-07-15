/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared-host filesystem primitives for capture state. All writes are
 * same-directory, randomized, exclusive and no-follow where the host supports
 * it. Existing symlinks and non-regular targets are rejected.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type SecurePathOptions = {
  createParent?: boolean;
  privateParent?: boolean;
};

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 10;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

export function assertSecureParent(filePath: string, options: SecurePathOptions = {}): string {
  const parent = path.dirname(path.resolve(filePath));
  if (options.createParent) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Secure parent must be a real directory: ${parent}`);
  assertOwnedByCurrentUser(stat.uid, parent);
  if (process.platform !== "win32") {
    if ((stat.mode & 0o022) !== 0) throw new Error(`Secure parent must not be group/world writable: ${parent}`);
    if (options.privateParent) {
      chmodSync(parent, 0o700);
      if ((statSync(parent).mode & 0o777) !== 0o700) throw new Error(`Secure parent must have mode 0700: ${parent}`);
    }
  }
  return parent;
}

export function assertSecureRegularFile(filePath: string, expectedMode?: number): void {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Secure file must be a regular non-symlink: ${filePath}`);
  assertOwnedByCurrentUser(stat.uid, filePath);
  if (process.platform !== "win32" && expectedMode !== undefined && (stat.mode & 0o777) !== expectedMode) {
    throw new Error(`Secure file ${filePath} must have mode ${expectedMode.toString(8).padStart(4, "0")}`);
  }
}

export function readSecureFile(filePath: string, options: SecurePathOptions & { expectedMode?: number } = {}): string {
  assertSecureParent(filePath, options);
  const fd = openSync(filePath, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Secure file must be regular: ${filePath}`);
    assertOwnedByCurrentUser(stat.uid, filePath);
    if (process.platform !== "win32" && options.expectedMode !== undefined && (stat.mode & 0o777) !== options.expectedMode) {
      throw new Error(`Secure file ${filePath} must have mode ${options.expectedMode.toString(8).padStart(4, "0")}`);
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function atomicWriteFileSecure(
  filePath: string,
  content: string,
  options: SecurePathOptions & { mode?: number } = {},
): void {
  const resolved = path.resolve(filePath);
  const parent = assertSecureParent(resolved, { createParent: true, privateParent: options.privateParent });
  try {
    assertSecureRegularFile(resolved);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const mode = options.mode ?? 0o600;
  const tmpPath = path.join(parent, `.${path.basename(resolved)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
  const fd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
  try {
    if (process.platform !== "win32") fchmodSync(fd, mode);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    renameSync(tmpPath, resolved);
    if (process.platform !== "win32") chmodSync(resolved, mode);
    fsyncDirectory(parent);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

export function withSecureFileLock<T>(filePath: string, action: () => T, waitMs = LOCK_WAIT_MS): T {
  const resolved = path.resolve(filePath);
  const parent = assertSecureParent(resolved, { createParent: true });
  const lockPath = `${resolved}.lock`;
  const token = randomBytes(24).toString("hex");
  const deadline = Date.now() + waitMs;

  for (;;) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      atomicWriteFileSecure(path.join(lockPath, "owner.json"), `${JSON.stringify({ token, pid: process.pid })}\n`, {
        mode: 0o600,
        privateParent: true,
      });
      break;
    } catch (error) {
      if (!isAlreadyExists(error) || Date.now() >= deadline) {
        throw new Error(`Capture queue lock unavailable: ${path.basename(lockPath)}`);
      }
      Atomics.wait(sleepCell, 0, 0, LOCK_POLL_MS);
    }
  }

  try {
    return action();
  } finally {
    try {
      const owner = JSON.parse(readSecureFile(path.join(lockPath, "owner.json"), { expectedMode: 0o600, privateParent: true })) as { token?: string };
      if (owner.token === token) rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // Fail closed: never remove a lock whose owner cannot be proven.
    }
    fsyncDirectory(parent);
  }
}

function assertOwnedByCurrentUser(uid: number, target: string): void {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  if (uid !== process.getuid()) throw new Error(`Secure path must be owned by the current user: ${target}`);
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  let fd: number | undefined;
  try {
    fd = openSync(directory, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // Some filesystems do not permit directory fsync.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}
