/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { Request, Response, NextFunction } from 'express';
import crypto, { randomUUID } from 'crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import jwt from 'jsonwebtoken';
import {
  registerWorkspaceSnapshot,
  unregisterWorkspaceSnapshot,
} from './workspace-snapshot-registry';
import { getMcpAdminToken, getMcpPublicToken } from './mcp-auth';
import { parseHermesAuthority } from './hermes-authority';

export interface AuthUser {
  id: string;
  email: string;
  supabaseId: string;
  role: string;
  plan?: string;
}

interface AppUserRow {
  id: string;
  email: string;
  role: string;
  plan: string | null;
}

export const LOCAL_ADMIN = {
  id: 'local-admin',
  email: 'admin@rorca.local',
  supabaseId: '00000000-0000-0000-0000-000000000001',
  displayName: 'Admin',
  role: 'admin' as const,
  plan: 'pro' as const,
  githubConnected: false,
  emailVerified: true,
};

export class UnsafeWorkspacePathError extends Error {
  readonly code = 'UNSAFE_WORKSPACE_PATH';

  constructor(message: string) {
    super(message);
    this.name = 'UnsafeWorkspacePathError';
  }
}

export interface WorkspaceBoundary {
  rootPath: string;
  device: number;
  inode: number;
}

export type WorkspaceLocation = string | WorkspaceBoundary;

export interface SafeWorkspaceStat {
  size: number;
  mtime: Date;
}

export interface SafeWorkspaceFile {
  absolutePath: string;
  stat: SafeWorkspaceStat;
}

export interface SafeWorkspaceTextFile extends SafeWorkspaceFile {
  content: string;
}

export class WorkspaceFileExistsError extends Error {
  readonly code = 'WORKSPACE_FILE_EXISTS';

  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceFileExistsError';
  }
}

const SAFE_WORKSPACE_MUTATION_SCRIPT = String.raw`
import base64, json, os, secrets, stat, sys

request = json.load(sys.stdin)
root_fd = os.open(request["root"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
root_stat = os.fstat(root_fd)
if root_stat.st_dev != request["device"] or root_stat.st_ino != request["inode"]:
    raise RuntimeError("workspace root identity changed")

created_directories = []

def open_parent(relative, create=False):
    parts = relative.split("/")
    current = os.dup(root_fd)
    try:
        for component in parts[:-1]:
            try:
                next_fd = os.open(
                    component,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=current,
                )
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(component, 0o755, dir_fd=current)
                created_directories.append((os.dup(current), component))
                next_fd = os.open(
                    component,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=current,
                )
            os.close(current)
            current = next_fd
        return current, parts[-1]
    except:
        os.close(current)
        raise

def write_all(fd, content):
    os.lseek(fd, 0, os.SEEK_SET)
    os.ftruncate(fd, 0)
    offset = 0
    while offset < len(content):
        offset += os.write(fd, content[offset:])
    os.fsync(fd)

backups = []
try:
    if request["operation"] == "delete":
        parent_fd, name = open_parent(request["path"])
        target_fd = -1
        quarantine = ".rorca-delete-" + secrets.token_hex(16)
        try:
            target_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
            target_stat = os.fstat(target_fd)
            if not stat.S_ISREG(target_stat.st_mode):
                raise RuntimeError("target is not a regular file")
            os.rename(
                name,
                quarantine,
                src_dir_fd=parent_fd,
                dst_dir_fd=parent_fd,
            )
            moved_stat = os.stat(quarantine, dir_fd=parent_fd, follow_symlinks=False)
            if moved_stat.st_dev != target_stat.st_dev or moved_stat.st_ino != target_stat.st_ino:
                try:
                    os.link(
                        quarantine,
                        name,
                        src_dir_fd=parent_fd,
                        dst_dir_fd=parent_fd,
                        follow_symlinks=False,
                    )
                    os.unlink(quarantine, dir_fd=parent_fd)
                except FileExistsError:
                    pass
                raise RuntimeError("target changed during delete")
            os.unlink(quarantine, dir_fd=parent_fd)
            os.fsync(parent_fd)
        finally:
            if target_fd >= 0:
                os.close(target_fd)
            os.close(parent_fd)
        print(json.dumps({"deleted": True}))
    elif request["operation"] == "write":
        results = []
        for item in request["files"]:
            parent_fd, name = open_parent(item["path"], create=True)
            existed = True
            try:
                target_fd = os.open(name, os.O_RDWR | os.O_NOFOLLOW, dir_fd=parent_fd)
            except FileNotFoundError:
                existed = False
                target_fd = os.open(
                    name,
                    os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o666,
                    dir_fd=parent_fd,
                )
            if item.get("exclusive") and existed:
                os.close(target_fd)
                os.close(parent_fd)
                raise FileExistsError(item["path"])
            target_stat = os.fstat(target_fd)
            if not stat.S_ISREG(target_stat.st_mode):
                os.close(target_fd)
                os.close(parent_fd)
                raise RuntimeError("target is not a regular file")
            old_content = b""
            if existed:
                while True:
                    chunk = os.read(target_fd, 65536)
                    if not chunk:
                        break
                    old_content += chunk
            backups.append((
                parent_fd,
                name,
                existed,
                old_content,
                target_stat.st_mode & 0o777,
                target_stat.st_atime_ns,
                target_stat.st_mtime_ns,
                target_stat.st_dev,
                target_stat.st_ino,
                target_fd,
            ))
            content = base64.b64decode(item["content"])
            write_all(target_fd, content)
            result_stat = os.fstat(target_fd)
            results.append({
                "path": item["path"],
                "size": result_stat.st_size,
                "mtimeMs": result_stat.st_mtime_ns / 1000000,
            })
        for parent_fd, _, _, _, _, _, _, _, _, target_fd in backups:
            os.close(target_fd)
            os.close(parent_fd)
        backups.clear()
        for parent_fd, _ in created_directories:
            os.close(parent_fd)
        created_directories.clear()
        print(json.dumps({"files": results}))
    else:
        raise RuntimeError("operation is not allowlisted")
except Exception as error:
    for parent_fd, name, existed, old_content, old_mode, old_atime_ns, old_mtime_ns, old_dev, old_ino, target_fd in reversed(backups):
        try:
            if existed:
                write_all(target_fd, old_content)
                os.fchmod(target_fd, old_mode)
                os.utime(target_fd, ns=(old_atime_ns, old_mtime_ns))
            else:
                try:
                    current_stat = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                except FileNotFoundError:
                    current_stat = None
                if current_stat is not None and current_stat.st_dev == old_dev and current_stat.st_ino == old_ino:
                    os.unlink(name, dir_fd=parent_fd)
            os.fsync(parent_fd)
        finally:
            os.close(target_fd)
            os.close(parent_fd)
    for parent_fd, name in reversed(created_directories):
        try:
            os.rmdir(name, dir_fd=parent_fd)
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    code = "EXISTS" if isinstance(error, FileExistsError) else "UNSAFE"
    print(json.dumps({"error": code, "message": str(error)}), file=sys.stderr)
    sys.exit(17)
finally:
    os.close(root_fd)
`;

