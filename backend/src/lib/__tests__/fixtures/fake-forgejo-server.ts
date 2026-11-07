/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Hermetic gitea-compatible fake Forgejo server (W5-002..W5-006 tests).
 * Covers every endpoint the adapter calls:
 *   GET  /api/v1/user
 *   GET  /api/v1/repos/search
 *   GET  /api/v1/repos/{owner}/{repo}
 *   GET  /api/v1/repos/{owner}/{repo}/branches/{branch}
 *   GET  /api/v1/repos/{owner}/{repo}/pulls
 *   GET  /api/v1/repos/{owner}/{repo}/pulls/{number}
 *   POST /api/v1/repos/{owner}/{repo}/pulls
 *   PATCH /api/v1/repos/{owner}/{repo}/pulls/{number}
 *   GET  /api/v1/repos/{owner}/{repo}/statuses/{sha}
 *   POST /api/v1/repos/{owner}/{repo}/statuses/{sha}
 *   POST /api/v1/repos/{owner}/{repo}/check-runs        (optional Actions)
 */

import express, { type Express } from 'express';
import * as crypto from 'node:crypto';

export interface FakeForgejoOptions {
  instanceUrl: string;
  owner: string;
  name: string;
  token: string;
  /** Authenticated token principal; may differ from an organization repository owner. */
  userLogin?: string;
  /** Repository-scoped tokens cannot call user-profile or user-repo APIs. */
  repositoryScoped?: boolean;
  /** Optional malformed/mismatched repository identity responses for deny-path tests. */
  repositoryOwnerLogin?: string;
  repositoryFullName?: string;
  /** Set true to advertise Forgejo Actions (check-runs) capability. */
  hasActions?: boolean;
  /** Repository permission profile returned by GET /repos. */
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
  /** Head sha served for branch lookups and PR creation. */
  branchHead?: string;
  /** Repositories visible to the token through repository search. Defaults to
   * exactly the configured repository. Set to `null` to make authoritative
   * enumeration unavailable and therefore indeterminate. */
  accessibleRepos?: string[] | null;
  /** Repository ids keyed by `owner/name` for the exclusivity enumeration. */
  accessibleRepoIds?: Record<string, number>;
}

export interface FakeForgejoServer {
  app: Express;
  /** Registered tokens that pass the Authorization check. */
  validTokens: Set<string>;
  /** Recorded provider calls (method + pathname) for assertions. */
  calls: Array<{ method: string; path: string; body?: unknown }>;
  /** Recorded draft PRs created via POST /pulls. */
  pullRequests: Array<Record<string, unknown>>;
  /** Recorded commit statuses keyed by sha. */
  statuses: Map<string, Array<Record<string, unknown>>>;
  /** Fail the next N status POSTs with the given status code. */
  failNextStatusPosts: number;
  failStatusCode: number;
  /** Quarantine (PATCH state closed) counter. */
  quarantined: Array<{ number: number; state: string }>;
  reset(): void;
}

