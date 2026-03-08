# Rorca Production-Ready — Audit Findings & Exhaustive Spec Reference
**Date**: 2026-03-02
**Scope**: Self-hosted Phase 1 — everything needed to ship AGPLv3 on GitHub
**Skills Applied**: exhaustive-specification, adversarial-thinking, spec-gap-analysis, trust-but-verify

---

## AUDIT SCORECARD (Current State)

| Dimension | Score | Blocking? |
|-----------|-------|-----------|
| Error handling | 9/10 | No |
| Loading states | 9/10 | No |
| Design tokens | 9/10 | No |
| Error states | 9/10 | No |
| Empty states | 7/10 | No |
| Rate limiting | 8/10 | No |
| Database integrity | 9/10 | No |
| Code maintainability | 5/10 | No |
| Responsive design | 4/10 | **Yes** |
| Animation system | 4/10 | No |
| Accessibility (a11y) | 2/10 | **Yes** |
| Frontend test coverage | 1/10 | **Yes** |
| Backend test coverage | 5/10 | **Yes** |
| Security headers | 1/10 | **Yes** |
| Input validation | 4/10 | **Yes** |
| OpenAPI coverage | 5/10 | **Yes** |
| Search (semantic) | 0/10 | **Yes** |
| Memory dedup/rotation | 2/10 | No |
| Distribution (Docker/CLI) | 0/10 | **Yes** |

**9 blocking gaps. 52 stories to close them all.**

---

## BLOCKING GAP #1: ACCESSIBILITY (2/10)

**Finding**: Only 5/28 panels have aria attributes. 23 panels have zero `aria-label`, `role`, or `sr-only` usage.

**Panels with accessibility**: HubPanel, ReviewQueuePanel, RunViewPanel, SpecReviewPanel, SettingsPanel
**Panels WITHOUT**: ArchivePanel, PipelineMonitorPanel, TemplateMarketplacePanel, WorktreesPanel, CostBreakdownPanel, GitHubSettingsPanel, HealthDashboardPanel, DirectionStackPanel, BatchForge, SpecForgeOutput, CompletionRatePanel, MemoryPanel, RoiCalculatorPanel, UsageDashboardPanel, AuditLogPanel, ModelComparisonPanel, VelocityChartPanel, ActivityFeedPanel, CompareRunsPanel, TeamDirectionPanel, WorkspaceSettingsPanel, SpecForgePanelPage (22 panels)

**Required**: role="main", aria-label on sections, aria-live="polite" on data tables, keyboard navigation, focus management.

---

## BLOCKING GAP #2: RESPONSIVE DESIGN (4/10)

**Finding**: Only 12/28 panels have Tailwind breakpoints. 16 panels have ZERO responsive classes.

**Panels with responsive**: RunViewPanel (12 breakpoints), SpecReviewPanel (5), WorkspaceSettingsPanel (4), HealthDashboardPanel (4), HubPanel (3), ActivityFeedPanel (1), PipelineMonitorPanel (1), ReviewQueuePanel (1), RoiCalculatorPanel (1), MemoryPanel (1), CompareRunsPanel (1)

**16 panels with ZERO breakpoints**: ArchivePanel, TemplateMarketplacePanel, WorktreesPanel, CostBreakdownPanel, GitHubSettingsPanel, DirectionStackPanel, BatchForge, SpecForgeOutput, CompletionRatePanel, UsageDashboardPanel, AuditLogPanel, ModelComparisonPanel, VelocityChartPanel, SpecForgePanelPage, TeamDirectionPanel, SettingsPanel (3257 lines, zero breakpoints)

---

## BLOCKING GAP #3: SECURITY HEADERS (1/10)

**Missing entirely**:
- No `helmet` middleware (not installed)
- No `Content-Security-Policy`
- No `X-Frame-Options` (clickjacking)
- No `X-Content-Type-Options: nosniff`
- No `Strict-Transport-Security`
- No CSRF protection

**Present**: CORS configured, JWT rotation, AES-256-GCM vault, webhook signature verification.

---

## BLOCKING GAP #4: INPUT VALIDATION (4/10)

**Finding**: 0 routes use Zod or Joi. All validation is manual `if (!field)` checks. 3 routes have minimal validation (wal.ts, notifications.ts, context.ts).