const SAFE_WORKSPACE_GIT_SCRIPT = String.raw`
import base64, json, os, subprocess, sys

request = json.load(sys.stdin)
if request["args"][0] not in {
    "show", "hash-object", "read-tree", "update-index",
    "write-tree", "commit-tree", "update-ref", "rev-parse",
}:
    raise RuntimeError("git operation is not allowlisted")
root_fd = os.open(request["root"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
root_stat = os.fstat(root_fd)
if root_stat.st_dev != request["device"] or root_stat.st_ino != request["inode"]:
    raise RuntimeError("workspace root identity changed")
os.fchdir(root_fd)
git = next((candidate for candidate in ("/usr/bin/git", "/usr/local/bin/git") if os.path.isfile(candidate)), None)
if git is None:
    raise RuntimeError("git executable is unavailable")
environment = {
    "PATH": "/usr/bin:/usr/local/bin",
    "HOME": "/nonexistent",
    "LANG": "C.UTF-8",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_COUNT": "4",
    "GIT_CONFIG_KEY_0": "core.hooksPath",
    "GIT_CONFIG_VALUE_0": "/dev/null",
    "GIT_CONFIG_KEY_1": "core.fsmonitor",
    "GIT_CONFIG_VALUE_1": "false",
    "GIT_CONFIG_KEY_2": "core.untrackedCache",
    "GIT_CONFIG_VALUE_2": "false",
    "GIT_CONFIG_KEY_3": "commit.gpgSign",
    "GIT_CONFIG_VALUE_3": "false",
    "GIT_NO_REPLACE_OBJECTS": "1",
    "GIT_AUTHOR_NAME": "Rorca",
    "GIT_AUTHOR_EMAIL": "rorca@localhost",
    "GIT_COMMITTER_NAME": "Rorca",
    "GIT_COMMITTER_EMAIL": "rorca@localhost",
}
environment.update(request.get("environment", {}))
result = subprocess.run(
    [git, *request["args"]],
    input=base64.b64decode(request.get("input", "")),
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=environment,
    check=False,
)
os.close(root_fd)
sys.stdout.buffer.write(result.stdout)
sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
`;

const SAFE_WORKSPACE_SCAN_SCRIPT = String.raw`
import json, os, stat, sys

request = json.load(sys.stdin)
root_fd = os.open(request["root"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
root_stat = os.fstat(root_fd)
if root_stat.st_dev != request["device"] or root_stat.st_ino != request["inode"]:
    raise RuntimeError("workspace root identity changed")
lines = []
excluded = {".git", "node_modules", "dist", "build", "__pycache__"}

def scan(directory_fd, prefix, depth):
    if depth > request["maxDepth"]:
        return
    names = sorted(name for name in os.listdir(directory_fd) if name not in excluded and not name.startswith("."))[:request["maxEntries"]]
    for name in names:
        entry_stat = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if stat.S_ISDIR(entry_stat.st_mode):
            lines.append(prefix + name + "/")
            child_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try:
                scan(child_fd, prefix + "  ", depth + 1)
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(entry_stat.st_mode):
            lines.append(prefix + name)

scan(root_fd, "", 0)
os.close(root_fd)
print(json.dumps({"lines": lines}))
`;


const SAFE_WORKSPACE_READ_SCRIPT = String.raw`
import base64, json, os, stat, sys

request = json.load(sys.stdin)
root_fd = os.open(request["root"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
root_stat = os.fstat(root_fd)
if root_stat.st_dev != request["device"] or root_stat.st_ino != request["inode"]:
    raise RuntimeError("workspace root identity changed")
current = os.dup(root_fd)
try:
    parts = request["path"].split("/")
    for index, component in enumerate(parts):
        final = index == len(parts) - 1
        if not final:
            try:
                next_fd = os.open(
                    component,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=current,
                )
            except FileNotFoundError:
                if request["operation"] == "resolve" and not request["mustExist"]:
                    print(json.dumps({"resolved": True}))
                    sys.exit(0)
                raise
            os.close(current)
            current = next_fd
            continue

        flags = os.O_RDONLY | os.O_NOFOLLOW
        if request.get("expect") == "directory":
            flags |= os.O_DIRECTORY
        try:
            target_fd = os.open(component, flags, dir_fd=current)
        except FileNotFoundError:
            if request["operation"] == "resolve" and not request["mustExist"]:
                print(json.dumps({"resolved": True}))
                sys.exit(0)
            raise
        try:
            target_stat = os.fstat(target_fd)
            if ("expectedDevice" in request
                and (target_stat.st_dev != request["expectedDevice"]
                     or target_stat.st_ino != request["expectedInode"])):
                raise RuntimeError("snapshot entry identity changed")
            if request.get("expect") == "file" and not stat.S_ISREG(target_stat.st_mode):
                raise RuntimeError("target is not a regular file")
            if request.get("expect") == "directory" and not stat.S_ISDIR(target_stat.st_mode):
                raise RuntimeError("target is not a directory")
            if request["operation"] == "read":
                if not stat.S_ISREG(target_stat.st_mode):
                    raise RuntimeError("target is not a regular file")
                chunks = []
                total = 0
                while True:
                    chunk = os.read(target_fd, 65536)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > request["maxBytes"]:
                        raise RuntimeError("workspace file exceeds read limit")
                    chunks.append(chunk)
                print(json.dumps({
                    "content": base64.b64encode(b"".join(chunks)).decode("ascii"),
                    "size": target_stat.st_size,
                    "mtimeMs": target_stat.st_mtime_ns / 1000000,
                }))
            elif request["operation"] == "stat":
                if not stat.S_ISREG(target_stat.st_mode):
                    raise RuntimeError("target is not a regular file")
                print(json.dumps({
                    "size": target_stat.st_size,
                    "mtimeMs": target_stat.st_mtime_ns / 1000000,
                }))
            elif request["operation"] == "list":
                if not stat.S_ISDIR(target_stat.st_mode):
                    raise RuntimeError("target is not a directory")
                entries = []
                for name in sorted(os.listdir(target_fd)):
                    entry_stat = os.stat(name, dir_fd=target_fd, follow_symlinks=False)
                    kind = "directory" if stat.S_ISDIR(entry_stat.st_mode) else (
                        "file" if stat.S_ISREG(entry_stat.st_mode) else "other"
                    )
                    entries.append({"name": name, "kind": kind})
                print(json.dumps({"entries": entries}))
            elif request["operation"] == "resolve":
                print(json.dumps({"resolved": True}))
            else:
                raise RuntimeError("operation is not allowlisted")
        finally:
            os.close(target_fd)
finally:
    os.close(current)
    os.close(root_fd)
`;