export function createFakeForgejoServer(options: FakeForgejoOptions): FakeForgejoServer {
  const app = express();
  app.use(express.json());
  const validTokens = new Set([options.token]);
  const calls: FakeForgejoServer['calls'] = [];
  const pullRequests: FakeForgejoServer['pullRequests'] = [];
  const statuses = new Map<string, Array<Record<string, unknown>>>();
  const quarantined: FakeForgejoServer['quarantined'] = [];
  let failNextStatusPosts = 0;
  let failStatusCode = 500;

  function authorize(req: express.Request): boolean {
    const header = String(req.headers.authorization ?? '');
    const match = header.match(/^(?:token|Bearer)\s+(.+)$/i);
    return Boolean(match && validTokens.has(match[1]!));
  }

  function record(req: express.Request, body?: unknown): void {
    calls.push({ method: req.method, path: req.path, body });
  }

  app.use('/api/v1', (req, res, next) => {
    record(req, req.body);
    if (!authorize(req)) {
      res.status(401).json({ message: 'invalid token' });
      return;
    }
    next();
  });

  function accessibleRepositories(): Array<Record<string, unknown>> {
    return (options.accessibleRepos ?? [`${options.owner}/${options.name}`])
      .map((fullName) => ({
        full_name: fullName,
        id: options.accessibleRepoIds?.[fullName] ?? 2001,
        permissions: fullName === `${options.owner}/${options.name}`
          ? {
            admin: options.permissions?.admin ?? false,
            push: options.permissions?.push ?? true,
            pull: options.permissions?.pull ?? true,
          }
          : { admin: false, push: true, pull: true },
      }));
  }

  // Legacy full-user tokens may enumerate `/user/repos`; Forgejo deliberately
  // forbids this endpoint for repository-scoped tokens.
  app.get('/api/v1/user/repos', (req, res) => {
    if (options.repositoryScoped === true) {
      res.status(403).json({ message: 'token scope does not permit user access' });
      return;
    }
    if (options.accessibleRepos === null) {
      res.status(404).json({ message: 'repository enumeration unavailable' });
      return;
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
    const start = (page - 1) * limit;
    res.json(accessibleRepositories().slice(start, start + limit));
  });

  // Repository search remains available to repository-scoped tokens and is
  // the authoritative enumeration of repositories on which they can act.
  app.get('/api/v1/repos/search', (req, res) => {
    if (options.accessibleRepos === null) {
      res.status(404).json({ message: 'repository search unavailable' });
      return;
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
    const start = (page - 1) * limit;
    res.json({ ok: true, data: accessibleRepositories().slice(start, start + limit) });
  });

  app.get('/api/v1/user', (_req, res) => {
    if (options.repositoryScoped === true) {
      res.status(403).json({ message: 'token scope does not permit user access' });
      return;
    }
    const login = options.userLogin ?? options.owner;
    res.json({ id: 1001, login, username: login, full_name: login });
  });

  app.get('/api/v1/repos/:owner/:repo', (req, res) => {
    if (req.params.owner !== options.owner || req.params.repo !== options.name) {
      res.status(404).json({ message: 'repository not found' });
      return;
    }
    res.json({
      id: 2001,
      full_name: options.repositoryFullName ?? `${options.owner}/${options.name}`,
      owner: { login: options.repositoryOwnerLogin ?? options.owner, id: 1001 },
      default_branch: 'main',
      has_actions: options.hasActions === true,
      permissions: {
        admin: options.permissions?.admin ?? false,
        push: options.permissions?.push ?? true,
        pull: options.permissions?.pull ?? true,
      },
    });
  });

  // Branch names may contain slashes (ssdlc/run-<id>-<sha>), so the
  // route must consume every remaining segment, not a single :branch param.
  app.get('/api/v1/repos/:owner/:repo/branches/*', (req, res) => {
    if (req.params.owner !== options.owner || req.params.repo !== options.name) {
      res.status(404).json({ message: 'repository not found' });
      return;
    }
    // Express 4 exposes the `*` capture only at params["0"] (untyped).
    const branch = String((req.params as Record<string, unknown>)['0'] ?? '');
    res.json({ name: branch, commit: { id: options.branchHead ?? 'a'.repeat(40) } });
  });
  app.get('/api/v1/repos/:owner/:repo/pulls', (req, res) => {
    const head = String(req.query.head ?? '');
    // Gitea accepts both `owner:ref` and bare `ref`; stored PRs carry their
    // ref inside the head object (as Gitea returns them).
    const ref = head.includes(':') ? head.split(':').slice(1).join(':') : head;
    const matched = pullRequests.filter((pr) => {
      const storedHead = pr.head && typeof pr.head === 'object'
        ? (pr.head as { ref?: unknown }).ref : pr.head;
      return storedHead === ref || storedHead === head;
    });
    res.json(matched);
  });
  app.post('/api/v1/repos/:owner/:repo/pulls', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const number = 3000 + pullRequests.length + 1;
    const pr: Record<string, unknown> = {
      number,
      // Bind html_url to the actual listener host so the adapter's canonical
      // pull-request assertion (exact instance URL) matches in every test.
      html_url: `http://${req.headers.host}/${options.owner}/${options.name}/pulls/${number}`,
      state: 'open',
      draft: body.draft === true,
      title: body.title,
      head: {
        // A caller may preseed a mismatched head (quarantine coverage);
        // otherwise the configured branch head is the canonical answer.
        sha: typeof body.head_sha === 'string' ? body.head_sha : (options.branchHead ?? 'a'.repeat(40)),
        ref: body.head,
        repo: { id: 2001, full_name: `${options.owner}/${options.name}` },
      },
      base: {
        sha: 'b'.repeat(40),
        ref: body.base ?? 'main',
        repo: { id: 2001, full_name: `${options.owner}/${options.name}` },
      },
    };
    pullRequests.push({ head: body.head, base: body.base, ...pr });
    res.status(201).json(pr);
  });

  app.get('/api/v1/repos/:owner/:repo/pulls/:number', (req, res) => {
    const number = Number(req.params.number);
    const pr = pullRequests.find((candidate) => candidate.number === number);
    if (!pr) {
      res.status(404).json({ message: 'pull request not found' });
      return;
    }
    res.json(pr);
  });

  app.patch('/api/v1/repos/:owner/:repo/pulls/:number', (req, res) => {
    const number = Number(req.params.number);
    const pr = pullRequests.find((candidate) => candidate.number === number);
    if (!pr) {
      res.status(404).json({ message: 'pull request not found' });
      return;
    }
    const state = String((req.body as Record<string, unknown>).state ?? 'open');
    pr.state = state;
    quarantined.push({ number, state });
    res.json(pr);
  });

  app.get('/api/v1/repos/:owner/:repo/statuses/:sha', (req, res) => {
    const sha = String(req.params.sha).toLowerCase();
    res.json(statuses.get(sha) ?? []);
  });

  app.post('/api/v1/repos/:owner/:repo/statuses/:sha', (req, res) => {
    if (failNextStatusPosts > 0) {
      failNextStatusPosts -= 1;
      res.status(failStatusCode).json({ message: 'injected failure' });
      return;
    }
    const sha = String(req.params.sha).toLowerCase();
    const body = req.body as Record<string, unknown>;
    const status = {
      id: 4000 + (statuses.get(sha)?.length ?? 0) + 1,
      sha,
      context: body.context,
      state: body.state,
      description: body.description ?? null,
      target_url: body.target_url ?? null,
      created_at: new Date().toISOString(),
    };
    if (!statuses.has(sha)) statuses.set(sha, []);
    statuses.get(sha)!.push(status);
    res.status(201).json(status);
  });

  app.post('/api/v1/repos/:owner/:repo/check-runs', (req, res) => {
    if (!options.hasActions) {
      res.status(404).json({ message: 'check-runs unavailable' });
      return;
    }
    const body = req.body as Record<string, unknown>;
    res.status(201).json({ id: 5001, name: body.name, head_sha: body.head_sha, status: body.status });
  });

  function reset(): void {
    calls.length = 0;
    pullRequests.length = 0;
    statuses.clear();
    quarantined.length = 0;
    failNextStatusPosts = 0;
    failStatusCode = 500;
  }

  return {
    app, validTokens, calls, pullRequests, statuses,
    failNextStatusPosts: 0, failStatusCode: 0, quarantined, reset,
  };
}

export function forgejoSignature(rawBody: Buffer, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}
