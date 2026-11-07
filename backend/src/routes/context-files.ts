/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * context-files.ts — CIE-011: API routes for context/intent file editing.
 *
 * Provides endpoints for:
 * - Listing all registered context/intent files (CLAUDE.md, AGENTS.md, skills, MEMORY.md)
 * - Reading file content
 * - Writing file content (with echo suppression for chokidar)
 * - Git diff against last committed version
 * - Creating new skill files from template
 */

import { Router, Request, Response } from 'express';
import { queryOne, query } from '../db/index';
import { defaultRorcaConfig, parseRorcaConfigContent } from '../lib/rorca-config';
import type { RorcaConfig } from '../lib/rorca-config';
import { markWriting } from '../lib/file-watcher';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import {
  type SafeWorkspaceFile,
  type SafeWorkspaceTextFile,
  type WorkspaceBoundary,
  type WorkspaceLocation,
  captureWorkspaceBoundary,
  execWorkspaceGit,
  requireWorkspaceAdmin,
  requireWorkspaceMember,
  resolveSafeWorkspacePath,
  safeReadWorkspaceTextFile,
  safeStatWorkspaceFile,
  safeUnlinkWorkspaceFile,
  safeWriteWorkspaceFile,
  UnsafeWorkspacePathError,
  validateRelativeWorkspacePath,
  WorkspaceFileExistsError,
} from '../lib/auth-utils';
import { SkillRegistry } from '../lib/skill-registry';
import { boundedOutboundFetch, parsePrivateHostAllowlist } from '../lib/bounded-outbound-fetch';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveWorkspacePath(workspaceId: string): Promise<string | null> {
  try {
    const row = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [workspaceId]);
    return row?.path ?? null;
  } catch {
    return null;
  }
}

function mapUnsafeWorkspacePath(error: unknown): never {
  if (error instanceof UnsafeWorkspacePathError) {
    throw new ValidationError(error.message);
  }
  throw error;
}

export function safeLoadRorcaConfig(boundary: WorkspaceBoundary): RorcaConfig {
  try {
    const file = safeReadWorkspaceTextFile(boundary, '.rorca/config.json');
    return parseRorcaConfigContent(file.content);
  } catch (error) {
    if (error instanceof UnsafeWorkspacePathError
      && error.message.includes('does not exist')) {
      return defaultRorcaConfig();
    }
    return mapUnsafeWorkspacePath(error);
  }
}