const SAFE_WORKSPACE_SNAPSHOT_SCRIPT = String.raw`
import json, os, secrets, signal, stat, sys

request = json.load(sys.stdin)
source_fd = os.open(request["root"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
source_stat = os.fstat(source_fd)
if source_stat.st_dev != request["device"] or source_stat.st_ino != request["inode"]:
    raise RuntimeError("workspace root identity changed")
destination_fd = os.open(request["destination"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
destination_stat = os.fstat(destination_fd)
if (destination_stat.st_dev != request["destinationDevice"]
    or destination_stat.st_ino != request["destinationInode"]):
    raise RuntimeError("snapshot destination identity changed")
excluded = {
    ".git", "node_modules", "dist", "build", "__pycache__",
    ".pi-supervisor",
}
manifest = [request["controlEntry"]]
control_fd = 3
termination_signal = signal.SIGTERM
signal.signal(termination_signal, lambda _signum, _frame: (_ for _ in ()).throw(
    RuntimeError("workspace snapshot timed out")
))
state = {"entries": 0, "files": 0, "bytes": 0}


def record(entry):
    manifest.append(entry)
    payload = (json.dumps(entry, separators=(",", ":")) + "\n").encode()
    offset = 0
    while offset < len(payload):
        offset += os.write(control_fd, payload[offset:])
def copy_tree(current_source, current_destination, depth, prefix):
    if depth > request["maxDepth"]:
        return
    for name in sorted(os.listdir(current_source)):
        if name in excluded:
            continue
        state["entries"] += 1
        if state["entries"] > request["maxEntries"]:
            raise RuntimeError("workspace snapshot exceeds entry limit")
        relative = prefix + name
        entry_stat = os.stat(name, dir_fd=current_source, follow_symlinks=False)
        if stat.S_ISDIR(entry_stat.st_mode):
            child_source = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current_source)
            opened_stat = os.fstat(child_source)
            if opened_stat.st_dev != entry_stat.st_dev or opened_stat.st_ino != entry_stat.st_ino:
                os.close(child_source)
                raise RuntimeError("workspace directory changed during snapshot")
            previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {termination_signal})
            try:
                os.mkdir(name, opened_stat.st_mode & 0o777, dir_fd=current_destination)
                destination_stat = os.stat(name, dir_fd=current_destination, follow_symlinks=False)
                record({
                    "path": relative,
                    "device": destination_stat.st_dev,
                    "inode": destination_stat.st_ino,
                    "kind": "directory",
                })
                child_destination = os.open(
                    name,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=current_destination,
                )
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
            opened_destination = os.fstat(child_destination)
            if (opened_destination.st_dev != destination_stat.st_dev
                or opened_destination.st_ino != destination_stat.st_ino):
                os.close(child_destination)
                raise RuntimeError("snapshot destination directory changed")
            try:
                copy_tree(child_source, child_destination, depth + 1, relative + "/")
            finally:
                os.close(child_source)
                os.close(child_destination)
        elif stat.S_ISREG(entry_stat.st_mode):
            source_file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=current_source)
            opened_stat = os.fstat(source_file)
            if (not stat.S_ISREG(opened_stat.st_mode)
                or opened_stat.st_dev != entry_stat.st_dev
                or opened_stat.st_ino != entry_stat.st_ino):
                os.close(source_file)
                raise RuntimeError("workspace file changed during snapshot")
            state["files"] += 1
            if state["files"] > request["maxFiles"]:
                os.close(source_file)
                raise RuntimeError("workspace snapshot exceeds file limit")
            previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {termination_signal})
            try:
                destination_file = os.open(
                    name,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    opened_stat.st_mode & 0o777,
                    dir_fd=current_destination,
                )
                destination_stat = os.fstat(destination_file)
                record({
                    "path": relative,
                    "device": destination_stat.st_dev,
                    "inode": destination_stat.st_ino,
                    "kind": "file",
                })
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
            if opened_stat.st_size > request["maxFileBytes"]:
                os.close(source_file)
                os.close(destination_file)
                continue
            file_bytes = 0
            try:
                while True:
                    chunk = os.read(source_file, 65536)
                    if not chunk:
                        break
                    file_bytes += len(chunk)
                    state["bytes"] += len(chunk)
                    if (file_bytes > request["maxFileBytes"]
                        or state["bytes"] > request["maxTotalBytes"]):
                        raise RuntimeError("workspace snapshot exceeds byte limit")
                    offset = 0
                    while offset < len(chunk):
                        offset += os.write(destination_file, chunk[offset:])
            finally:
                os.close(source_file)
                os.close(destination_file)


def open_destination_parent(relative):
    parts = relative.split("/")
    current = os.dup(destination_fd)
    try:
        for component in parts[:-1]:
            next_fd = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=current,
            )
            os.close(current)
            current = next_fd
        return current, parts[-1]
    except:
        os.close(current)
        raise

def cleanup_created_entries():
    entries = sorted(
        manifest,
        key=lambda entry: (entry["path"].count("/"), entry["kind"] == "directory"),
        reverse=True,
    )
    for entry in entries:
        entry_parent, entry_name = open_destination_parent(entry["path"])
        quarantine = ".rorca-failed-" + secrets.token_hex(16)
        try:
            try:
                current_stat = os.stat(entry_name, dir_fd=entry_parent, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if current_stat.st_dev != entry["device"] or current_stat.st_ino != entry["inode"]:
                raise RuntimeError("failed snapshot entry identity changed")
            os.rename(entry_name, quarantine, src_dir_fd=entry_parent, dst_dir_fd=entry_parent)
            moved = os.stat(quarantine, dir_fd=entry_parent, follow_symlinks=False)
            if moved.st_dev != entry["device"] or moved.st_ino != entry["inode"]:
                raise RuntimeError("failed snapshot entry changed during cleanup")
            if entry["kind"] == "directory":
                os.rmdir(quarantine, dir_fd=entry_parent)
            else:
                os.unlink(quarantine, dir_fd=entry_parent)
        finally:
            os.close(entry_parent)

def remove_empty_destination_root():
    parent, name = os.path.split(request["destination"])
    parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    quarantine = ".rorca-failed-root-" + secrets.token_hex(16)
    try:
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (current.st_dev != request["destinationDevice"]
            or current.st_ino != request["destinationInode"]):
            raise RuntimeError("failed snapshot root identity changed")
        os.rename(name, quarantine, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        moved = os.stat(quarantine, dir_fd=parent_fd, follow_symlinks=False)
        if (moved.st_dev != request["destinationDevice"]
            or moved.st_ino != request["destinationInode"]):
            raise RuntimeError("failed snapshot root changed during cleanup")
        os.rmdir(quarantine, dir_fd=parent_fd)
    finally:
        os.close(parent_fd)

failure = None
try:
    copy_tree(source_fd, destination_fd, 0, "")
except BaseException as error:
    failure = error
    cleanup_created_entries()
finally:
    os.close(source_fd)
    os.close(destination_fd)

if failure is not None:
    remove_empty_destination_root()
    raise failure
print(json.dumps({"manifest": manifest[1:]}))
`;
const SAFE_TEMP_CLEANUP_SCRIPT = String.raw`
import json, os, secrets, sys

request = json.load(sys.stdin)
parent, name = os.path.split(request["path"])
parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
root_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
root_stat = os.fstat(root_fd)
if root_stat.st_dev != request["device"] or root_stat.st_ino != request["inode"]:
    raise RuntimeError("temporary directory identity changed")
quarantine = ".rorca-cleanup-" + secrets.token_hex(16)
os.rename(name, quarantine, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
moved_stat = os.stat(quarantine, dir_fd=parent_fd, follow_symlinks=False)
if moved_stat.st_dev != root_stat.st_dev or moved_stat.st_ino != root_stat.st_ino:
    raise RuntimeError("temporary directory changed during cleanup")

def open_parent(relative):
    parts = relative.split("/")
    current = os.dup(root_fd)
    try:
        for component in parts[:-1]:
            next_fd = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=current,
            )
            os.close(current)
            current = next_fd
        return current, parts[-1]
    except:
        os.close(current)
        raise

entries = sorted(
    request["manifest"],
    key=lambda entry: (entry["path"].count("/"), entry["kind"] == "directory"),
    reverse=True,
)
for entry in entries:
    entry_parent, entry_name = open_parent(entry["path"])
    child_quarantine = ".rorca-child-" + secrets.token_hex(16)
    try:
        try:
            current_stat = os.stat(entry_name, dir_fd=entry_parent, follow_symlinks=False)
        except FileNotFoundError:
            continue
        if current_stat.st_dev != entry["device"] or current_stat.st_ino != entry["inode"]:
            raise RuntimeError("temporary entry identity changed")
        os.rename(
            entry_name,
            child_quarantine,
            src_dir_fd=entry_parent,
            dst_dir_fd=entry_parent,
        )
        moved = os.stat(child_quarantine, dir_fd=entry_parent, follow_symlinks=False)
        if moved.st_dev != entry["device"] or moved.st_ino != entry["inode"]:
            raise RuntimeError("temporary entry changed during cleanup")
        if entry["kind"] == "directory":
            os.rmdir(child_quarantine, dir_fd=entry_parent)
        else:
            os.unlink(child_quarantine, dir_fd=entry_parent)
    finally:
        os.close(entry_parent)

os.close(root_fd)
os.rmdir(quarantine, dir_fd=parent_fd)
os.close(parent_fd)
`;
function unsafeWorkspacePath(message: string): never {
  throw new UnsafeWorkspacePathError(message);
}

