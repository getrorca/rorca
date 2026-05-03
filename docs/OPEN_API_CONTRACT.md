# Open API Contract

Stable public API surface for the open-source CLI.

| Method | Path | Parameters | Summary |
| --- | --- | --- | --- |
| DELETE | `/api/specs/{specId}/stories/{storyId}` | path:specId (required), path:storyId (required), query:workspaceId (required) | Remove a single story from a spec |
| GET | `/api/direction` | query:layer (required), query:workspaceId (optional) | Fetch a single direction layer |
| GET | `/api/health` | - | Health check |
| GET | `/api/pipeline/runs` | query:workspaceId (required) | List pipeline runs |
| GET | `/api/pipeline/runs/{runId}` | path:runId (required) | Get a pipeline run with story results |
| GET | `/api/pipeline/runs/{runId}/log` | path:runId (required) | Download raw pipeline log file |
| GET | `/api/recall` | query:workspaceId (required), query:category (optional), query:includeRuns (optional), query:includeHealth (optional), query:storyText (optional), query:query (optional), query:titlesOnly (optional) | Semantic workspace context recall — use when asking "what do we know about X?" or bootstrapping a session |
| GET | `/api/search` | query:q (required), query:type (optional), query:workspace (optional), query:limit (optional), query:mode (optional) | Cross-source semantic + keyword search — use when searching across specs, stories, AND memories together |
| GET | `/api/specs` | query:workspaceId (required), query:status (optional), query:tags (optional), query:reviewStatus (optional), query:assignee (optional) | List specs (pending/approved/all) |
| GET | `/api/specs/{specId}` | path:specId (required), query:workspaceId (required) | Get full spec detail |
| GET | `/api/specs/{specId}/diff` | path:specId (required), query:v1 (required), query:v2 (required) | Structured diff between two spec versions |
| GET | `/api/specs/{specId}/graph` | path:specId (required), query:workspaceId (required), query:runId (optional) | Get story dependency DAG |
| GET | `/api/specs/{specId}/versions` | path:specId (required) | List all versions for a spec |
| GET | `/api/specs/archive` | query:workspaceId (required), query:q (optional), query:status (optional), query:limit (optional), query:offset (optional), query:createdAfter (optional), query:createdBefore (optional), query:tags (optional) | Search spec archive with pagination |
| GET | `/api/specs/kanban` | query:workspaceId (required) | Get kanban board data for a workspace |
| GET | `/api/specs/search/stories` | query:workspaceId (required), query:q (required) | Cross-spec story search |
| GET | `/api/version` | - | Backend version and compatibility metadata |
| PATCH | `/api/specs/{specId}/stories/{storyId}` | path:specId (required), path:storyId (required), body:workspaceId (required), body:excluded (optional), body:title (optional), body:description (optional), body:acceptanceCriteria (optional) | Toggle story excluded flag or edit story fields |
| POST | `/api/direction/synthesize` | body:workspaceId (optional), body:l4SpecBrief (optional), body:l5Annotations (optional) | Synthesize direction stack with L4/L5 content |
| POST | `/api/pipeline/runs/{runId}/cancel` | path:runId (required) | Cancel a queued or running pipeline run |
| POST | `/api/pipeline/runs/{runId}/retry` | path:runId (required), body:storyIds (optional) | Retry failed stories in a pipeline run via pg-boss job queue |
| POST | `/api/pipeline/trigger` | body:specPath (required), body:workspaceId (required), body:autoWorktree (optional), body:autoMerge (optional), body:dryRun (optional), body:triggerType (optional), body:includeGraph (optional) | Trigger a pipeline run (spawn run-loop.sh) |
| POST | `/api/specs/{specId}/add-stories` | path:specId (required), body:workspaceId (required), body:count (optional), body:brief (optional) | Generate additional stories for an existing spec |
| POST | `/api/specs/{specId}/approve` | path:specId (required), body:workspaceId (required) | Approve a spec (move to approved/) |
| POST | `/api/specs/{specId}/reject` | path:specId (required), body:workspaceId (required), body:reason (optional) | Reject a spec (delete + preserve in WAL) |
| POST | `/api/specs/generate` | body:workspaceId (optional), body:title (optional), body:brief (required), body:storyCount (optional), body:model (optional), body:domain (optional), body:diagramTypes (optional), body:storyAnnotations (optional), body:templateId (optional), body:multiPass (optional), body:specBrief (optional), body:specName (optional), body:storyPrefix (optional) | Generate a spec from a plain-English brief |
| PUT | `/api/direction` | body:layer (required), body:workspaceId (optional), body:domain (optional), body:contentYaml (required), body:preferredModel (optional), body:skipValidation (optional) | Upsert a direction layer |
| PUT | `/api/specs/{specId}` | path:specId (required), body:workspaceId (required), body:model (optional), body:title (optional), body:_notes (optional), body:agentOverride (optional), body:thinkingEnabled (optional), body:thinkingBudget (optional), body:effortLevel (optional) | Update spec-level metadata |