function safeContextFileMetadata(
  workspacePath: WorkspaceBoundary,
  relativePath: string,
): { exists: boolean; sizeBytes: number; modifiedAt: string | null } {
  try {
    const { stat } = safeStatWorkspaceFile(workspacePath, relativePath);
    return { exists: true, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
  } catch (error) {
    if (error instanceof UnsafeWorkspacePathError
      && error.message.includes('does not exist')) {
      return { exists: false, sizeBytes: 0, modifiedAt: null };
    }
    return mapUnsafeWorkspacePath(error);
  }
}

function validatedSkillBasename(filename: string): string {
  const basename = filename.endsWith('.md') ? filename.slice(0, -3) : filename;
  if (!/^[A-Za-z0-9_-]+$/.test(basename)) {
    throw new ValidationError('Invalid skill filename');
  }
  return basename;
}

export function validateContextFileRelativePath(relativePath: string): string {
  const normalized = validateRelativeWorkspacePath(relativePath);
  const components = normalized.split('/');
  if (components.some(component => component.toLowerCase() === '.git')
    || components.some(component => component.toLowerCase() === '.gitattributes')) {
    throw new UnsafeWorkspacePathError('Git control files are not writable context files');
  }
  return normalized;
}

export interface ContextFileGitState {
  committedContent: string | null;
  diff: string;
  hasChanges: boolean;
  isTracked: boolean;
}

function renderLiteralContentDiff(committed: string, current: string): string {
  if (committed === current) return '';
  const removed = committed.split('\n').map(line => `-${line}`).join('\n');
  const added = current.split('\n').map(line => `+${line}`).join('\n');
  return `--- committed\n+++ workspace\n@@\n${removed}\n${added}\n`;
}

/** Execute git file inspection with a fixed binary and argument vectors only. */
export function getContextFileGitState(
  workspacePath: WorkspaceLocation,
  filePath: string,
): ContextFileGitState {
  const boundary = typeof workspacePath === 'string'
    ? captureWorkspaceBoundary(workspacePath)
    : workspacePath;
  const normalizedPath = validateContextFileRelativePath(filePath);
  resolveSafeWorkspacePath(boundary, normalizedPath);

  let committedContent: string | null = null;
  try {
    committedContent = execWorkspaceGit(boundary, ['show', `HEAD:${normalizedPath}`]);
  } catch {
    // File not in git yet (new/untracked).
  }

  const currentContent = safeReadWorkspaceTextFile(boundary, normalizedPath).content;
  const diff = committedContent === null
    ? ''
    : renderLiteralContentDiff(committedContent, currentContent);

  return {
    diff,
    committedContent,
    hasChanges: diff.length > 0,
    isTracked: committedContent !== null,
  };
}

/** Well-known context/intent files relative to workspace root */
const WELL_KNOWN_FILES = [
  { path: 'CLAUDE.md', role: 'context' as const, managed: 'hybrid' as const },
  { path: 'AGENTS.md', role: 'governance' as const, managed: 'hybrid' as const },
  { path: '.rorca/MEMORY.md', role: 'memory' as const, managed: 'rorca' as const },
  { path: '.rorca/AGENTS.md', role: 'governance' as const, managed: 'rorca' as const },
];

interface ContextFileEntry {
  relativePath: string;
  role: string;
  managed: 'rorca' | 'manual' | 'hybrid';
  exists: boolean;
  sizeBytes: number;
  modifiedAt: string | null;
}

function estimateTokens(text: string): number {
  // ~4 chars per token for English/code text
  return Math.ceil(text.length / 4);
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

// ─── List Context Files ──────────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/context-files:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     summary: List all registered context/intent files for a workspace
 *     operationId: listContextFiles
 *     description: Returns all well-known, config-registered, skill, and global routing context/intent files for the specified workspace.
 *     tags: [Context Files]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Array of context file entries
 */
router.get('/:id/context-files', requireWorkspaceMember(), async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }
  const boundary = captureWorkspaceBoundary(wsPath);

  const files: ContextFileEntry[] = [];
  const seen = new Set<string>();

  // 1. Well-known files
  for (const wk of WELL_KNOWN_FILES) {
    const metadata = safeContextFileMetadata(boundary, wk.path);
    files.push({
      relativePath: wk.path,
      role: wk.role,
      managed: wk.managed,
      exists: metadata.exists,
      sizeBytes: metadata.sizeBytes,
      modifiedAt: metadata.modifiedAt,
    });
    seen.add(wk.path);
  }

  // 2. Files from .rorca/config.json fileRegistry
  const config = safeLoadRorcaConfig(boundary);
  if (config.context?.fileRegistry) {
    for (const entry of config.context.fileRegistry) {
      if (seen.has(entry.path)) continue;
      const metadata = safeContextFileMetadata(boundary, entry.path);
      files.push({
        relativePath: entry.path,
        role: entry.role,
        managed: entry.managed,
        exists: metadata.exists,
        sizeBytes: metadata.sizeBytes,
        modifiedAt: metadata.modifiedAt,
      });
      seen.add(entry.path);
    }
  }

  // 3. Exact skill entrypoints from .rorca/skills/. Support files stay hidden
  // until an agent explicitly follows a reference from SKILL.md.
  try {
    const registry = new SkillRegistry().discoverFilesystem(boundary.rootPath);
    for (const skill of registry.getAll().filter(item => item.source === 'rorca-skills' && item.filePath)) {
      const relPath = `.rorca/skills/${skill.relativePath}`;
      if (seen.has(relPath)) continue;
      const metadata = safeContextFileMetadata(boundary, relPath);
      files.push({
        relativePath: relPath,
        role: 'skill',
        managed: 'manual',
        exists: metadata.exists,
        sizeBytes: metadata.sizeBytes,
        modifiedAt: metadata.modifiedAt,
      });
      seen.add(relPath);
    }
  } catch { /* skill registry diagnostics are exposed by the skills APIs */ }

  // 4. Global routing files that aren't already listed
  for (const globalFile of config.routing?.global ?? []) {
    if (seen.has(globalFile)) continue;
    const metadata = safeContextFileMetadata(boundary, globalFile);
    files.push({
      relativePath: globalFile,
      role: 'context',
      managed: 'manual',
      exists: metadata.exists,
      sizeBytes: metadata.sizeBytes,
      modifiedAt: metadata.modifiedAt,
    });
    seen.add(globalFile);
  }

  res.json({ files });
});