export function supportsSecureWorkspacePlatform(platform: NodeJS.Platform): boolean {
  return platform === 'linux' || platform === 'darwin';
}

export interface WorkspaceFilesystemCapability {
  supported: boolean;
  pythonPath: string | null;
  reason: string | null;
}

export function getWorkspaceFilesystemCapability(): WorkspaceFilesystemCapability {
  if (!supportsSecureWorkspacePlatform(process.platform)) {
    return {
      supported: false,
      pythonPath: null,
      reason: 'Secure workspace filesystem operations require POSIX dirfd semantics',
    };
  }
  const configured = process.env.RORCA_PYTHON_BIN;
  const candidates = [
    ...(configured ? [configured] : []),
    '/usr/bin/python3',
    '/usr/local/bin/python3',
  ];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const canonical = fs.realpathSync(candidate);
      fs.accessSync(canonical, fs.constants.X_OK);
      if (fs.statSync(canonical).isFile()) {
        return { supported: true, pythonPath: canonical, reason: null };
      }
    } catch {
      // Try the next fixed operator-configured or platform path.
    }
  }
  return {
    supported: false,
    pythonPath: null,
    reason: 'Python 3 is required for secure descriptor-relative workspace operations',
  };
}

function requireWorkspacePython(): string {
  const capability = getWorkspaceFilesystemCapability();
  if (!capability.supported || !capability.pythonPath) {
    return unsafeWorkspacePath(capability.reason ?? 'Workspace filesystem capability is unavailable');
  }
  return capability.pythonPath;
}

/**
 * Normalizes a request-provided workspace path without ever accepting a root,
 * absolute path, Windows drive path, NUL, or traversal component.
 */
export function validateRelativeWorkspacePath(relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return unsafeWorkspacePath('Workspace file path must be a non-empty string');
  }
  if (relativePath.includes('\0')) {
    return unsafeWorkspacePath('Workspace file path contains a NUL byte');
  }
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    return unsafeWorkspacePath('Workspace file path must be relative');
  }
  // Treat backslashes as separators even on POSIX so a path accepted on one
  // deployment cannot become traversal after moving the workspace to another.
  if (relativePath.includes('\\')) {
    return unsafeWorkspacePath('Workspace file path must use forward slashes');
  }

  const components = relativePath.split('/');
  if (components.some(component => component === '..')) {
    return unsafeWorkspacePath('Workspace file path must not contain traversal');
  }

  const normalized = path.posix.normalize(relativePath);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return unsafeWorkspacePath('Workspace file path must name a file');
  }
  return normalized;
}


/** Capture the canonical directory identity once for an entire request. */
export function captureWorkspaceBoundary(workspacePath: string): WorkspaceBoundary {
  let rootPath: string;
  try {
    rootPath = fs.realpathSync(workspacePath);
    const linkStat = fs.lstatSync(rootPath);
    const stat = fs.statSync(rootPath);
    if (linkStat.isSymbolicLink() || !stat.isDirectory()) {
      return unsafeWorkspacePath('Workspace path is not a real directory');
    }
    return { rootPath, device: stat.dev, inode: stat.ino };
  } catch {
    return unsafeWorkspacePath('Workspace path does not exist');
  }
}

function verifiedWorkspaceBoundary(workspace: WorkspaceLocation): WorkspaceBoundary {
  const boundary = typeof workspace === 'string'
    ? captureWorkspaceBoundary(workspace)
    : workspace;
  try {
    const linkStat = fs.lstatSync(boundary.rootPath);
    const stat = fs.statSync(boundary.rootPath);
    if (linkStat.isSymbolicLink()
      || !stat.isDirectory()
      || stat.dev !== boundary.device
      || stat.ino !== boundary.inode) {
      return unsafeWorkspacePath('Workspace root changed during access');
    }
  } catch {
    return unsafeWorkspacePath('Workspace root changed during access');
  }
  return boundary;
}

/** Resolve the canonical root for callers that only need a stable display path. */
export function realpathWorkspaceRoot(workspacePath: string): string {
  return captureWorkspaceBoundary(workspacePath).rootPath;
}

export function execWorkspaceGit(
  workspace: WorkspaceLocation,
  args: string[],
  options: { input?: string | Buffer; environment?: Record<string, string> } = {},
): string {
  const boundary = verifiedWorkspaceBoundary(workspace);
  const subcommand = args[0];
  if (!subcommand || ![
    'show', 'hash-object', 'read-tree', 'update-index',
    'write-tree', 'commit-tree', 'update-ref', 'rev-parse',
  ].includes(subcommand)) {
    return unsafeWorkspacePath('Git operation is not allowlisted');
  }
  const python = requireWorkspacePython();
  const safeArgs = args;
  return execFileSync(python, ['-c', SAFE_WORKSPACE_GIT_SCRIPT], {
    encoding: 'utf8',
    input: JSON.stringify({
      root: boundary.rootPath,
      device: boundary.device,
      inode: boundary.inode,
      args: safeArgs,
      input: Buffer.from(options.input ?? '').toString('base64'),
      environment: options.environment?.GIT_INDEX_FILE
        ? { GIT_INDEX_FILE: options.environment.GIT_INDEX_FILE }
        : {},
    }),
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  });
}


