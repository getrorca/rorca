# Open API Contract

Stable public API surface for the open-source CLI.

| Method | Path | Parameters | Summary |
| --- | --- | --- | --- |
| DELETE | `/api/memory/relations/{id}` | path:id (required), body:workspaceId (required) | Soft-delete a memory relation while preserving audit history |
| DELETE | `/api/specs/{specId}/stories/{storyId}` | path:specId (required), path:storyId (required), query:workspaceId (required) | Remove a single story from a spec |
| GET | `/api/analytics/ontology-health` | query:workspace_id (required) | Get bounded ontology health analytics |
| GET | `/api/candidates` | query:workspace_id (required), query:status (optional), query:source_system (optional), query:category (optional), query:confidence (optional), query:trust_tier (optional), query:search (optional), query:date_from (optional), query:date_to (optional), query:page (optional), query:limit (optional) | List memory candidates with pagination and filters |
| GET | `/api/candidates/{id}` | path:id (required) | Get a single memory candidate with full provenance |
| GET | `/api/context-events/health` | - | Capture sidecar health check |
| GET | `/api/context/health/{workspaceId}` | path:workspaceId (required) | Get workspace context readiness/health summary |
| GET | `/api/direction` | query:layer (required), query:workspaceId (optional) | Fetch a single direction layer |
| GET | `/api/graph/stats` | - | Get knowledge graph statistics |
| GET | `/api/health` | - | Health check |
| GET | `/api/health/detailed` | - | Detailed health check with extended metrics |
| GET | `/api/mcp/tools` | - | List all live Rorca MCP tools |
| GET | `/api/memory` | query:workspaceId (required), query:category (optional), query:limit (optional) | List memory entries for a workspace |
| GET | `/api/memory/categories` | - | List available memory categories |
| GET | `/api/memory/context` | query:workspaceId (required), query:n (optional) | Get memory context snippet for agent prompt injection |
| GET | `/api/memory/graph/neighborhood` | query:workspaceId (required), query:memoryId (required) | Get a bounded selected-memory neighborhood graph |
| GET | `/api/memory/graph/overview` | query:workspaceId (required) | Get a bounded workspace memory ontology overview graph |
| GET | `/api/memory/items` | query:workspaceId (required), query:category (optional), query:confidence (optional), query:sourceRunId (optional), query:search (optional), query:pinnedOnly (optional), query:limit (optional), query:page (optional) | Paginated memory list — use for browsing, filtering, or "show me the last N memories" |
| GET | `/api/memory/relations` | query:workspaceId (required), query:memoryId (optional), query:includeInactive (optional) | List memory-to-memory ontology relations |
| GET | `/api/memory/review` | query:workspaceId (required) | List bounded stale-memory review, provenance cleanup, and hotspot summaries |
| GET | `/api/pipeline/runs` | query:workspaceId (required) | List pipeline runs |
| GET | `/api/pipeline/runs/{runId}` | path:runId (required) | Get a pipeline run with story results |
| GET | `/api/pipeline/runs/{runId}/context-trace/{rawRef}` | path:runId (required), path:rawRef (required) | Resolve a context-trace raw payload by rawRef |
| GET | `/api/pipeline/runs/{runId}/log` | path:runId (required) | Download raw pipeline log file |
| GET | `/api/pipeline/runs/{runId}/output` | path:runId (required) | Stream raw terminal output (SSE) |
| GET | `/api/pipeline/runs/{runId}/retrieval-telemetry/{telemetryId}` | path:runId (required), path:telemetryId (required) | Resolve retrieval telemetry details for a specific telemetry event |
| GET | `/api/recall` | query:workspaceId (required), query:category (optional), query:includeRuns (optional), query:includeHealth (optional), query:storyText (optional), query:query (optional), query:titlesOnly (optional) | Semantic workspace context recall — use when asking "what do we know about X?" or bootstrapping a session |
| GET | `/api/retrieval-traces` | query:workspaceId (required), query:limit (optional), query:offset (optional) | List retrieval traces for a workspace |
| GET | `/api/retrieval-traces/{traceId}` | path:traceId (required) | Retrieve a retrieval trace by ID |
| GET | `/api/search` | query:q (required), query:type (optional), query:workspace (optional), query:limit (optional), query:mode (optional) | Cross-source semantic + keyword search — use when searching across specs, stories, AND memories together |
| GET | `/api/spec-jobs/{jobId}` | path:jobId (required) | Get a spec async job by ID |
| GET | `/api/spec-jobs/{jobId}/stream` | path:jobId (required) | Stream a spec async job over SSE |
| GET | `/api/spec-relevance-graph` | query:workspaceId (required), query:specSlug (optional), query:storyId (optional), query:runId (optional), query:retrievalTelemetryId (optional), query:maxFiles (optional), query:maxMemories (optional), query:maxEdges (optional) | Get spec-centric memory relevance graph |
| GET | `/api/spec-relevance-graph/by-run/{runId}` | path:runId (required), query:maxFiles (optional), query:maxMemories (optional), query:maxEdges (optional) | Get spec-centric memory relevance graph scoped to a pipeline run |
| GET | `/api/spec-relevance-graph/by-spec/{specSlug}` | path:specSlug (required), query:workspaceId (required), query:storyId (optional), query:maxFiles (optional), query:maxMemories (optional), query:maxEdges (optional) | Get spec-centric memory relevance graph scoped to a spec |
| GET | `/api/specs` | query:workspaceId (required), query:status (optional), query:tags (optional), query:reviewStatus (optional), query:assignee (optional) | List specs (pending/approved/all) |
| GET | `/api/specs/{specId}` | path:specId (required), query:workspaceId (required) | Get full spec detail |
| GET | `/api/specs/{specId}/diff` | path:specId (required), query:v1 (required), query:v2 (required) | Structured diff between two spec versions |
| GET | `/api/specs/{specId}/generation-log` | path:specId (required), query:all (optional) | Get generation log for a spec |
| GET | `/api/specs/{specId}/graph` | path:specId (required), query:workspaceId (required), query:runId (optional) | Get story dependency DAG |
| GET | `/api/specs/{specId}/knowledge-graph` | path:specId (required), query:workspaceId (optional) | Get knowledge graph data for a spec |
| GET | `/api/specs/{specId}/readiness` | path:specId (required), query:workspaceId (required) | Inspect execution readiness for a spec |
| GET | `/api/specs/{specId}/versions` | path:specId (required) | List all versions for a spec |
| GET | `/api/specs/{specId}/workflow` | path:specId (required), query:workspaceId (required) | Inspect durable post-save workflow state for a spec |
| GET | `/api/specs/archive` | query:workspaceId (required), query:q (optional), query:status (optional), query:limit (optional), query:offset (optional), query:createdAfter (optional), query:createdBefore (optional), query:tags (optional) | Search spec archive with pagination |
| GET | `/api/specs/forge/batch/{batchId}` | path:batchId (required) | Get batch generation status |
| GET | `/api/specs/forge/batch/{batchId}/stream` | path:batchId (required) | SSE stream for batch generation progress |
| GET | `/api/specs/kanban` | query:workspaceId (required) | Get kanban board data for a workspace |
| GET | `/api/specs/repair-candidates` | query:workspaceId (required), query:category (optional), query:limit (optional) | List specs that are candidates for repair in a workspace |
| GET | `/api/specs/search/stories` | query:workspaceId (required), query:q (required) | Cross-spec story search |
| GET | `/api/version` | - | Backend version and compatibility metadata |
| GET | `/api/workspaces/{workspaceId}/hydration` | path:workspaceId (required) | Get Hilo hydration status for a workspace |
| PATCH | `/api/memory/relations/{id}` | path:id (required), body:workspaceId (required), body:status (required) | Update a memory relation lifecycle state |
| PATCH | `/api/specs/{specId}/stories/{storyId}` | path:specId (required), path:storyId (required), body:workspaceId (required), body:excluded (optional), body:title (optional), body:description (optional), body:acceptanceCriteria (optional) | Toggle story excluded flag or edit story fields |
| POST | `/api/candidates` | body:workspace_id (required), body:source_system (required), body:category (required), body:title (required), body:rule (required), body:context (optional), body:related_files (optional), body:confidence (optional), body:trust_tier (optional), body:source_ref (optional), body:context_event_id (optional), body:idempotency_key (required), body:schema_version (optional), body:metadata (optional) | Ingest a reviewable memory candidate from a capture sidecar or external tool |
| POST | `/api/candidates/{id}/approve` | path:id (required), body:reviewer (optional), body:review_note (optional), body:category (optional), body:title (optional), body:rule (optional), body:context (optional), body:related_files (optional), body:confidence (optional), body:trust_tier (optional) | Approve a memory candidate and promote it to durable memory |
| POST | `/api/candidates/{id}/mark-duplicate` | path:id (required), body:reviewer (optional), body:review_note (optional), body:duplicate_of_candidate_id (optional) | Mark a memory candidate as a duplicate of another |
| POST | `/api/candidates/{id}/mark-superseded` | path:id (required), body:reviewer (optional), body:review_note (optional) | Mark a memory candidate as superseded |
| POST | `/api/candidates/{id}/reject` | path:id (required), body:reviewer (optional), body:review_note (optional) | Reject a memory candidate |
| POST | `/api/candidates/{id}/revisit` | path:id (required), body:reviewer (optional), body:review_note (optional) | Reopen a rejected, duplicate, or superseded candidate for review |
| POST | `/api/context-events/candidates` | body:candidate (optional) | Submit a memory candidate (idempotent) |
| POST | `/api/context-events/events` | body:event (optional) | Submit a context event (idempotent) |
| POST | `/api/context-events/flush` | body:entries (optional) | Batch flush queued events and candidates (idempotent) |
| POST | `/api/context/enrich/async` | query:mode (optional), body:workspaceId (required), body:specId (required), body:storyId (optional), body:currentTask (optional), body:storyText (optional), body:maxTokens (optional), body:includeGraph (optional) | Queue async shared context enrichment for MCP and Pi clients |
| POST | `/api/context/retrieve` | body:workspaceId (required), body:brief (required), body:budget (optional), body:maxCandidates (optional), body:maxFiles (optional), body:maxDepth (optional), body:maxExcerpts (optional), body:includeGraph (optional), body:freshness (optional) | Brief-aware context retrieval — seed retrieval, ranking, excerpting, trace persistence |
| POST | `/api/diagnostics/capture-status` | body:workspaceId (required), body:apiReachable (optional), body:localQueueDepth (optional), body:lastFlushAt (optional), body:lastFlushSucceeded (optional), body:lastFlushFailed (optional), body:gitHead (optional), body:hookInstalled (optional), body:daemonRunning (optional), body:daemonPid (optional), body:lastError (optional), body:lastErrorAt (optional) | Report capture sidecar status (called by rorca-capture daemon) |
| POST | `/api/direction/synthesize` | body:workspaceId (optional), body:l4SpecBrief (optional), body:l5Annotations (optional) | Synthesize direction stack with L4/L5 content |
| POST | `/api/events` | body:workspace_id (required), body:source_system (required), body:event_type (required), body:occurred_at (required), body:summary (optional), body:payload (optional), body:actor (optional), body:source_ref (optional), body:idempotency_key (required), body:schema_version (optional) | Ingest a raw context event from a capture sidecar or external tool |
| POST | `/api/memory` | body:workspaceId (required), body:category (required), body:title (required), body:rule (required), body:context (optional), body:source (optional), body:sourceSpecId (optional), body:sourceRunId (optional), body:relatedFiles (optional) | Append a new memory entry |
| POST | `/api/memory/relations` | body:workspaceId (required), body:sourceMemoryId (required), body:targetMemoryId (required), body:relationType (required), body:note (optional) | Create or restore a canonical memory-to-memory ontology relation |
| POST | `/api/memory/review/{id}/action` | path:id (required), body:workspaceId (required), body:action (required) | Audit and apply a memory review or provenance cleanup action |
| POST | `/api/pipeline/runs/{runId}/cancel` | path:runId (required) | Cancel a queued or running pipeline run |
| POST | `/api/pipeline/runs/{runId}/input` | path:runId (required), body:dataBase64 (required) | Send keyboard input to the live PTY for a running pipeline run |
| POST | `/api/pipeline/runs/{runId}/pty/resize` | path:runId (required), body:cols (required), body:rows (required) | Resize the live PTY terminal for a running pipeline run |
| POST | `/api/pipeline/runs/{runId}/retry` | path:runId (required), body:storyIds (optional), body:forceSequential (optional) | Retry failed stories in a pipeline run via pg-boss job queue |
| POST | `/api/pipeline/trigger` | body:specPath (required), body:workspaceId (required), body:autoWorktree (optional), body:autoMerge (optional), body:mergeStrategy (optional), body:dryRun (optional), body:triggerType (optional), body:includeGraph (optional), body:agentOverride (optional), body:modelOverride (optional), body:storyId (optional), body:thinkingEnabled (optional), body:thinkingBudget (optional), body:effortLevel (optional), body:forceRerun (optional), body:rerunFromScratch (optional), body:readinessOverride (optional), body:terminal_mode (optional), body:executionEnvironment (optional) | Trigger a pipeline run (spawn run-loop.sh) |
| POST | `/api/retrieval-traces` | body:traceId (required), body:workspaceId (required), body:briefHash (required), body:gitSha (optional), body:policy (optional), body:graphMode (optional), body:degraded (optional), body:candidates (required), body:tokenEstimate (optional), body:specLogId (optional) | Persist a retrieval trace (idempotent) |
| POST | `/api/spec-jobs/{jobId}/cancel` | path:jobId (required) | Cancel a spec async job |
| POST | `/api/specs/{specId}/add-stories` | path:specId (required), body:workspaceId (required), body:count (optional), body:brief (optional) | Generate additional stories for an existing spec |
| POST | `/api/specs/{specId}/approve` | path:specId (required), body:workspaceId (required), body:readinessOverride (optional) | Approve a spec (move to approved/) |
| POST | `/api/specs/{specId}/enrich` | path:specId (required), body:workspaceId (required), body:model (optional) | Retroactively enrich a spec's user stories with contextual L5 annotations |
| POST | `/api/specs/{specId}/enrich/async` | path:specId (required), body:workspaceId (required) | Queue an async enrichment job for a spec |
| POST | `/api/specs/{specId}/match-skills/async` | path:specId (required), body:workspaceId (required) | Queue an async skill-matching job for a spec |
| POST | `/api/specs/{specId}/reject` | path:specId (required), body:workspaceId (required), body:reason (optional) | Reject a spec (delete + preserve in WAL) |
| POST | `/api/specs/{specId}/suggest-skills/async` | path:specId (required), body:workspaceId (required) | Queue an async skill-suggestion job for a spec |
| POST | `/api/specs/context-preview` | body:workspaceId (required), body:brief (required), body:model (optional), body:templateId (optional) | Preview context sources before spec creation |
| POST | `/api/specs/forge` | body:workspaceId (required), body:brief (required), body:specBrief (optional), body:title (optional), body:specName (optional), body:domain (optional), body:diagramTypes (optional), body:storyAnnotations (optional), body:templateId (optional), body:storyCount (optional), body:model (optional), body:agentOverride (optional), body:storyPrefix (optional), body:thinkingEnabled (optional), body:thinkingBudget (optional), body:reasoning (optional), body:postSave (optional) | Run the shared skill-first forge workflow |
| POST | `/api/specs/forge/batch` | body:briefs (required) | Queue multiple briefs for sequential skill-first forge |
| POST | `/api/specs/generate` | body:workspaceId (optional), body:title (optional), body:brief (required), body:storyCount (optional), body:model (optional), body:domain (optional), body:diagramTypes (optional), body:storyAnnotations (optional), body:templateId (optional), body:multiPass (optional), body:specBrief (optional), body:specName (optional), body:agentOverride (optional), body:storyPrefix (optional), body:postSave (optional) | Generate a spec from a plain-English brief (legacy compatibility endpoint) |
| POST | `/api/specs/generation-context` | body:workspaceId (required), body:brief (required), body:specBrief (optional), body:title (optional), body:specName (optional), body:domain (optional), body:diagramTypes (optional), body:storyAnnotations (optional), body:templateId (optional), body:storyCount (optional), body:model (optional), body:agentOverride (optional), body:storyPrefix (optional), body:thinkingEnabled (optional), body:thinkingBudget (optional), body:reasoning (optional) | Build a skill-first forge context bundle |
| POST | `/api/specs/persist` | body:workspaceId (required), body:title (required), body:slug (optional), body:brief (optional), body:specBrief (optional), body:storyPrefix (optional), body:stories (required), body:userStories (optional), body:overwrite (optional), body:source (optional), body:contextUsed (optional), body:contextSummary (optional), body:postSave (optional), body:policyPresetId (optional), body:postSavePolicy (optional) | Persist an explicit caller-drafted spec |
| POST | `/api/workspaces/{workspaceId}/hydration` | path:workspaceId (required), body:types (optional) | Trigger Hilo hydration for a workspace (idempotent) |
| PUT | `/api/direction` | body:layer (required), body:workspaceId (optional), body:domain (optional), body:contentYaml (required), body:preferredModel (optional), body:skipValidation (optional) | Upsert a direction layer |
| PUT | `/api/specs/{specId}` | path:specId (required), body:workspaceId (required), body:model (optional), body:title (optional), body:_notes (optional), body:agentOverride (optional), body:thinkingEnabled (optional), body:thinkingBudget (optional), body:effortLevel (optional) | Update spec-level metadata |