// ─── Read File Content ───────────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/context-files/read:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     summary: Read the content of a context/intent file
 *     operationId: readContextFile
 *     description: Reads and returns the content, word count, estimated token count, and metadata for a context/intent file within the workspace.
 *     tags: [Context Files]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: filePath
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *         description: Relative path within workspace
 *     responses:
 *       200:
 *         description: File content + metadata
 */
router.get('/:id/context-files/read', requireWorkspaceMember(), async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const filePath = req.query.filePath as string;
  if (!filePath) {
    throw new ValidationError('Missing filePath query parameter');
    return;
  }

  let file: SafeWorkspaceTextFile;
  try {
    const boundary = captureWorkspaceBoundary(wsPath);
    file = safeReadWorkspaceTextFile(boundary, validateContextFileRelativePath(filePath));
  } catch (error) {
    if (error instanceof UnsafeWorkspacePathError
      && error.message.includes('does not exist')) {
      throw new NotFoundError('File not found');
    }
    return mapUnsafeWorkspacePath(error);
  }

  res.json({
    content: file.content,
    wordCount: countWords(file.content),
    estimatedTokens: estimateTokens(file.content),
    sizeBytes: file.stat.size,
    modifiedAt: file.stat.mtime.toISOString(),
  });
});

// ─── Write File Content ──────────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/context-files/write:
 *   put:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     summary: Write content to a context/intent file
 *     operationId: writeContextFile
 *     description: Writes the provided content to a context/intent file, creating parent directories if needed, and suppresses chokidar echo events.
 *     tags: [Context Files]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               filePath:
 *                 type: string
 *               content:
 *                 type: string
 *     responses:
 *       200:
 *         description: File saved successfully
 */
router.put('/:id/context-files/write', requireWorkspaceAdmin(), async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const { filePath, content } = req.body as { filePath: string; content: string };
  if (!filePath || typeof content !== 'string') {
    throw new ValidationError('Missing filePath or content');
    return;
  }

  let written: SafeWorkspaceFile;
  try {
    const boundary = captureWorkspaceBoundary(wsPath);
    const relativePath = validateContextFileRelativePath(filePath);
    const targetPath = resolveSafeWorkspacePath(boundary, relativePath);
    // Mark for echo suppression before the descriptor-backed write.
    markWriting(targetPath);
    written = safeWriteWorkspaceFile(boundary, relativePath, content);
  } catch (error) {
    return mapUnsafeWorkspacePath(error);
  }
  res.json({
    saved: true,
    wordCount: countWords(content),
    estimatedTokens: estimateTokens(content),
    sizeBytes: written.stat.size,
    modifiedAt: written.stat.mtime.toISOString(),
  });
});

// ─── Git Diff ────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/context-files/diff:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     summary: Get git diff of a context file vs last committed version
 *     operationId: diffContextFile
 *     description: Returns the unified git diff and committed content for a context file compared against the HEAD revision.
 *     tags: [Context Files]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: filePath
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Git diff output + committed content
 */
router.get('/:id/context-files/diff', requireWorkspaceMember(), async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const filePath = req.query.filePath as string;
  if (!filePath) {
    throw new ValidationError('Missing filePath query parameter');
    return;
  }

  try {
    res.json(getContextFileGitState(wsPath, filePath));
  } catch (error) {
    if (error instanceof UnsafeWorkspacePathError) {
      return mapUnsafeWorkspacePath(error);
    }
    handleRouteError(res, error, '[ContextFiles] Compute diff');
  }
});

// ─── Skill Templates ──────────────────────────────────────────────────────────

