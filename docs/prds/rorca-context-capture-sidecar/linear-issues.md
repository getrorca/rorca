# Linear Issue Drafts: Rorca Context Capture Sidecar

Use this file to create a Linear epic and initial issues.

## Epic

**Title:** Rorca Context Capture Sidecar

**Description:**
Build a local/VM/CI sidecar that captures out-of-band project context from CLI notes, git commits, PRs, incidents, and optional external memory systems, then submits reviewed memory candidates to Rorca through stable APIs. This closes the gap where important hotfixes and manual work happen outside formal Rorca spec execution and therefore never enter durable memory.

**Labels:** `context`, `memory`, `cli`, `backend`, `frontend`, `agent-infra`

**Priority:** High

---

## Issue 1: Design context event and memory candidate schemas

**Description:**
Define the durable data model for raw context events and proposed memory candidates. Include idempotency keys, provenance, review status, confidence, trust tier, related files, and metadata.

**Acceptance criteria:**
- Schema covers manual notes, git commits, PR merges, incidents, DuckBrain imports, and Hermes events.
- Candidate fields map cleanly to Rorca memory categories.
- Pending candidates are separate from approved durable memories.
- Idempotency strategy is documented.

---

## Issue 2: Add backend migrations for context capture tables

**Description:**
Add migrations for `context_events` and `memory_candidates`.

**Acceptance criteria:**
- Migration creates tables with appropriate indexes and constraints.
- No pgboss schema is touched.
- Migrations are compatible with existing PostgreSQL setup.
- Tests or migration verification are added.

---

## Issue 3: Add backend ingestion and review routes

**Description:**
Create API routes for submitting context events, creating/listing memory candidates, and approving/rejecting candidates.

**Acceptance criteria:**
- Routes validate input at boundary.
- Routes use AppError subclasses for errors.
- Swagger annotations include `x-rorca-tier` and `x-rorca-rationale`.
- Approving a candidate promotes it to durable memory through existing memory logic.

---

## Issue 4: Implement rorca-capture CLI skeleton

**Description:**
Create the initial CLI package/entrypoint for `rorca-capture`.

**Acceptance criteria:**
- CLI supports `--help` and `status`.
- CLI discovers workspace config and Rorca API URL.
- CLI has typed command parsing and clear error output.
- Basic tests are included.

---

## Issue 5: Implement `rorca-capture remember`

**Description:**
Allow users to manually capture durable context from the CLI.

**Acceptance criteria:**
- Command accepts text, category, title, files, source ref, and workspace.
- Submits to candidate API or existing memory API fallback.
- Supports idempotency for explicit source refs.
- Produces clear success output with candidate/memory ID.

---

## Issue 6: Implement Rorca API client and local queue fallback

**Description:**
Create a reusable client for Rorca ingestion APIs and a JSONL queue for offline capture.

**Acceptance criteria:**
- API client handles errors and retries safely.
- Local queue stores normalized candidate payloads.
- Queue can be flushed when API becomes available.
- Duplicate queue entries are avoided when possible.

---

## Issue 7: Implement git commit metadata extraction

**Description:**
Extract SHA, author, timestamp, branch, commit message, changed files, and optional diff summary for a commit.

**Acceptance criteria:**
- Works for arbitrary commit SHA.
- Respects ignore patterns.
- Does not include full diffs by default.
- Handles merge commits gracefully.

---

## Issue 8: Implement `ingest-commit` and `ingest-git`

**Description:**
Create commands for ingesting a single commit or a range of commits.

**Acceptance criteria:**
- `ingest-commit <sha>` creates an event/candidate or queues it.
- `ingest-git --since <ref>` scans a commit range.
- `--since last-rorca-run` is supported or stubbed with clear error if backend pointer is missing.
- Re-running is idempotent.

---

## Issue 9: Implement git hook installer

**Description:**
Install a safe post-commit hook that calls `rorca-capture ingest-commit HEAD`.

**Acceptance criteria:**
- Existing hooks are preserved or chained.
- Installer is reversible.
- Hook failures do not block commits by default.
- User can opt into blocking mode later.

---

## Issue 10: Add secret redaction and ignore-file support

**Description:**
Prevent sensitive data from being captured.

**Acceptance criteria:**
- Supports `.rorca-captureignore`.
- Redacts common secret patterns.
- Excluded files are not included in candidate payloads.
- Tests cover representative secrets and ignored paths.

---

## Issue 11: Add memory candidate review UI

**Description:**
Add UI for reviewing pending memory candidates.

**Acceptance criteria:**
- Shows title, rule, context, category, confidence, source, related files.
- Supports approve, reject, edit-and-approve.
- Pending candidates are filterable by workspace/source/category/confidence.
- Approved candidates become durable memories.

---

## Issue 12: Add candidate promotion flow

**Description:**
Promote approved candidates into Rorca memory while preserving provenance.

**Acceptance criteria:**
- Promotion calls existing memory creation logic.
- Candidate records link to promoted memory ID.
- Related files and source refs are preserved.
- Re-approval is idempotent.

---

## Issue 13: Add daemon mode for VM/server reconciliation

**Description:**
Run `rorca-capture daemon` to periodically scan repos and submit missing context candidates.

**Acceptance criteria:**
- Configurable interval.
- Health/status output.
- Idempotent scans.
- Does not overload Rorca API.

---

## Issue 14: Add CI/PR ingestion mode

**Description:**
Support ingestion from CI and PR merge events.

**Acceptance criteria:**
- Command accepts PR metadata via env/file/flags.
- Captures merge SHA, PR number, title/body, author, changed files.
- Creates pending candidates only.
- Works without requiring a long-running daemon.

---

## Issue 15: Add optional DuckBrain import adapter

**Description:**
Import selected DuckBrain JSONL memories as Rorca memory candidates.

**Acceptance criteria:**
- Reads DuckBrain JSONL records.
- Preserves namespace/key provenance.
- Does not perform bidirectional sync.
- Imports as pending candidates by default.