**3 files use dynamic SQL template literals**: settings.ts:138, onboarding.ts:123, auth.ts:594. Safe by design (hardcoded field names) but brittle.

---

## BLOCKING GAP #5: TEST COVERAGE

**Frontend**: 1 test file for 82 components (28 panels + 54 shared). Effectively zero.
**Backend**: 20/45 routes have test files. 25 routes untested including: webhook-handlers.ts, review.ts, memory.ts, skills.ts, agents.ts, conventions.ts, billing.ts, vault.ts, and 17 more.

---

## BLOCKING GAP #6: OPENAPI COVERAGE (5/10)

**12+ routes with 0 @swagger annotations**: webhook-handlers.ts, review.ts, activity.ts, copilot.ts, billing.ts (partial), memory.ts (partial), skills.ts (partial), agents.ts (partial), and more.

**Impact**: Auto-generated MCP tools incomplete. API consumers can't discover endpoints. Swagger UI at /api/docs is partial.

---

## BLOCKING GAP #7: SEARCH (0/10 semantic)

**No vector search installed** (no sqlite-vec, no exa-js).
**Archive FTS5 rebuilds per query** (not cached/incremental).
**Story search is O(n) substring matching** across all specs.
**WAL search uses LIKE** (not FTS).
**synthesize() has no size limit** — dumps everything into prompt.
**No memory deduplication** beyond LLM prompt instruction.

---

## BLOCKING GAP #8: DISTRIBUTION (0/10)

No Dockerfile. No docker-compose.yml. No `bin/rorca` CLI. No `rorca init`. No GitHub Actions CI. No LICENSE file. No CONTRIBUTING.md.

---

## STORY MAP — 52 Stories Across 10 Groups

### Group 1: OSS Distribution (PR-001 to PR-005)
| ID | Title | Size |
|----|-------|------|
| PR-001 | AGPLv3 Licensing & Community Files | S |
| PR-002 | GitHub Actions CI Pipeline | S |
| PR-003 | Docker Image & docker-compose | M |
| PR-004 | rorca CLI — start and init | M |
| PR-005 | Telemetry Opt-In & Privacy | S |

### Group 2: Security Hardening (PR-006 to PR-010)
| ID | Title | Size |
|----|-------|------|
| PR-006 | Helmet + Security Headers | S |
| PR-007 | Zod Input Validation Middleware | L |
| PR-008 | Structured Logging (pino) | M |
| PR-009 | Auth Middleware Conditional Enforcement | M |
| PR-010 | Webhook Signature Verification Audit | S |

### Group 3: Search Infrastructure (PR-011 to PR-017)
| ID | Title | Size |
|----|-------|------|
| PR-011 | sqlite-vec Embedding Store | L |
| PR-012 | Embedding Pipeline (Voyage AI / OpenAI) | M |
| PR-013 | Hybrid Search (FTS5 + Vector + RRF) | L |
| PR-014 | Exa Neural Search Integration | M |
| PR-015 | SearXNG Free Tier Integration | S |
| PR-016 | Selective Retrieval in synthesize() | L |
| PR-017 | Archive FTS5 Incremental Index | M |

### Group 4: Memory Improvements (PR-018 to PR-021)
| ID | Title | Size |
|----|-------|------|
| PR-018 | Memory Semantic Deduplication | M |
| PR-019 | Memory Rotation & Archival Policy | M |
| PR-020 | WAL → Generative Feedback Loop | L |
| PR-021 | Cross-Workspace Memory Synthesis | M |

### Group 5: UI/UX Production Polish (PR-022 to PR-031)
| ID | Title | Size |
|----|-------|------|
| PR-022 | Accessibility Audit — Core Panels (8 panels) | L |
| PR-023 | Accessibility Audit — Analytics Panels (7 panels) | M |
| PR-024 | Accessibility Audit — System Panels (7 panels) | M |
| PR-025 | Responsive Design — Core Panels (8 panels) | L |
| PR-026 | Responsive Design — Analytics + System Panels (8 panels) | M |
| PR-027 | Empty State Consistency Sweep | M |
| PR-028 | Animation System — Framer Motion Unification | M |
| PR-029 | SettingsPanel Decomposition (3257 → 5 sub-components) | L |
| PR-030 | Command Palette Completeness | M |
| PR-031 | Error State Consistency + Error Boundaries | M |