const SKILL_TEMPLATES: Record<string, string> = {
  blank: `# {name}

## Description

Describe what this skill does and when it should be injected.

## Instructions

- Step-by-step instructions for the agent when this skill is active
- Be specific about expected behavior, coding patterns, and conventions

## Context

Additional context the agent needs to follow this skill correctly.
`,
  testing: `# {name}

## Description

Testing skill — enforces test-writing conventions and quality standards.

## Instructions

- Write tests before or alongside implementation (TDD preferred)
- Use \`describe\` / \`it\` / \`test\` blocks with descriptive names
- Cover happy path, edge cases, and error scenarios
- Mock external dependencies (APIs, databases, filesystems)
- Assert specific values, not just truthiness
- Keep tests deterministic — no random data, no timing dependencies
- Use factory functions for test data, not inline object literals
- One assertion concept per test (multiple asserts are OK if testing the same behavior)

## Patterns

\`\`\`typescript
describe('UserService', () => {
  it('should create a user with valid input', () => { /* ... */ });
  it('should reject duplicate emails', () => { /* ... */ });
  it('should hash passwords before storing', () => { /* ... */ });
});
\`\`\`

## Anti-Patterns

- No snapshot tests for dynamic data
- No \`any\` in test types
- No \`console.log\` debugging left in tests
- No tests that depend on execution order
`,
  security: `# {name}

## Description

Security skill — enforces secure coding practices and vulnerability prevention.

## Instructions

- Validate ALL user input at system boundaries (never trust client data)
- Use parameterized queries for ALL database operations (no string concatenation)
- Escape output for the target context (HTML, URL, SQL, shell)
- Never log sensitive data (passwords, tokens, API keys, PII)
- Use constant-time comparison for secrets (\`crypto.timingSafeEqual\`)
- Set appropriate HTTP security headers (CSP, HSTS, X-Frame-Options)
- Implement rate limiting on authentication endpoints
- Use HTTPS for all external communications
- Validate file uploads: check MIME type, size limits, no executable extensions
- Never expose stack traces or internal errors to clients

## OWASP Top 10 Checklist

1. Injection — parameterized queries, input validation
2. Broken Authentication — strong password hashing (bcrypt/argon2), session management
3. Sensitive Data Exposure — encrypt at rest and in transit
4. XXE — disable external entity processing in XML parsers
5. Broken Access Control — verify authorization on every request
6. Security Misconfiguration — secure defaults, no debug in production
7. XSS — context-aware output encoding
8. Insecure Deserialization — validate and sanitize before deserializing
9. Known Vulnerabilities — keep dependencies updated
10. Insufficient Logging — log security events, alert on anomalies
`,
  performance: `# {name}

## Description

Performance skill — enforces performance best practices and optimization patterns.

## Instructions

- Avoid N+1 queries — use JOINs, batch loading, or DataLoader pattern
- Use database indexes for frequently queried columns
- Implement pagination for list endpoints (never return unbounded results)
- Cache expensive computations and repeated database queries
- Use connection pooling for database connections
- Lazy-load heavy modules and components
- Debounce user input handlers (search, resize, scroll)
- Use \`requestAnimationFrame\` for DOM-intensive operations
- Profile before optimizing — measure, don't guess
- Set appropriate HTTP cache headers (ETag, Cache-Control)

## Patterns

- Memoization: \`useMemo\`, \`useCallback\` for expensive React computations
- Virtual scrolling for long lists (react-virtual, @tanstack/virtual)
- Code splitting with dynamic \`import()\` for route-level chunks
- Web Workers for CPU-intensive tasks off the main thread
- Connection pooling and prepared statements for database access
`,
  database: `# {name}

## Description

Database skill — enforces database design and query best practices.

## Instructions

- Use migrations for ALL schema changes (never manual ALTER TABLE)
- Add indexes for columns used in WHERE, JOIN, and ORDER BY clauses
- Use foreign key constraints to maintain referential integrity
- Prefer explicit column lists over SELECT * in production queries
- Use transactions for multi-statement operations that must be atomic
- Normalize data to 3NF unless denormalization is justified by performance
- Use appropriate column types (don't store dates as strings)
- Add NOT NULL constraints where the column should always have a value
- Use CHECK constraints for enum-like columns
- Name constraints and indexes explicitly (not auto-generated names)

## Patterns

\`\`\`sql
-- Good: explicit columns, parameterized
SELECT id, name, email FROM users WHERE status = ? ORDER BY created_at DESC LIMIT ?;

-- Good: index for the above query
CREATE INDEX idx_users_status_created ON users(status, created_at DESC);

-- Good: migration with explicit constraint names
ALTER TABLE orders ADD CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id);
\`\`\`
`,
  api: `# {name}

## Description

API design skill — enforces RESTful API conventions and best practices.

## Instructions

- Use standard HTTP methods: GET (read), POST (create), PUT (replace), PATCH (update), DELETE (remove)
- Use plural nouns for resource endpoints: \`/api/users\`, not \`/api/user\`
- Return appropriate HTTP status codes: 200, 201, 204, 400, 401, 403, 404, 409, 422, 500
- Use JSON for request/response bodies with \`Content-Type: application/json\`
- Implement pagination: \`?page=1&pageSize=20\` with total count in response
- Version APIs if breaking changes are needed: \`/api/v2/users\`
- Validate request bodies with a schema validator (zod, joi, ajv)
- Return consistent error format: \`{ error: string, code?: string, details?: object }\`
- Use query params for filtering/sorting: \`?status=active&sort=name:asc\`
- Document endpoints with OpenAPI/Swagger annotations

## Response Format

\`\`\`json
// Success (list)
{ "items": [...], "total": 42, "page": 1, "pageSize": 20 }

// Success (single)
{ "user": { "id": "...", "name": "..." } }

// Error
{ "error": "Validation failed", "code": "VALIDATION_ERROR", "details": [...] }
\`\`\`
`,
  react: `# {name}

## Description

React development skill — enforces React patterns and component conventions.

## Instructions

- Use functional components with hooks (no class components)
- Keep components focused — one responsibility per component
- Extract custom hooks for reusable stateful logic (\`useXxx\`)
- Use TypeScript interfaces for all props (not \`any\`)
- Prefer controlled components for form inputs
- Use \`useCallback\` for event handlers passed to child components
- Use \`useMemo\` for expensive derived data (not for every variable)
- Handle loading, error, and empty states explicitly
- Use semantic HTML elements (\`<button>\`, \`<nav>\`, \`<main>\`, not \`<div>\` for everything)
- Keep effects minimal — one concern per \`useEffect\`

## Patterns

\`\`\`tsx
interface Props {
  items: Item[];
  onSelect: (item: Item) => void;
}

export default function ItemList({ items, onSelect }: Props) {
  if (items.length === 0) {
    return <EmptyState message="No items found" />;
  }
  return (
    <ul role="list">
      {items.map(item => (
        <li key={item.id}>
          <button onClick={() => onSelect(item)}>{item.name}</button>
        </li>
      ))}
    </ul>
  );
}
\`\`\`
`,
  postgres: `# {name}

## Description

PostgreSQL skill — enforces Postgres-specific best practices and patterns.

## Instructions

- Use \`SERIAL\` or \`GENERATED ALWAYS AS IDENTITY\` for auto-increment PKs
- Use \`TEXT\` over \`VARCHAR(n)\` unless length validation is needed
- Use \`TIMESTAMPTZ\` (not \`TIMESTAMP\`) for time-aware columns
- Use \`JSONB\` (not \`JSON\`) for structured JSON storage
- Create partial indexes for queries with common WHERE clauses
- Use \`EXPLAIN ANALYZE\` to verify query plans
- Use CTEs (\`WITH\`) for complex multi-step queries
- Use \`ON CONFLICT\` for upsert operations
- Use connection pooling (pgBouncer or built-in pool)
- Use row-level security (RLS) for multi-tenant data isolation

## Patterns

\`\`\`sql
-- Upsert
INSERT INTO users (email, name) VALUES ($1, $2)
ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW();

-- Partial index
CREATE INDEX idx_orders_pending ON orders(created_at) WHERE status = 'pending';

-- CTE for complex query
WITH active_users AS (
  SELECT id FROM users WHERE last_login > NOW() - INTERVAL '30 days'
)
SELECT o.* FROM orders o JOIN active_users u ON o.user_id = u.id;
\`\`\`
`,
  terraform: `# {name}

## Description

Terraform/IaC skill — enforces infrastructure-as-code best practices.

## Instructions

- Use modules for reusable infrastructure components
- Tag ALL resources with: Name, Environment, Project, ManagedBy=terraform
- Use variables with descriptions and type constraints
- Use \`terraform fmt\` and \`terraform validate\` before every commit
- Store state remotely (S3, GCS, Terraform Cloud) — never local state in production
- Use state locking (DynamoDB for S3 backend)
- Use workspaces or separate state files for environment isolation
- Pin provider versions: \`required_providers { aws = { version = "~> 5.0" } }\`
- Use data sources to reference existing resources (don't hardcode IDs)
- Use \`lifecycle { prevent_destroy = true }\` for critical resources

## Patterns

\`\`\`hcl
resource "aws_instance" "web" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = var.instance_type

  tags = merge(var.common_tags, {
    Name = "\${var.project}-web-\${var.environment}"
  })

  lifecycle {
    create_before_destroy = true
  }
}
\`\`\`
`,
  auth: `# {name}

## Description

Authentication & authorization skill — enforces auth best practices.

## Instructions

- Hash passwords with bcrypt (cost factor 12+) or argon2id
- Use JWTs with short expiry (15min access, 7d refresh) and HTTP-only cookies
- Implement refresh token rotation (invalidate old refresh token on use)
- Rate-limit login attempts (5 per minute per IP/email)
- Use constant-time comparison for token validation
- Validate JWT signature, expiry, and issuer on every protected request
- Implement RBAC or ABAC for authorization (not ad-hoc permission checks)
- Log all auth events: login, logout, failed attempts, password changes
- Enforce password complexity: 8+ chars, no common passwords
- Use CSRF tokens for cookie-based auth (not needed for Bearer token auth)

## Patterns

\`\`\`typescript
// Middleware
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) throw new AuthError('Authentication required');
  try {
    req.user = verifyJWT(token);
    next();
  } catch {
    throw new AuthError('Invalid or expired token');
  }
}

// Permission check
function requireRole(...roles: string[]) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      throw new ForbiddenError('Insufficient permissions');
    }
    next();
  };
}
\`\`\`
`,
};

