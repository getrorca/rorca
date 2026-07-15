# Open API Contract

Stable public API surface for the open-source CLI.

Contract version: `2.0.0`

| Method | Path | Parameters | Hash |
| --- | --- | --- | --- |
| GET | `/api/analytics/ontology-health` | query:workspace_id (required) | `sha256:368d07d862002971e3e30fa3158c24fa37d7859ef9c561663564a13aa93b1a3e` |
| POST | `/api/context/enrich/async` | body:currentTask (optional), body:includeGraph (optional), body:maxTokens (optional), body:specId (required), body:storyId (optional), body:storyText (optional), body:workspaceId (required), query:mode (optional) | `sha256:b5c1cace78914b19d8f02753d4f22b1d34329130942aa3031224185a49351c91` |
| GET | `/api/context/health/{workspaceId}` | path:workspaceId (required) | `sha256:5b138e731e9b8a8537bc42fe2c7272ba47366f0282f15dffff729df31e0c53e8` |
| GET | `/api/direction` | query:layer (required), query:workspaceId (optional) | `sha256:37de364b3f90344970ad993f73e0f2219e39e25a2ffb6aee2418e0f65dfffbe7` |
| PUT | `/api/direction` | body:contentYaml (required), body:domain (optional), body:layer (required), body:preferredModel (optional), body:skipValidation (optional), body:workspaceId (optional) | `sha256:4e42d254170ffb19033989ac588090aad9aa68f2c07ddece726f79ef87a03f0e` |
| POST | `/api/direction/synthesize` | body:l4SpecBrief (optional), body:l5Annotations (optional), body:workspaceId (optional) | `sha256:ab4353f2a3ac535ce7500a755268a556bc29030597e7ae77933e8e20fac9966b` |
| GET | `/api/graph/stats` | - | `sha256:67d4045f25d255406761e8330744a3594264c4412921837ec8216f4ea76e2b55` |
| GET | `/api/health` | - | `sha256:7e6377c00dcc39b43b5ee72a3748d8238299b9497e892bc649d5f43ee4e15f6c` |
| GET | `/api/mcp/tools` | - | `sha256:cf01b2af54b29212534ae9119064951a1115503359aa8bb0e51f47981757965d` |
| GET | `/api/memory` | query:category (optional), query:limit (optional), query:workspaceId (required) | `sha256:608cefe732994ac87d10942235aed8ee90afa9276c49c649001547e4a98c7546` |
| POST | `/api/memory` | body:category (required), body:context (optional), body:relatedFiles (optional), body:rule (required), body:source (optional), body:sourceRunId (optional), body:sourceSpecId (optional), body:title (required), body:workspaceId (required) | `sha256:e4569960c6f8e24d96030581c4327dabcb8568f934383f011f398bd49a98f896` |
| GET | `/api/memory/categories` | - | `sha256:6ebbf548f212d100beb07e140f2a104f0de142b8500c9c9d22d0887a5ef9d20e` |
| GET | `/api/memory/context` | query:n (optional), query:workspaceId (required) | `sha256:12191e793eac57a89b68b6cc53b2319f714257d3baa16e71487b7c98b39878d0` |
| GET | `/api/memory/graph/neighborhood` | query:memoryId (required), query:workspaceId (required) | `sha256:9c741a16db6b08f7b55ba3ba58d9c0f9708f62b83f2a0c5ada47d9fa28f9a457` |
| GET | `/api/memory/graph/overview` | query:workspaceId (required) | `sha256:7c550b70784b0aa62ba52acb82a3a222aa71993f48be644c4971f09ece4ba102` |
| GET | `/api/memory/items` | query:category (optional), query:confidence (optional), query:limit (optional), query:page (optional), query:pinnedOnly (optional), query:search (optional), query:sourceRunId (optional), query:workspaceId (required) | `sha256:75d85559ce2dbe732ae68fbe609582e070fb2d9699623536ef5adddd04e68ce8` |
| GET | `/api/memory/relations` | query:includeInactive (optional), query:memoryId (optional), query:workspaceId (required) | `sha256:9507668e8d69d6bfec9f0c9bf84c6fc57c9cf1d2a0f3cbfd580c84cd525e8639` |
| POST | `/api/memory/relations` | body:note (optional), body:relationType (required), body:sourceMemoryId (required), body:targetMemoryId (required), body:workspaceId (required) | `sha256:f4b4056f927e20b438aba624ad6fd594d6a454e0fef03a2e7d3af80a6e597239` |
| DELETE | `/api/memory/relations/{id}` | body:workspaceId (required), path:id (required) | `sha256:8532844e52cbe133151175127ad509f2cb0edafd893296c865e709020033b9b9` |
| PATCH | `/api/memory/relations/{id}` | body:status (required), body:workspaceId (required), path:id (required) | `sha256:91614b58a6079c45f9322e2a2dfa008ac47f3a4bee51eee5909294308bae3a6c` |
| GET | `/api/memory/review` | query:workspaceId (required) | `sha256:63b32011fe10f254210b4a0050fd3c7b27f8f94c4fcb454e4b9e4ab46328a181` |
| POST | `/api/memory/review/{id}/action` | body:action (required), body:workspaceId (required), path:id (required) | `sha256:05178c17f8f5f366c095540d5670dbe112e2d4405f37de5e4009ee4e048154b7` |
| GET | `/api/pipeline/runs` | query:workspaceId (required) | `sha256:589fed0adef7b6c4a26a13c733cb3ec514d6b7643a99c82ded0c361a5ab6dfb2` |
| GET | `/api/pipeline/runs/{runId}` | path:runId (required) | `sha256:1d9fd9ce8c77d46480d9d99e428081fadc9728d30081b11cb3d8840cdb1a42fc` |
| POST | `/api/pipeline/runs/{runId}/cancel` | path:runId (required) | `sha256:ad6baae22c0e39dd86fef78bc70d6a748e644f8931b3e666db4e9790150b7da3` |
| GET | `/api/pipeline/runs/{runId}/context-trace/{rawRef}` | path:rawRef (required), path:runId (required) | `sha256:d69339acbddc4e82ede5e2cde4ba9a002cf60e7335f2f4a67485786df96014f3` |
| GET | `/api/pipeline/runs/{runId}/log` | path:runId (required) | `sha256:46e8b2c0eace7e3cda5b3bf722724d4997719e6477091a3f280c98fe42142764` |
| GET | `/api/pipeline/runs/{runId}/retrieval-telemetry/{telemetryId}` | path:runId (required), path:telemetryId (required) | `sha256:79a73a02d19c6bedd4af114f4e25cd55bd631d570264d276f3a0b952472e6d1d` |
| POST | `/api/pipeline/runs/{runId}/retry` | body:forceSequential (optional), body:storyIds (optional), path:runId (required) | `sha256:719233bff39bb836289f4d0b4477bf43690765ca36cb48de49dd9173e75abed9` |
| POST | `/api/pipeline/trigger` | body:agentOverride (optional), body:autoMerge (optional), body:autoWorktree (optional), body:dryRun (optional), body:effortLevel (optional), body:forceRerun (optional), body:includeGraph (optional), body:mergeStrategy (optional), body:modelOverride (optional), body:readinessOverride (optional), body:rerunFromScratch (optional), body:specPath (required), body:storyId (optional), body:terminal_mode (optional), body:thinkingBudget (optional), body:thinkingEnabled (optional), body:triggerType (optional), body:workspaceId (required) | `sha256:6a1d07a2c549282eafd4840997bbfa68d8ed41815cf0e13d654d89d2f02361b9` |
| GET | `/api/recall` | query:category (optional), query:includeHealth (optional), query:includeRuns (optional), query:query (optional), query:storyText (optional), query:titlesOnly (optional), query:workspaceId (required) | `sha256:9c5672c3fdf5e0ded65c40f03760271c48722f77158c6b46a87c99621e8d5a9a` |
| GET | `/api/search` | query:limit (optional), query:mode (optional), query:q (required), query:type (optional), query:workspace (optional) | `sha256:b406a36f3c6536b12cf8a241cca582e1ce8cf248977482867ccccc7214d447c9` |
| GET | `/api/spec-jobs/{jobId}` | path:jobId (required) | `sha256:597f1ad267d45ea8ad6293c47ab8bfe02f2026c4a626e8714a3a5deba7b9a57d` |
| POST | `/api/spec-jobs/{jobId}/cancel` | path:jobId (required) | `sha256:f9ef69141e8645f03541115ffb30420606d23f0dd5cbce5adca1523c8057c6a7` |
| GET | `/api/spec-jobs/{jobId}/stream` | path:jobId (required) | `sha256:8263ea3c1595d7e08bbcf5b30ffeb722aca498657024b1d2386378d9f866a13e` |
| GET | `/api/spec-relevance-graph` | query:maxEdges (optional), query:maxFiles (optional), query:maxMemories (optional), query:retrievalTelemetryId (optional), query:runId (optional), query:specSlug (optional), query:storyId (optional), query:workspaceId (required) | `sha256:2e2c6eba93dab90d9c4ad5502dc31570ed4f08d07fd36388826f60e63235e644` |
| GET | `/api/spec-relevance-graph/by-run/{runId}` | path:runId (required), query:maxEdges (optional), query:maxFiles (optional), query:maxMemories (optional) | `sha256:5bacc2f8db99a3336aa9b888dcaede710b475709abf76430168500b1fc5cfc50` |
| GET | `/api/spec-relevance-graph/by-spec/{specSlug}` | path:specSlug (required), query:maxEdges (optional), query:maxFiles (optional), query:maxMemories (optional), query:storyId (optional), query:workspaceId (required) | `sha256:bd55ffedd77fd8f0890d225e20b6beebf335dae81d32a2245954a243260e15ca` |
| GET | `/api/specs` | query:assignee (optional), query:reviewStatus (optional), query:status (optional), query:tags (optional), query:workspaceId (required) | `sha256:02ec536526427bf8689fb4818779d6908f6ee3b5f4f26618bc486f8b180cbebc` |
| GET | `/api/specs/{specId}` | path:specId (required), query:workspaceId (required) | `sha256:063cf13384cec69b21d2a540393291d4bfc24ea38f8c57594430497a1872e092` |
| PUT | `/api/specs/{specId}` | body:_notes (optional), body:agentOverride (optional), body:effortLevel (optional), body:model (optional), body:thinkingBudget (optional), body:thinkingEnabled (optional), body:title (optional), body:workspaceId (required), path:specId (required) | `sha256:72471165a9b1df476f4ef0ff3715f518f4b3b31367092af338d761a2d714c8f3` |
| POST | `/api/specs/{specId}/add-stories` | body:brief (optional), body:count (optional), body:workspaceId (required), path:specId (required) | `sha256:712300315eb40ee66762777c67de5da3be6b475a86ea3e84ff380ed459414ee8` |
| POST | `/api/specs/{specId}/approve` | body:readinessOverride (optional), body:workspaceId (required), path:specId (required) | `sha256:c1559e4cfceab749f9fe0fce76661f431c9f82c4d9ea17a4434b447d8503c4d4` |
| GET | `/api/specs/{specId}/diff` | path:specId (required), query:v1 (required), query:v2 (required) | `sha256:92319d3be10d5119838d2668e22c6deb569c4bd0b855d9e4d74caf717b772ff7` |
| POST | `/api/specs/{specId}/enrich` | body:model (optional), body:workspaceId (required), path:specId (required) | `sha256:c6f6238e10ecc77d1f77a2042eb4ece190637aa10b0ff92b71fbb0fe15e0db56` |
| POST | `/api/specs/{specId}/enrich/async` | body:workspaceId (required), path:specId (required) | `sha256:52000008af35bff0be2de98778a20f70b04689e1951b4e7d99f5a78a09702523` |
| GET | `/api/specs/{specId}/generation-log` | path:specId (required), query:all (optional) | `sha256:f9ea1489e1297a0004b0de2270790a8dfddfa209b9261ef84939edf6b2829be5` |
| GET | `/api/specs/{specId}/graph` | path:specId (required), query:runId (optional), query:workspaceId (required) | `sha256:5f3951e1822fe84a0d14786f30b72f2b2ab5167560de5321642d2ba94e33dfd3` |
| GET | `/api/specs/{specId}/knowledge-graph` | path:specId (required), query:workspaceId (optional) | `sha256:9ca9be14fa1ebb2627a8fc9a925b47fa3eba47f18c54888ebbfefa215eda2fe9` |
| POST | `/api/specs/{specId}/match-skills/async` | body:workspaceId (required), path:specId (required) | `sha256:826290476753f2b3d269e45008c6dea6bb692954a37125acd10a42ff053f806a` |
| GET | `/api/specs/{specId}/readiness` | path:specId (required), query:workspaceId (required) | `sha256:adc4c5ead1e81fed2ad43de9b916de45394846f1fffbd754ab9c8a74532e19ac` |
| POST | `/api/specs/{specId}/reject` | body:reason (optional), body:workspaceId (required), path:specId (required) | `sha256:6901d3ffc83509333f87231e76ffbb6433b421e7352ed1cfb86a22a65844bb51` |
| DELETE | `/api/specs/{specId}/stories/{storyId}` | path:specId (required), path:storyId (required), query:workspaceId (required) | `sha256:cd974736eded5c4e718a7bffccdea1cffa832f086d2ece9cfab4fba42f5feba4` |
| PATCH | `/api/specs/{specId}/stories/{storyId}` | body:acceptanceCriteria (optional), body:description (optional), body:excluded (optional), body:title (optional), body:workspaceId (required), path:specId (required), path:storyId (required) | `sha256:e97391854a0aa7df5f794f8a352a468ee7be194b008b1dcaccf628d289a73aa8` |
| POST | `/api/specs/{specId}/suggest-skills/async` | body:workspaceId (required), path:specId (required) | `sha256:0239d8b581a63b4e22fe8c02498f878caaec4c725072a03c235341a507af6332` |
| GET | `/api/specs/{specId}/versions` | path:specId (required) | `sha256:be92d4e232439f57f0d91499847c494c06ff60ce03c5e009b82a9cccd161d93c` |
| GET | `/api/specs/{specId}/workflow` | path:specId (required), query:workspaceId (required) | `sha256:9f278562e4c9e6b45519a0078de1e517418a82aa30d0c2148db4231dfbce960b` |
| GET | `/api/specs/archive` | query:createdAfter (optional), query:createdBefore (optional), query:limit (optional), query:offset (optional), query:q (optional), query:status (optional), query:tags (optional), query:workspaceId (required) | `sha256:3367f1ddf810c83f7064c3370ae131f5b5623a57a6d04dd99f60210a1ad01150` |
| POST | `/api/specs/forge` | body:agentOverride (optional), body:brief (required), body:diagramTypes (optional), body:domain (optional), body:model (optional), body:postSave (optional), body:reasoning (optional), body:specBrief (optional), body:specName (optional), body:storyAnnotations (optional), body:storyCount (optional), body:storyPrefix (optional), body:templateId (optional), body:thinkingBudget (optional), body:thinkingEnabled (optional), body:title (optional), body:workspaceId (required) | `sha256:076bb9dfe0469274161128e71cef2c3774164f5f54be3da6a7d5dce64c2d608d` |
| POST | `/api/specs/forge/batch` | body:briefs (required) | `sha256:3ae1b496a12bf1b32b7c786443314c736ef7b35dcbdce75d41742a5c6dda3cdf` |
| GET | `/api/specs/forge/batch/{batchId}` | path:batchId (required) | `sha256:a4c58cb77c578bf7d921abaf5d54dc251426b37d4aa894d1c940709e0b78f177` |
| GET | `/api/specs/forge/batch/{batchId}/stream` | path:batchId (required) | `sha256:e2ba07b5e756fde762aec9d930c89e444abc2cbe6c58d7267cbb3fc5d55d8f9d` |
| POST | `/api/specs/generate` | body:agentOverride (optional), body:brief (required), body:diagramTypes (optional), body:domain (optional), body:model (optional), body:multiPass (optional), body:postSave (optional), body:specBrief (optional), body:specName (optional), body:storyAnnotations (optional), body:storyCount (optional), body:storyPrefix (optional), body:templateId (optional), body:title (optional), body:workspaceId (optional) | `sha256:20faeb7bc10b77ff74cf47c4e234ceddc0847320c459f694932480f74e7d47b9` |
| POST | `/api/specs/generation-context` | body:agentOverride (optional), body:brief (required), body:diagramTypes (optional), body:domain (optional), body:model (optional), body:reasoning (optional), body:specBrief (optional), body:specName (optional), body:storyAnnotations (optional), body:storyCount (optional), body:storyPrefix (optional), body:templateId (optional), body:thinkingBudget (optional), body:thinkingEnabled (optional), body:title (optional), body:workspaceId (required) | `sha256:a4554a6475d69149a6952071fc2a0dc3fa942c2be3153245bae5eabaebb9d765` |
| GET | `/api/specs/kanban` | query:workspaceId (required) | `sha256:9f84bb5a68775b52dee3aed8df2624e7adb5867f4451f3593d3600055ea6f781` |
| POST | `/api/specs/persist` | body:brief (optional), body:contextSummary (optional), body:contextUsed (optional), body:overwrite (optional), body:policyPresetId (optional), body:postSave (optional), body:postSavePolicy (optional), body:slug (optional), body:source (optional), body:specBrief (optional), body:stories (required), body:storyPrefix (optional), body:title (required), body:userStories (optional), body:workspaceId (required) | `sha256:b88fae37b212d8c85626d8d138e8bcfdb9855ec922c4ce2a2e94b2b39a8f4870` |
| GET | `/api/specs/repair-candidates` | query:category (optional), query:limit (optional), query:workspaceId (required) | `sha256:370f4bd1f6d1986f822dc51b1575191fee28d0c0b167a894d71db795e8c434db` |
| GET | `/api/specs/search/stories` | query:q (required), query:workspaceId (required) | `sha256:6292594de8bef5c8eab95de31ebb21a98557ecb8656e31066fa3b4dc2ec522f0` |
| GET | `/api/version` | - | `sha256:580155644cbfddc9b3efa50861d1c011a29c2930c73dabbf45fdb8265de30f95` |