### Group 6: Testing (PR-032 to PR-039)
| ID | Title | Size |
|----|-------|------|
| PR-032 | Frontend Test Infrastructure (Vitest + helpers) | M |
| PR-033 | Frontend Component Tests — Core Panels | L |
| PR-034 | Frontend Component Tests — Analytics + System Panels | L |
| PR-035 | Backend Route Tests — Untested Routes Wave 1 (13 routes) | L |
| PR-036 | Backend Route Tests — Untested Routes Wave 2 (12 routes) | L |
| PR-037 | E2E Playwright Setup + Critical Paths | XL |
| PR-038 | E2E — Spec Lifecycle (Forge → Approve → Run → Archive) | L |
| PR-039 | Performance Benchmarks + Regression Tests | M |

### Group 7: API Documentation (PR-040 to PR-041)
| ID | Title | Size |
|----|-------|------|
| PR-040 | OpenAPI Annotation Audit — Wave 1 (12 routes with 0 annotations) | L |
| PR-041 | OpenAPI Annotation Audit — Wave 2 (routes with partial coverage) | L |

### Group 8: Community Marketplace (PR-042 to PR-047)
| ID | Title | Size |
|----|-------|------|
| PR-042 | DB Migrations — Search, Marketplace, Exa Tables | M |
| PR-043 | Spec Sanitizer — PII Scrubbing | S |
| PR-044 | Marketplace Publish & Fork Routes | M |
| PR-045 | Marketplace Search (FTS5 + Exa) | M |
| PR-046 | Marketplace Panel Redesign | L |
| PR-047 | Publish Flow from Archive Panel | M |

### Group 9: Performance (PR-048 to PR-050)
| ID | Title | Size |
|----|-------|------|
| PR-048 | Frontend Bundle Audit + Lazy Panel Loading | M |
| PR-049 | SQLite Query Optimization + Index Audit | M |
| PR-050 | Search & Memory Performance Benchmarks | S |

### Group 10: Freemium Enforcement (PR-051 to PR-052)
| ID | Title | Size |
|----|-------|------|
| PR-051 | Plan Quotas Table + requirePlan Middleware | M |
| PR-052 | Frontend Upgrade Prompts + Feature Badges | M |

---

## ADVERSARIAL REFINEMENT

### Devil's Advocate
**"52 stories is too many for one spec."**
Response: This is the "ship it" spec. After this runs, Rorca is ready for public GitHub release. Splitting into smaller specs creates coordination overhead and version skew risk. Wave execution handles parallelism — stories in different groups have no dependencies and run concurrently.

**"sqlite-vec is a native extension — compilation issues on different platforms."**
Response: sqlite-vec distributes pre-built binaries for macOS (arm64, x64), Linux (x64, arm64), and Windows. npm install handles this. If compilation fails, fallback to FTS5-only search (already working). Vector search is additive, not load-bearing.

**"Framer Motion adds bundle weight."**
Response: Framer Motion is tree-shakeable. Only imported variants are bundled. Current CSS keyframes are ~50 lines; Framer variants would be ~80 lines but gain: exit animations, layout animations, gesture support, and consistency. Net bundle impact: ~15KB gzipped.

### Red Team
**"Open sourcing before security hardening exposes vulnerabilities."**
Response: PR-006 (helmet), PR-007 (Zod validation), PR-009 (auth middleware) run BEFORE any other group. Wave 1 = security. Nothing ships until those pass.

**"Community marketplace + spec sanitizer could miss novel PII patterns."**
Response: Sanitizer uses 8 regex patterns for known secrets. But novel patterns (internal URLs, project codenames) can't be caught by regex. Mitigation: publish modal shows full sanitized preview before confirm. User reviews what will be public. Add "Report" button on community specs for post-publish flagging.

### Assumption Testing
**"Developers will actually use sqlite-vec for internal search."**
Test: Implement FTS5 improvements first (PR-017). Measure search quality. Only proceed to sqlite-vec (PR-011–013) if FTS5 quality is insufficient for "login system" → "authentication flow" type queries. FTS5 with synonyms may be good enough.