/**
 * @swagger
 * /api/workspaces/{id}/context-files/create-skill:
 *   post:
 *     tags: [Context Files]
 *     summary: Create a new skill file in .rorca/skills/
 *     operationId: createSkillFile
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Creating executable workspace skill instructions is an operator-owned mutation requiring workspace administration."
 *     description: >
 *       Creates a new skill markdown file at .rorca/skills/{filename}.md in the
 *       workspace directory. Optionally uses a predefined template. Returns the
 *       path and metadata of the created file.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *         example: cashflow-ai
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [filename]
 *             properties:
 *               filename:
 *                 type: string
 *                 description: Filename for the skill (without extension, or with .md)
 *                 example: react-hooks
 *               template:
 *                 type: string
 *                 description: Template ID to use as initial content (optional)
 *                 example: basic
 *     responses:
 *       201:
 *         description: Skill file created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 created: { type: boolean, example: true }
 *                 relativePath:
 *                   type: string
 *                   description: Path relative to workspace root
 *                   example: .rorca/skills/react-hooks.md
 *                 sizeBytes: { type: integer, example: 512 }
 *                 modifiedAt: { type: string, format: date-time }
 *       400:
 *         description: Missing or invalid filename
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Workspace not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: File already exists at that path
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/:id/context-files/create-skill', requireWorkspaceAdmin(), async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const { filename, template: templateId } = req.body as { filename: string; template?: string };
  if (!filename || typeof filename !== 'string') {
    throw new ValidationError('Missing filename');
    return;
  }

  // Sanitize filename
  const sanitized = filename.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  if (!sanitized) {
    throw new ValidationError('Invalid filename');
    return;
  }

  const relPath = `.rorca/skills/${sanitized}.md`;
  let boundary: WorkspaceBoundary;
  let abs: string;
  try {
    boundary = captureWorkspaceBoundary(wsPath);
    abs = resolveSafeWorkspacePath(boundary, relPath);
  } catch (error) {
    return mapUnsafeWorkspacePath(error);
  }

  if (templateId && !Object.hasOwn(SKILL_TEMPLATES, templateId)) {
    throw new ValidationError('Unknown skill template');
  }
  const templateKey = templateId ?? 'blank';
  const content = SKILL_TEMPLATES[templateKey].replace(/\{name\}/g, sanitized);

  markWriting(abs);
  let written: SafeWorkspaceFile;
  try {
    written = safeWriteWorkspaceFile(boundary, relPath, content, { exclusive: true });
  } catch (error) {
    if (error instanceof WorkspaceFileExistsError) {
      throw new ConflictError('File already exists');
    }
    return mapUnsafeWorkspacePath(error);
  }
  res.status(201).json({
    created: true,
    relativePath: relPath,
    sizeBytes: written.stat.size,
    modifiedAt: written.stat.mtime.toISOString(),
  });
});

// ─── List Skill Templates ────────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/context-files/skill-templates:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     summary: List available skill templates
 *     operationId: listSkillTemplates
 *     description: Returns the list of available skill template identifiers and their display labels.
 *     tags: [Context Files]
 *     responses:
 *       200:
 *         description: Array of template IDs with labels
 */