export function safeScanWorkspaceTree(
  workspace: WorkspaceLocation,
  options: { maxDepth?: number; maxEntries?: number } = {},
): string {
  const boundary = verifiedWorkspaceBoundary(workspace);
  const python = requireWorkspacePython();
  try {
    const output = execFileSync(python, ['-c', SAFE_WORKSPACE_SCAN_SCRIPT], {
      encoding: 'utf8',
      input: JSON.stringify({
        root: boundary.rootPath,
        device: boundary.device,
        inode: boundary.inode,
        maxDepth: options.maxDepth ?? 2,
        maxEntries: options.maxEntries ?? 30,
      }),
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    const parsed = JSON.parse(output) as { lines: string[] };
    return parsed.lines.join('\n');
  } catch {
    return unsafeWorkspacePath('Descriptor-relative workspace scan failed');
  }
}
export interface SafeTemporaryManifestEntry {
  path: string;
  device: number;
  inode: number;
  kind: 'file' | 'directory';
}

export interface SafeWorkspaceSnapshot {
  path: string;
  cleanup: () => void;
}

export interface SafeWorkspaceSnapshotOptions {
  maxFiles?: number;
  maxEntries?: number;
  maxDepth?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
}

export function cleanupIdentityBoundTemporaryDirectory(
  temporaryPath: string,
  device: number,
  inode: number,
  manifest: SafeTemporaryManifestEntry[],
): void {
  const python = requireWorkspacePython();
  try {
    execFileSync(python, ['-c', SAFE_TEMP_CLEANUP_SCRIPT], {
      input: JSON.stringify({ path: temporaryPath, device, inode, manifest }),
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch {
    return unsafeWorkspacePath('Identity-bound temporary directory cleanup failed');
  }
}

/**
 * Materialize a bounded, symlink-free descriptor-relative copy for legacy
 * analyzers that require a pathname tree.
 */
export function createSafeWorkspaceSnapshot(
  workspace: WorkspaceLocation,
  options: SafeWorkspaceSnapshotOptions = {},
): SafeWorkspaceSnapshot {
  const boundary = verifiedWorkspaceBoundary(workspace);
  const python = requireWorkspacePython();
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-workspace-snapshot-'));
  const destinationStat = fs.statSync(destination);
  const snapshotBoundary: WorkspaceBoundary = {
    rootPath: destination,
    device: destinationStat.dev,
    inode: destinationStat.ino,
  };
  const controlName = `.rorca-snapshot-control-${randomUUID()}`;
  const controlFd = fs.openSync(
    path.join(destination, controlName),
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
    0o600,
  );
  const controlStat = fs.fstatSync(controlFd);
  const controlEntry: SafeTemporaryManifestEntry = {
    path: controlName,
    device: controlStat.dev,
    inode: controlStat.ino,
    kind: 'file',
  };

  try {
    const output = execFileSync(python, ['-c', SAFE_WORKSPACE_SNAPSHOT_SCRIPT], {
      encoding: 'utf8',
      input: JSON.stringify({
        root: boundary.rootPath,
        device: boundary.device,
        inode: boundary.inode,
        destination,
        destinationDevice: destinationStat.dev,
        destinationInode: destinationStat.ino,
        controlEntry,
        maxFiles: options.maxFiles ?? 10_000,
        maxEntries: options.maxEntries ?? 50_000,
        maxDepth: options.maxDepth ?? 16,
        // Workspaces routinely track QA evidence and media beyond the old
        // 64 MiB budget; the entry caps remain the hostile-tree bound.
        maxFileBytes: options.maxFileBytes ?? 8 * 1024 * 1024,
        maxTotalBytes: options.maxTotalBytes ?? 1024 * 1024 * 1024,
      }),
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe', controlFd],
      timeout: options.timeoutMs ?? 30_000,
      killSignal: 'SIGTERM',
    });
    const parsed = JSON.parse(output) as { manifest: SafeTemporaryManifestEntry[] };
    safeUnlinkWorkspaceFile(snapshotBoundary, controlName);
    fs.closeSync(controlFd);
    registerWorkspaceSnapshot(snapshotBoundary, parsed.manifest);
    return {
      path: destination,
      cleanup: () => {
        unregisterWorkspaceSnapshot(snapshotBoundary);
        cleanupIdentityBoundTemporaryDirectory(
          destination,
          destinationStat.dev,
          destinationStat.ino,
          parsed.manifest,
        );
      },
    };
  } catch {
    const journalStat = fs.fstatSync(controlFd);
    const journalBuffer = Buffer.alloc(journalStat.size);
    fs.readSync(controlFd, journalBuffer, 0, journalBuffer.length, 0);
    fs.closeSync(controlFd);
    const journal = journalBuffer.toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as SafeTemporaryManifestEntry);
    try {
      cleanupIdentityBoundTemporaryDirectory(
        destination,
        destinationStat.dev,
        destinationStat.ino,
        [controlEntry, ...journal],
      );
    } catch {
      // The child either completed identity-bound failure cleanup already or
      // detected a replacement. Never fall back to pathname recursion.
    }
    return unsafeWorkspacePath('Descriptor-relative workspace snapshot failed');
  }
}

interface DescriptorReadResult {
  content?: string;
  size?: number;
  mtimeMs?: number;
  entries?: Array<{ name: string; kind: 'file' | 'directory' | 'other' }>;
}

interface DescriptorIdentity {
  device: number;
  inode: number;
}

function runWorkspaceDescriptorRead(
  workspace: WorkspaceLocation,
  relativePath: string,
  operation: 'resolve' | 'stat' | 'read' | 'list',
  options: {
    mustExist?: boolean;
    expect?: 'file' | 'directory';
    identity?: DescriptorIdentity;
  } = {},
): { boundary: WorkspaceBoundary; normalized: string; result: DescriptorReadResult } {
  const boundary = verifiedWorkspaceBoundary(workspace);
  const normalized = operation === 'list' && relativePath === ''
    ? '.'
    : validateRelativeWorkspacePath(relativePath);
  const python = requireWorkspacePython();
  try {
    const output = execFileSync(python, ['-c', SAFE_WORKSPACE_READ_SCRIPT], {
      encoding: 'utf8',
      input: JSON.stringify({
        operation,
        root: boundary.rootPath,
        device: boundary.device,
        inode: boundary.inode,
        path: normalized,
        mustExist: options.mustExist === true,
        expect: options.expect,
        expectedDevice: options.identity?.device,
        expectedInode: options.identity?.inode,
        maxBytes: 16 * 1024 * 1024,
      }),
      maxBuffer: 24 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return {
      boundary,
      normalized,
      result: JSON.parse(output) as DescriptorReadResult,
    };
  } catch (error) {
    const stderr = String((error as { stderr?: string | Buffer }).stderr ?? '');
    if (stderr.includes('FileNotFoundError')) {
      return unsafeWorkspacePath('Workspace file path does not exist');
    }
    return unsafeWorkspacePath('Descriptor-relative workspace read failed');
  }
}

/**
 * Validate an existing or prospective relative path through pinned dirfds.
 * The returned pathname is for display/watcher bookkeeping only; all I/O must
 * use the descriptor-backed helpers in this module.
 */
export function resolveSafeWorkspacePath(
  workspacePath: WorkspaceLocation,
  relativePath: string,
  options: {
    mustExist?: boolean;
    expect?: 'file' | 'directory';
    identity?: DescriptorIdentity;
  } = {},
): string {
  const { boundary, normalized } = runWorkspaceDescriptorRead(
    workspacePath,
    relativePath,
    'resolve',
    options,
  );
  return path.join(boundary.rootPath, ...normalized.split('/'));
}

/** Stat a regular file through pinned descriptor-relative traversal. */
export function safeStatWorkspaceFile(
  workspacePath: WorkspaceLocation,
  relativePath: string,
  identity?: DescriptorIdentity,
): SafeWorkspaceFile {
  const { boundary, normalized, result } = runWorkspaceDescriptorRead(
    workspacePath,
    relativePath,
    'stat',
    { mustExist: true, expect: 'file', identity },
  );
  if (result.size === undefined || result.mtimeMs === undefined) {
    return unsafeWorkspacePath('Descriptor-relative workspace stat returned invalid data');
  }
  return {
    absolutePath: path.join(boundary.rootPath, ...normalized.split('/')),
    stat: { size: result.size, mtime: new Date(result.mtimeMs) },
  };
}

/** Read a regular UTF-8 file through pinned descriptor-relative traversal. */
export function safeReadWorkspaceTextFile(
  workspacePath: WorkspaceLocation,
  relativePath: string,
  identity?: DescriptorIdentity,
): SafeWorkspaceTextFile {
  const { boundary, normalized, result } = runWorkspaceDescriptorRead(
    workspacePath,
    relativePath,
    'read',
    { mustExist: true, expect: 'file', identity },
  );
  if (result.content === undefined
    || result.size === undefined
    || result.mtimeMs === undefined) {
    return unsafeWorkspacePath('Descriptor-relative workspace read returned invalid data');
  }
  return {
    absolutePath: path.join(boundary.rootPath, ...normalized.split('/')),
    content: Buffer.from(result.content, 'base64').toString('utf8'),
    stat: { size: result.size, mtime: new Date(result.mtimeMs) },
  };
}

export function safeListWorkspaceDirectory(
  workspacePath: WorkspaceLocation,
  relativePath = '',
  identity?: DescriptorIdentity,
): Array<{ name: string; kind: 'file' | 'directory' | 'other' }> {
  const { result } = runWorkspaceDescriptorRead(
    workspacePath,
    relativePath,
    'list',
    { mustExist: true, expect: 'directory', identity },
  );
  if (!result.entries) {
    return unsafeWorkspacePath('Descriptor-relative workspace list returned invalid data');
  }
  return result.entries;
}

export interface SafeWorkspaceMutation {
  relativePath: string;
  content: string | Buffer;
  exclusive?: boolean;
}

interface WorkspaceMutationResult {
  path: string;
  size: number;
  mtimeMs: number;
}

function runWorkspaceMutation(
  workspace: WorkspaceLocation,
  operation: 'write' | 'delete',
  files: SafeWorkspaceMutation[],
  deletePath?: string,
): WorkspaceMutationResult[] {
  const boundary = verifiedWorkspaceBoundary(workspace);
  const normalizedFiles = files.map(file => ({
    path: validateRelativeWorkspacePath(file.relativePath),
    content: Buffer.from(file.content).toString('base64'),
    exclusive: file.exclusive === true,
  }));
  const normalizedDeletePath = deletePath === undefined
    ? undefined
    : validateRelativeWorkspacePath(deletePath);
  const python = requireWorkspacePython();

  try {
    const output = execFileSync(python, ['-c', SAFE_WORKSPACE_MUTATION_SCRIPT], {
      encoding: 'utf8',
      input: JSON.stringify({
        operation,
        root: boundary.rootPath,
        device: boundary.device,
        inode: boundary.inode,
        files: normalizedFiles,
        path: normalizedDeletePath,
      }),
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    const parsed = JSON.parse(output) as { files?: WorkspaceMutationResult[] };
    return parsed.files ?? [];
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr;
    try {
      const parsed = JSON.parse(String(stderr ?? '').trim()) as { error?: string; message?: string };
      if (parsed.error === 'EXISTS') {
        throw new WorkspaceFileExistsError(parsed.message ?? 'Workspace file already exists');
      }
      if (parsed.message) return unsafeWorkspacePath(parsed.message);
    } catch (parseError) {
      if (parseError instanceof WorkspaceFileExistsError
        || parseError instanceof UnsafeWorkspacePathError) {
        throw parseError;
      }
    }
    return unsafeWorkspacePath('Descriptor-relative workspace mutation failed');
  }
}

/** Atomically apply a batch or restore verified old bytes on any failure. */
export function safeWriteWorkspaceFilesAtomic(
  workspace: WorkspaceLocation,
  files: SafeWorkspaceMutation[],
): SafeWorkspaceFile[] {
  const boundary = verifiedWorkspaceBoundary(workspace);
  const results = runWorkspaceMutation(boundary, 'write', files);
  return results.map(result => ({
    absolutePath: path.join(boundary.rootPath, ...result.path.split('/')),
    stat: { size: result.size, mtime: new Date(result.mtimeMs) },
  }));
}

/** Create or replace one file through pinned descriptor-relative traversal. */
export function safeWriteWorkspaceFile(
  workspacePath: WorkspaceLocation,
  relativePath: string,
  content: string | Buffer,
  options: { exclusive?: boolean } = {},
): SafeWorkspaceFile {
  const [written] = safeWriteWorkspaceFilesAtomic(workspacePath, [{
    relativePath,
    content,
    exclusive: options.exclusive,
  }]);
  if (!written) return unsafeWorkspacePath('Workspace write returned no file');
  return written;
}

/** Delete a regular file through a pinned parent descriptor. */
export function safeUnlinkWorkspaceFile(
  workspacePath: WorkspaceLocation,
  relativePath: string,
): void {
  runWorkspaceMutation(workspacePath, 'delete', [], relativePath);
}

export const JWT_SECRET = process.env.JWT_SECRET || 'rorca-dev-secret-change-in-production';
const ENCRYPTION_KEY = crypto.createHash('sha256').update(JWT_SECRET).digest();
const ENCRYPTION_ALGO = 'aes-256-gcm' as const;

export function encryptToken(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGO, ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptToken(encryptedStr: string): string {
  const [ivHex, authTagHex, ciphertextHex] = encryptedStr.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGO, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

export const INTERNAL_SERVICE_USER_ID = 'rorca-internal-service';
/** Scoped capability principal: operator-equivalent only at the exact dispatch boundary. */
export const HERMES_OPERATOR_DISPATCH_USER_ID = 'rorca-hermes-operator-dispatch';

function resolveInternalServiceToken(): string {
  const configured = String(process.env.RORCA_INTERNAL_SERVICE_TOKEN ?? '').trim();
  if (configured) {
    if (Buffer.byteLength(configured, 'utf8') < 32
      || /^rorca-internal-(?:\d+|change-me|default)$/i.test(configured)) {
      throw new Error('RORCA_INTERNAL_SERVICE_TOKEN must be an unpredictable secret of at least 32 bytes');
    }
    return configured;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('RORCA_INTERNAL_SERVICE_TOKEN is required in production');
  }
  // Non-production processes get an unpredictable process-local token. It is
  // intentionally not derivable from PID and cannot authenticate another process.
  return crypto.randomBytes(32).toString('base64url');
}

export const INTERNAL_SERVICE_TOKEN = resolveInternalServiceToken();
export const DISPATCH_RECEIVER_USER_ID = 'rorca-dispatch-receiver';

function dispatchReceiverConfigurationError(configured: string): string | null {
  if (!configured) return 'RORCA_DISPATCH_RECEIVER_TOKEN is required in production';
  if (Buffer.byteLength(configured, 'utf8') < 32 || configured === INTERNAL_SERVICE_TOKEN) {
    return 'RORCA_DISPATCH_RECEIVER_TOKEN must be an independent unpredictable secret of at least 32 bytes';
  }
  return null;
}

/** Validate receiver-only API configuration without retaining or exporting it. */
export function assertDispatchReceiverConfiguration(): void {
  const configured = String(process.env.RORCA_DISPATCH_RECEIVER_TOKEN ?? '').trim();
  const error = dispatchReceiverConfigurationError(configured);
  if (error) throw new Error(error);
}

function resolveDispatchReceiverTokenForAcceptance(): string | null {
  const configured = String(process.env.RORCA_DISPATCH_RECEIVER_TOKEN ?? '').trim();
  return dispatchReceiverConfigurationError(configured) === null ? configured : null;
}

function sameSecret(supplied: unknown, expectedValue: string | null): boolean {
  if (typeof supplied !== 'string' || !expectedValue) return false;
  const expected = Buffer.from(expectedValue, 'utf8');
  const actual = Buffer.from(supplied, 'utf8');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function sameInternalToken(supplied: unknown): boolean {
  return sameSecret(supplied, INTERNAL_SERVICE_TOKEN);
}

function sameDispatchReceiverToken(supplied: unknown): boolean {
  return sameSecret(supplied, resolveDispatchReceiverTokenForAcceptance());
}

function campaignServicePath(req: Request): boolean {
  const raw = String(req.originalUrl || req.url || '').split('?', 1)[0];
  if (!raw.startsWith('/api/') || /%|\\|\/\//.test(raw)) return false;
  if (req.method === 'GET') {
    return raw === '/api/recall'
      || raw === '/api/lifecycle/decisions/state'
      || raw === '/api/pipeline/runs'
      || /^\/api\/pipeline\/runs\/[1-9][0-9]*$/.test(raw)
      || /^\/api\/pipeline\/runs\/[1-9][0-9]*\/liveness$/.test(raw)
      || /^\/api\/workspaces\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}\/github\/app$/.test(raw);
  }
  if (req.method !== 'POST' || raw !== '/api/pipeline/trigger') return false;
  const body = req.body;
  return !!body && typeof body === 'object' && !Array.isArray(body)
    && Object.prototype.hasOwnProperty.call(body, 'dispatchAuthorization');
}

function campaignMcpTier(token: string | null): 'public' | 'admin' | null {
  if (!token) return null;
  if (sameSecret(token, getMcpAdminToken())) return 'admin';
  if (sameSecret(token, getMcpPublicToken())) return 'public';
  return null;
}

/** The internal Hermes service identity. Operator-configurable so the
 * authority checks can bind to the real Hermes account email instead of the
 * synthetic default. */
export function hermesServiceEmail(): string {
  return String(process.env.RORCA_HERMES_SERVICE_EMAIL ?? 'hermes@rorca.internal').trim().toLowerCase();
}

function campaignServiceUser(): AuthUser {
  return {
    id: 'rorca-hermes-service',
    email: hermesServiceEmail(),
    supabaseId: '00000000-0000-0000-0000-000000000002',
    role: 'admin',
  };
}

function dispatchReceiverAcceptancePath(req:Request):boolean{
  const raw=String(req.originalUrl||req.url||'').split('?',1)[0];
  return req.method==='POST'
    && raw==='/api/mission-control/v1/internal/dispatch-outbox/accept';
}

function dispatchReceiverUser():AuthUser{
  return {id:DISPATCH_RECEIVER_USER_ID,email:'dispatch-receiver@rorca.internal',
    supabaseId:'00000000-0000-0000-0000-000000000003',role:'dispatch_receiver'};
}

function internalServiceUser(req: Request): AuthUser {
  const service = String(req.headers['x-rorca-service'] ?? '').trim().toLowerCase();
  if (service && service !== 'hermes' && service !== 'scheduler') {
    throw new Error('Unsupported internal service identity');
  }
  const hermes = service === 'hermes';
  return {
    id: hermes ? 'rorca-hermes-service' : INTERNAL_SERVICE_USER_ID,
    email: hermes ? hermesServiceEmail() : 'scheduler@rorca.internal',
    supabaseId: hermes
      ? '00000000-0000-0000-0000-000000000002'
      : '00000000-0000-0000-0000-000000000000',
    role: 'admin',
  };
}

function getDeveloperSuperuserEmails(): Set<string> {
  const configured = (process.env.RORCA_SUPERUSER_EMAILS || process.env.DEV_SUPERUSER_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return new Set(['admin@rorca.local', ...configured]);
}

function isDeveloperSuperuserEmail(email: string): boolean {
  return getDeveloperSuperuserEmails().has(email.trim().toLowerCase());
}

async function getOrCreateAppUser(authId: string, email: string, emailVerifiedAt?: string | null): Promise<AppUserRow> {
  const { queryOne, execute } = await import('../db/index');

  let appUser = await queryOne<AppUserRow>(
    'SELECT id, email, role, plan FROM users WHERE auth_id = $1',
    [authId],
  );

  const existingDeveloperAdmin = await queryOne<{ id: string }>(
    "SELECT id FROM users WHERE role = 'admin' AND email <> 'admin@rorca.local' LIMIT 1"
  );
  const shouldBeAdmin = isDeveloperSuperuserEmail(email)
    || (process.env.NODE_ENV !== 'production' && !existingDeveloperAdmin);

  if (!appUser) {
    const newId = shouldBeAdmin ? `dev-admin-${authId}` : randomUUID();
    const displayName = email.split('@')[0] || 'User';
    const role = shouldBeAdmin ? 'admin' : 'user';
    const plan = shouldBeAdmin ? 'pro' : 'free';

    await execute(
      `INSERT INTO users (id, email, display_name, role, plan, email_verified_at, auth_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::uuid)`,
      [newId, email, displayName, role, plan, emailVerifiedAt ?? null, authId],
    );

    appUser = await queryOne<AppUserRow>(
      'SELECT id, email, role, plan FROM users WHERE id = $1',
      [newId],
    );
  } else if (shouldBeAdmin && appUser.role !== 'admin') {
    await execute(
      `UPDATE users
       SET role = 'admin', plan = CASE WHEN plan = 'free' THEN 'pro' ELSE plan END, updated_at = NOW()
       WHERE id = $1`,
      [appUser.id],
    );

    appUser = await queryOne<AppUserRow>(
      'SELECT id, email, role, plan FROM users WHERE id = $1',
      [appUser.id],
    );
  }

  if (!appUser) {
    throw new Error('Failed to resolve application user');
  }

  return appUser;
}

export function isSuperUser(user: { role?: string } | null | undefined): boolean {
  return user?.role === 'admin';
}

/**
 * The unauthenticated local topology has one explicit human principal. This
 * helper must stay narrower than a generic admin check: hosted/authenticated
 * users and internal services require their provider-bound approval authority.
 */
export function isLocalHumanApprovalPrincipal(
  user: { id?: string; email?: string; supabaseId?: string; role?: string } | null | undefined,
): boolean {
  return process.env.AUTH_REQUIRED !== 'true'
    && user?.id === LOCAL_ADMIN.id
    && user.email === LOCAL_ADMIN.email
    && user.supabaseId === LOCAL_ADMIN.supabaseId
    && user.role === LOCAL_ADMIN.role;
}

async function resolveAuthUserFromLocalJwt(token: string): Promise<AuthUser | null> {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
    const authId = typeof payload.sub === 'string' ? payload.sub : null;
    const email = typeof payload.email === 'string' ? payload.email : null;

    if (!authId || !email) {
      return null;
    }

    const appUser = await getOrCreateAppUser(authId, email, null);
    return {
      id: appUser.id,
      email,
      supabaseId: authId,
      role: appUser.role,
      plan: appUser.plan ?? undefined,
    };
  } catch {
    return null;
  }
}

export async function resolveAuthUserFromToken(token: string): Promise<AuthUser | null> {
  if (!token) {
    return null;
  }

  if (process.env.NODE_ENV === 'test') {
    return resolveAuthUserFromLocalJwt(token);
  }

  return null;
}

export async function authRequired(req: Request, res: Response, next: NextFunction): Promise<void> {
  const internalHeader = req.headers['x-rorca-internal'];
  const serviceHeader = req.headers['x-rorca-service'];
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if ((authHeader !== undefined && typeof authHeader !== 'string')
    || (bearerToken !== null && (bearerToken.length < 1 || bearerToken.length > 8192))) {
    res.status(401).json({ error: 'Unauthorized', code: 'AUTH_ERROR' });
    return;
  }
  const validInternalHeader = internalHeader !== undefined && sameInternalToken(internalHeader);
  const validInternalBearer = bearerToken !== null && sameInternalToken(bearerToken);
  const receiverLabel = String(serviceHeader ?? '').trim().toLowerCase() === 'dispatch-receiver';

  // Receiver-only authority is resolved and compared only for the one exact
  // acceptance route. Missing/invalid configuration and every contradictory
  // credential shape deny the request; generic imports and worker startup never
  // need or acquire this capability.
  if (dispatchReceiverAcceptancePath(req)) {
    const validReceiverBearer = bearerToken !== null && sameDispatchReceiverToken(bearerToken);
    if (!receiverLabel || !validReceiverBearer || internalHeader !== undefined || validInternalBearer) {
      res.status(401).json({ error: 'Unauthorized', code: 'AUTH_ERROR' });
      return;
    }
    // This capability principal is intentionally not an admin. The exact
    // receiver route checks its fixed ID again; every generic workspace,
    // platform, team, provider, and pipeline role gate rejects it.
    req.user = dispatchReceiverUser();
    next();
    return;
  }
  if (receiverLabel) {
    res.status(401).json({ error: 'Unauthorized', code: 'AUTH_ERROR' });
    return;
  }
  const claimsServiceIdentity = serviceHeader !== undefined || internalHeader !== undefined || validInternalBearer;

  // Internal service identity is resolved before the local-human fallback in every
  // supported topology. Every supplied service credential must be valid; a service
  // label without a credential or contradictory credentials fail closed.
  if (claimsServiceIdentity) {
    const invalidInternalHeader = internalHeader !== undefined && !validInternalHeader;
    const invalidBearer = bearerToken !== null && !validInternalBearer;
    const missingServiceCredential = serviceHeader !== undefined && !validInternalHeader && !validInternalBearer;
    if (invalidInternalHeader || invalidBearer || missingServiceCredential) {
      res.status(401).json({ error: 'Unauthorized', code: 'AUTH_ERROR' });
      return;
    }
    try {
      req.user = internalServiceUser(req);
      req.authSource = 'internal';
      if (req.user.id === 'rorca-hermes-service') {
        req.hermesAuthority = parseHermesAuthority(req);
        if (req.hermesAuthority.authorityMode === 'operator-dispatch') {
          req.user = { ...req.user, id: HERMES_OPERATOR_DISPATCH_USER_ID, role: 'operator_dispatch' };
        }
      }
      next();
    } catch (error) {
      if (String(serviceHeader ?? '').trim().toLowerCase() === 'hermes') {
        res.status(403).json({
          error: error instanceof Error ? error.message : 'Hermes authority declaration denied',
          code: 'HERMES_AUTHORITY_DENIED',
        });
        return;
      }
      res.status(401).json({ error: 'Unauthorized', code: 'AUTH_ERROR' });
    }
    return;
  }

  // Hermes uses the existing MCP bearer as a narrowly scoped service credential.
  // It is accepted only for the exact read projections required by the campaign
  // adapter and for a trigger that carries the strict campaign authorization.
  // It never becomes a general REST admin credential.
  const mcpTier = campaignServicePath(req) ? campaignMcpTier(bearerToken) : null;
  if (mcpTier) {
    try {
      req.hermesAuthority = parseHermesAuthority(req);
      req.user = req.hermesAuthority.authorityMode === 'operator-dispatch'
        ? { ...campaignServiceUser(), id: HERMES_OPERATOR_DISPATCH_USER_ID, role: 'operator_dispatch' }
        : campaignServiceUser();
      req.campaignServiceAuth = `mcp-${mcpTier}`;
      next();
    } catch (error) {
      res.status(403).json({
        error: error instanceof Error ? error.message : 'Hermes authority declaration denied',
        code: 'HERMES_AUTHORITY_DENIED',
      });
    }
    return;
  }

  if (process.env.AUTH_REQUIRED !== 'true' && !bearerToken) {
    if (!req.user) req.user = LOCAL_ADMIN;
    req.authSource = 'local-fallback';
    next();
    return;
  }

  if (!bearerToken) {
    res.status(401).json({ error: 'Authentication required', code: 'AUTH_ERROR' });
    return;
  }

  try {
    const resolvedUser = await resolveAuthUserFromToken(bearerToken);
    if (!resolvedUser) {
      res.status(401).json({ error: 'Unauthorized', code: 'AUTH_ERROR' });
      return;
    }

    req.user = resolvedUser;
    req.authSource = 'bearer';
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized', code: 'AUTH_ERROR' });
  }
}

export const requireAuth = authRequired;

export type TeamRole = 'admin' | 'editor' | 'viewer';
export type WorkspaceRole = 'owner' | 'admin' | 'member';

const ROLE_HIERARCHY: Record<TeamRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
};

const WORKSPACE_ROLE_HIERARCHY: Record<WorkspaceRole, number> = {
  member: 0,
  admin: 1,
  owner: 2,
};

function resolveWorkspaceId(req: Request): { workspaceId: string | null; conflicting: boolean } {
  const params = req.params as Record<string, string | undefined>;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const query = req.query as Record<string, string | undefined>;
  const bodyScope = body.scope && typeof body.scope === 'object' && !Array.isArray(body.scope)
    ? body.scope as Record<string, unknown>
    : null;

  const candidates = [
    params.workspaceId,
    params.id,
    typeof query.workspaceId === 'string' ? query.workspaceId : undefined,
    typeof body.workspaceId === 'string' ? body.workspaceId : undefined,
    typeof body.workspace_id === 'string' ? body.workspace_id : undefined,
    typeof bodyScope?.workspaceId === 'string' ? bodyScope.workspaceId : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const workspaceId = candidates[0] ? String(candidates[0]) : null;
  return {
    workspaceId,
    conflicting: workspaceId !== null && candidates.some((candidate) => String(candidate) !== workspaceId),
  };
}

export function requireWorkspaceRole(minRole: WorkspaceRole) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Authentication required', code: 'AUTH_ERROR' });
      return;
    }

    const workspaceScope = resolveWorkspaceId(req);
    if (workspaceScope.conflicting) {
      res.status(400).json({ error: 'Workspace IDs in the request must match' });
      return;
    }
    if (isSuperUser(user)) {
      next();
      return;
    }
    const { workspaceId } = workspaceScope;
    if (!workspaceId) {
      res.status(400).json({ error: 'Workspace ID is required' });
      return;
    }

    try {
      const { queryOne } = await import('../db/index');
      const membership = await queryOne<{ role: WorkspaceRole }>(
        'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_auth_id = $2',
        [workspaceId, user.supabaseId],
      );

      if (!membership) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      if (WORKSPACE_ROLE_HIERARCHY[membership.role] < WORKSPACE_ROLE_HIERARCHY[minRole]) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      next();
    } catch {
      res.status(500).json({ error: 'Failed to verify workspace permissions' });
    }
  };
}

export function requirePlatformAdmin() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required', code: 'AUTH_ERROR' });
      return;
    }
    if (!isSuperUser(req.user)) {
      res.status(403).json({ error: 'Platform administrator authority required' });
      return;
    }
    next();
  };
}

export const requireWorkspaceMember = () => requireWorkspaceRole('member');
export const requireWorkspaceAdmin = () => requireWorkspaceRole('admin');
export const requireWorkspaceOwner = () => requireWorkspaceRole('owner');

export function requireRole(minRole: TeamRole) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Authentication required', code: 'AUTH_ERROR' });
      return;
    }

    if (isSuperUser(user) || user.id === 'system') {
      next();
      return;
    }

    const teamId =
      req.params.teamId ||
      req.params.id ||
      (req.query.teamId as string) ||
      req.body?.teamId;

    if (!teamId) {
      res.status(400).json({ error: 'Team ID is required' });
      return;
    }

    try {
      const { queryOne } = await import('../db/index');
      const membership = await queryOne<{ role: TeamRole }>(
        'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2',
        [teamId, user.id],
      );

      if (!membership) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      if (ROLE_HIERARCHY[membership.role] < ROLE_HIERARCHY[minRole]) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      next();
    } catch {
      res.status(500).json({ error: 'Failed to verify team permissions' });
    }
  };
}