---

## DEPENDENCY GRAPH (Wave Execution Plan)

```
Wave 0 (no deps — run in parallel):
  PR-001 (LICENSE), PR-005 (telemetry), PR-006 (helmet),
  PR-008 (logging), PR-010 (webhooks), PR-017 (FTS cache),
  PR-027 (empty states), PR-042 (migrations), PR-043 (sanitizer),
  PR-048 (bundle audit), PR-049 (SQLite optimization)

Wave 1 (deps on Wave 0):
  PR-002 (CI → needs LICENSE), PR-007 (Zod → needs helmet),
  PR-009 (auth middleware), PR-011 (sqlite-vec),
  PR-022 (a11y core), PR-025 (responsive core),
  PR-028 (animations), PR-029 (Settings decomp),
  PR-032 (frontend test infra), PR-040 (OpenAPI wave 1),
  PR-044 (marketplace routes → needs migrations + sanitizer)

Wave 2:
  PR-003 (Docker → needs CI), PR-012 (embeddings → needs sqlite-vec),
  PR-014 (Exa → needs migrations), PR-015 (SearXNG),
  PR-018 (memory dedup), PR-019 (memory rotation),
  PR-023 (a11y analytics), PR-024 (a11y system),
  PR-026 (responsive analytics+system), PR-030 (command palette),
  PR-031 (error boundaries), PR-033 (frontend tests core),
  PR-035 (backend tests wave 1), PR-041 (OpenAPI wave 2),
  PR-045 (marketplace search → needs routes)

Wave 3:
  PR-004 (CLI → needs Docker), PR-013 (hybrid search → needs embeddings + FTS),
  PR-016 (selective retrieval → needs hybrid search),
  PR-020 (WAL feedback → needs memory dedup),
  PR-021 (cross-workspace → needs memory dedup),
  PR-034 (frontend tests analytics), PR-036 (backend tests wave 2),
  PR-037 (E2E setup), PR-046 (marketplace panel → needs search),
  PR-047 (publish from archive → needs marketplace panel),
  PR-051 (plan quotas)

Wave 4:
  PR-038 (E2E spec lifecycle → needs E2E setup),
  PR-039 (perf benchmarks → needs search + memory complete),
  PR-050 (search benchmarks → needs hybrid search),
  PR-052 (upgrade prompts → needs plan quotas)
```

**5 waves. ~12 stories per wave average. With max 5 parallel: ~2-3 days per wave.**

---

## VERIFICATION CHECKLIST (After All 52 Stories Pass)

### Security
- [ ] `curl -I http://localhost:3030` shows: X-Frame-Options, X-Content-Type-Options, Strict-Transport-Security
- [ ] POST to /api/specs/generate with invalid JSON body returns structured Zod error
- [ ] Rate limiter returns 429 after 100 requests in 60s
- [ ] No console.log in production — only structured pino logs

### Search
- [ ] "payment retry" finds specs about "transaction failure handling" (semantic)
- [ ] Archive search < 100ms for 500 specs
- [ ] synthesize() output < 32K tokens (selective retrieval active)

### UI/UX
- [ ] All 28 panels pass axe-core automated a11y scan (0 critical violations)
- [ ] All 28 panels render correctly at 375px, 768px, 1280px, 1536px
- [ ] Tab key navigates all interactive elements in logical order
- [ ] Every panel has: empty state, error state, loading skeleton

### Testing
- [ ] `npx vitest run` — frontend tests pass, >60% component coverage
- [ ] `cd backend && npm test` — all routes tested, >80% line coverage
- [ ] `npx playwright test` — critical path E2E passes (forge → approve → archive)

### Distribution
- [ ] `docker compose up` → Rorca accessible at http://localhost:3030
- [ ] `npm i -g rorca && rorca start` → opens browser
- [ ] `rorca init` → registers MCP globally
- [ ] GitHub Actions CI green on main branch

### Marketplace
- [ ] Publish spec from archive → appears in marketplace search
- [ ] Fork community spec → lands in forge/specs/pending/
- [ ] Sanitized spec contains zero API keys, emails, or home paths