router.get('/:id/context-files/skill-templates', requireWorkspaceMember(), (_req: Request, res: Response) => {
  const templates = Object.keys(SKILL_TEMPLATES).map(id => ({
    id,
    label: id === 'blank' ? 'Blank' : id.charAt(0).toUpperCase() + id.slice(1),
  }));
  res.json({ templates });
});

// ─── Delete Skill File ──────────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/context-files/delete-skill:
 *   delete:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     summary: Delete a skill file from .rorca/skills/
 *     operationId: deleteSkillFile
 *     description: Deletes a skill file from the workspace .rorca/skills/ directory and returns warnings if the skill is referenced in active routing scopes or tags.
 *     tags: [Context Files]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               filename:
 *                 type: string
 *                 description: Filename without extension
 *     responses:
 *       200:
 *         description: Skill file deleted (with active scope/tag warnings if applicable)
 *       404:
 *         description: File not found
 */
router.delete('/:id/context-files/delete-skill', requireWorkspaceAdmin(), async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const { filename } = req.body as { filename: string };
  if (!filename || typeof filename !== 'string') {
    throw new ValidationError('Missing filename');
    return;
  }

  const sanitized = validatedSkillBasename(filename);
  const relPath = `.rorca/skills/${sanitized}.md`;
  let boundary: WorkspaceBoundary;
  let abs: string;
  try {
    boundary = captureWorkspaceBoundary(wsPath);
    abs = resolveSafeWorkspacePath(boundary, relPath, { mustExist: true, expect: 'file' });
  } catch (error) {
    if (error instanceof UnsafeWorkspacePathError
      && error.message.includes('does not exist')) {
      throw new NotFoundError('File not found');
    }
    return mapUnsafeWorkspacePath(error);
  }

  // Read configuration through the same captured root identity.
  let config: RorcaConfig = defaultRorcaConfig();
  try {
    config = JSON.parse(
      safeReadWorkspaceTextFile(boundary, '.rorca/config.json').content,
    ) as RorcaConfig;
  } catch (error) {
    if (!(error instanceof UnsafeWorkspacePathError)
      || !error.message.includes('does not exist')) {
      return mapUnsafeWorkspacePath(error);
    }
  }
  const activeScopes: string[] = [];
  const activeTags: string[] = [];
  for (const scope of config.routing?.scopes ?? []) {
    if (scope.inject.includes(relPath)) activeScopes.push(scope.path);
  }
  for (const tag of config.routing?.tags ?? []) {
    if (tag.inject.includes(relPath)) activeTags.push(tag.tag);
  }

  markWriting(abs);
  try {
    safeUnlinkWorkspaceFile(boundary, relPath);
  } catch (error) {
    return mapUnsafeWorkspacePath(error);
  }

  res.json({
    deleted: true,
    filename: `${sanitized}.md`,
    warnings: activeScopes.length > 0 || activeTags.length > 0
      ? {
        activeScopes,
        activeTags,
        message: `Skill was assigned to ${activeScopes.length} scope(s) and ${activeTags.length} tag(s). Update routing config to remove references.`,
      }
      : null,
  });
});

