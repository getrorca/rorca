/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Forgejo repository identity validation and instance-safe API URL builder. */

import { ValidationError } from './errors';
import { isGitSha } from './git-sha';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^(?!\/)(?!.*(?:\.\.|\/\/|@\{|\\|[~^:?*\[]))(?!.*\.$)[A-Za-z0-9._\/-]{1,255}$/;

export function assertForgejoRepositoryIdentity(owner: string, name: string): void {
  if (!OWNER.test(owner) || !REPO.test(name)) {
    throw new ValidationError('Invalid Forgejo repository owner or name');
  }
}

export function assertForgejoRef(ref: string): void {
  if (!BRANCH.test(ref)) throw new ValidationError('Invalid Forgejo branch or ref');
}

export const isFullForgejoObjectId = isGitSha;

/** Build a Forgejo API URL that can never escape the canonical repository path. */
export function forgejoRepoApiUrl(instanceUrl: string, owner: string, name: string, suffix = ''): string {
  assertForgejoRepositoryIdentity(owner, name);
  const base = instanceUrl.replace(/\/+$/, '');
  if (!/^https?:\/\/[A-Za-z0-9._:/-]+$/.test(base)) throw new ValidationError('Forgejo instance URL is invalid');
  if (suffix && !suffix.startsWith('/')) throw new ValidationError('Forgejo API suffix must begin with /');
  if (/[\\\u0000-\u001f\u007f#]/.test(suffix)) throw new ValidationError('Forgejo API suffix is invalid');
  const repositoryPath = `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const url = new URL(`${base}${repositoryPath}${suffix}`);
  if (url.origin !== new URL(base).origin
    || (url.pathname !== repositoryPath && !url.pathname.startsWith(`${repositoryPath}/`))) {
    throw new ValidationError('Forgejo API suffix escapes the canonical repository path');
  }
  return url.toString();
}