// ─── Skill Usage Stats ──────────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/context-files/skill-usage:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     summary: Get skill injection counts from recent WAL events
 *     operationId: getSkillUsageStats
 *     description: Queries WAL events to compute how many times each skill file was injected during recent pipeline runs.
 *     tags: [Context Files]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: runs
 *         in: query
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of recent runs to check
 *     responses:
 *       200:
 *         description: Usage counts per skill file
 */
router.get('/:id/context-files/skill-usage', requireWorkspaceMember(), async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const runLimit = Math.min(Math.max(parseInt(String(req.query.runs)) || 10, 1), 100);

  // Query WAL events for story_started events that contain context_files
  try {
    const rows = await query<{ payload: string }>(
      `SELECT payload FROM wal_events
      WHERE event_type = 'story_started'
        AND workspace_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
      [req.params.id, runLimit * 50]
    );

    const counts = new Map<string, number>();
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload);
        const files: string[] = payload.context_files ?? [];
        for (const f of files) {
          if (f.startsWith('.rorca/skills/')) {
            counts.set(f, (counts.get(f) || 0) + 1);
          }
        }
      } catch { /* skip malformed */ }
    }

    const usage: Record<string, number> = {};
    for (const [file, count] of counts) {
      usage[file] = count;
    }

    res.json({ usage, runsChecked: runLimit });
  } catch {
    res.json({ usage: {}, runsChecked: 0 });
  }
});

// ─── Import Skill from URL ──────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/context-files/import-skill:
 *   post:
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Workspace-admin import performs a bounded public-network fetch and writes a skill file; it is never MCP-callable."
 *     summary: Import a skill file from a URL
 *     operationId: importSkillFromUrl
 *     description: Fetches markdown content from a remote URL and saves it as a new skill file in .rorca/skills/.
 *     tags: [Context Files]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               url:
 *                 type: string
 *               filename:
 *                 type: string
 *     responses:
 *       201:
 *         description: Skill imported
 */
router.post('/:id/context-files/import-skill', requireWorkspaceAdmin(), async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const importBody = req.body && typeof req.body === 'object'
    ? req.body as Record<string, unknown>
    : {};
  const url = importBody.url;
  const filename = importBody.filename;
  if (typeof url !== 'string' || !url.trim()
    || typeof filename !== 'string' || !filename.trim()) {
    throw new ValidationError('url and filename must be non-empty strings');
  }


  const sanitized = filename.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase().slice(0, 128);
  if (!sanitized) {
    throw new ValidationError('Invalid filename');
    return;
  }

  const relPath = `.rorca/skills/${sanitized}.md`;
  let boundary: WorkspaceBoundary;
  let abs: string;
  try {
    boundary = captureWorkspaceBoundary(wsPath);
    abs = resolveSafeWorkspacePath(boundary, relPath);
  } catch (error) {
    return mapUnsafeWorkspacePath(error);
  }

  const response = await boundedOutboundFetch(url.trim(), {
    allowedPrivateHosts: parsePrivateHostAllowlist(process.env.RORCA_SKILL_IMPORT_PRIVATE_HOST_ALLOWLIST),
    maxRedirects: 3,
    maxResponseBytes: 500_000,
    connectionTimeoutMs: 3_000,
    totalTimeoutMs: 15_000,
    headers: { Accept: 'text/plain, text/markdown' },
  });
  if (!response.ok) {
    throw new ValidationError(`Failed to fetch skill: HTTP ${response.status}`);
  }
  const content = await response.text();

  markWriting(abs);
  let written: SafeWorkspaceFile;
  try {
    written = safeWriteWorkspaceFile(boundary, relPath, content, { exclusive: true });
  } catch (error) {
    if (error instanceof WorkspaceFileExistsError) {
      throw new ConflictError('File already exists');
    }
    return mapUnsafeWorkspacePath(error);
  }
  res.status(201).json({
    created: true,
    relativePath: relPath,
    sizeBytes: written.stat.size,
    modifiedAt: written.stat.mtime.toISOString(),
    wordCount: countWords(content),
  });
});

// ─── Export Skill ───────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/context-files/export-skill:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     summary: Export a skill file as downloadable .md
 *     operationId: exportSkillFile
 *     description: Returns a skill file as a downloadable markdown attachment with appropriate Content-Disposition headers.
 *     tags: [Context Files]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: filename
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Markdown file download
 */
router.get('/:id/context-files/export-skill', requireWorkspaceMember(), async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const filename = req.query.filename as string;
  if (!filename) {
    throw new ValidationError('Missing filename query parameter');
    return;
  }

  const sanitized = validatedSkillBasename(filename);
  const relPath = `.rorca/skills/${sanitized}.md`;
  let file: SafeWorkspaceTextFile;
  try {
    const boundary = captureWorkspaceBoundary(wsPath);
    file = safeReadWorkspaceTextFile(boundary, relPath);
  } catch (error) {
    if (error instanceof UnsafeWorkspacePathError
      && error.message.includes('does not exist')) {
      throw new NotFoundError('Skill file not found');
    }
    return mapUnsafeWorkspacePath(error);
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${sanitized}.md"`);
  res.send(file.content);
});

// ─── Skill Scope/Tag Assignments ────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/context-files/skill-assignments:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     summary: Get scope and tag assignments for all skill files
 *     operationId: getSkillAssignments
 *     description: Returns a map of each skill file path to its assigned routing scopes and tags from the workspace .rorca/config.json.
 *     tags: [Context Files]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Map of skill file path to assigned scopes/tags
 */
router.get('/:id/context-files/skill-assignments', requireWorkspaceMember(), async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const config = safeLoadRorcaConfig(captureWorkspaceBoundary(wsPath));
  const assignments: Record<string, { scopes: string[]; tags: string[] }> = {};

  for (const scope of config.routing?.scopes ?? []) {
    for (const injectPath of scope.inject) {
      if (injectPath.startsWith('.rorca/skills/')) {
        if (!assignments[injectPath]) assignments[injectPath] = { scopes: [], tags: [] };
        assignments[injectPath].scopes.push(scope.path);
      }
    }
  }

  for (const tag of config.routing?.tags ?? []) {
    for (const injectPath of tag.inject) {
      if (injectPath.startsWith('.rorca/skills/')) {
        if (!assignments[injectPath]) assignments[injectPath] = { scopes: [], tags: [] };
        assignments[injectPath].tags.push(tag.tag);
      }
    }
  }

  res.json({ assignments });
});

export default router;
