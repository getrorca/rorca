# Open API Contract

Stable public API surface for the open-source CLI.

Contract version: `1.0.0`

| Method | Path | Parameters | Hash |
| --- | --- | --- | --- |
| GET | `/api/direction` | query:layer (required), query:workspaceId (optional) | `sha256:37de364b3f90344970ad993f73e0f2219e39e25a2ffb6aee2418e0f65dfffbe7` |
| PUT | `/api/direction` | body:contentYaml (required), body:domain (optional), body:layer (required), body:preferredModel (optional), body:skipValidation (optional), body:workspaceId (optional) | `sha256:4e42d254170ffb19033989ac588090aad9aa68f2c07ddece726f79ef87a03f0e` |
| POST | `/api/direction/synthesize` | body:l4SpecBrief (optional), body:l5Annotations (optional), body:workspaceId (optional) | `sha256:ab4353f2a3ac535ce7500a755268a556bc29030597e7ae77933e8e20fac9966b` |
| GET | `/api/health` | - | `sha256:ab337ae0975c4f29316038da7c13a38835d2e2f850c152a66cae57b6505887c1` |
| GET | `/api/pipeline/runs` | query:workspaceId (required) | `sha256:589fed0adef7b6c4a26a13c733cb3ec514d6b7643a99c82ded0c361a5ab6dfb2` |
| GET | `/api/pipeline/runs/{runId}` | path:runId (required) | `sha256:adca321c41f73846ac4286d30cda0517df41cfd70b288e35e386975223910703` |
| POST | `/api/pipeline/runs/{runId}/cancel` | path:runId (required) | `sha256:ad6baae22c0e39dd86fef78bc70d6a748e644f8931b3e666db4e9790150b7da3` |
| GET | `/api/pipeline/runs/{runId}/log` | path:runId (required) | `sha256:46e8b2c0eace7e3cda5b3bf722724d4997719e6477091a3f280c98fe42142764` |
| POST | `/api/pipeline/runs/{runId}/retry` | body:storyIds (optional), path:runId (required) | `sha256:cb003aabe4c3b8b16a14c18b11f10433875ef8238c196459aca2a699da691433` |
| POST | `/api/pipeline/trigger` | body:autoMerge (optional), body:autoWorktree (optional), body:dryRun (optional), body:includeGraph (optional), body:specPath (required), body:triggerType (optional), body:workspaceId (required) | `sha256:94b93d0de2f6dbd2928622250adc956273ae26bf7e7ba59fa6961343dd3617ae` |
| GET | `/api/recall` | query:category (optional), query:includeHealth (optional), query:includeRuns (optional), query:query (optional), query:storyText (optional), query:titlesOnly (optional), query:workspaceId (required) | `sha256:9c5672c3fdf5e0ded65c40f03760271c48722f77158c6b46a87c99621e8d5a9a` |
| GET | `/api/search` | query:limit (optional), query:mode (optional), query:q (required), query:type (optional), query:workspace (optional) | `sha256:b406a36f3c6536b12cf8a241cca582e1ce8cf248977482867ccccc7214d447c9` |
| GET | `/api/specs` | query:assignee (optional), query:reviewStatus (optional), query:status (optional), query:tags (optional), query:workspaceId (required) | `sha256:02ec536526427bf8689fb4818779d6908f6ee3b5f4f26618bc486f8b180cbebc` |
| GET | `/api/specs/{specId}` | path:specId (required), query:workspaceId (required) | `sha256:063cf13384cec69b21d2a540393291d4bfc24ea38f8c57594430497a1872e092` |
| PUT | `/api/specs/{specId}` | body:_notes (optional), body:agentOverride (optional), body:effortLevel (optional), body:model (optional), body:thinkingBudget (optional), body:thinkingEnabled (optional), body:title (optional), body:workspaceId (required), path:specId (required) | `sha256:477ee504541596d9308264d7446f5258599d533cffbcfdffc36dbefe4b77cb02` |
| POST | `/api/specs/{specId}/add-stories` | body:brief (optional), body:count (optional), body:workspaceId (required), path:specId (required) | `sha256:712300315eb40ee66762777c67de5da3be6b475a86ea3e84ff380ed459414ee8` |
| POST | `/api/specs/{specId}/approve` | body:workspaceId (required), path:specId (required) | `sha256:e72a31f6cb205b120a1755bc8ef20ea217cf07d767a782f2c7813a5af95dd26b` |
| GET | `/api/specs/{specId}/diff` | path:specId (required), query:v1 (required), query:v2 (required) | `sha256:92319d3be10d5119838d2668e22c6deb569c4bd0b855d9e4d74caf717b772ff7` |
| GET | `/api/specs/{specId}/graph` | path:specId (required), query:runId (optional), query:workspaceId (required) | `sha256:5f3951e1822fe84a0d14786f30b72f2b2ab5167560de5321642d2ba94e33dfd3` |
| POST | `/api/specs/{specId}/reject` | body:reason (optional), body:workspaceId (required), path:specId (required) | `sha256:6901d3ffc83509333f87231e76ffbb6433b421e7352ed1cfb86a22a65844bb51` |
| DELETE | `/api/specs/{specId}/stories/{storyId}` | path:specId (required), path:storyId (required), query:workspaceId (required) | `sha256:cd974736eded5c4e718a7bffccdea1cffa832f086d2ece9cfab4fba42f5feba4` |
| PATCH | `/api/specs/{specId}/stories/{storyId}` | body:acceptanceCriteria (optional), body:description (optional), body:excluded (optional), body:title (optional), body:workspaceId (required), path:specId (required), path:storyId (required) | `sha256:e97391854a0aa7df5f794f8a352a468ee7be194b008b1dcaccf628d289a73aa8` |
| GET | `/api/specs/{specId}/versions` | path:specId (required) | `sha256:be92d4e232439f57f0d91499847c494c06ff60ce03c5e009b82a9cccd161d93c` |
| GET | `/api/specs/archive` | query:createdAfter (optional), query:createdBefore (optional), query:limit (optional), query:offset (optional), query:q (optional), query:status (optional), query:tags (optional), query:workspaceId (required) | `sha256:3367f1ddf810c83f7064c3370ae131f5b5623a57a6d04dd99f60210a1ad01150` |
| POST | `/api/specs/generate` | body:brief (required), body:diagramTypes (optional), body:domain (optional), body:model (optional), body:multiPass (optional), body:specBrief (optional), body:specName (optional), body:storyAnnotations (optional), body:storyCount (optional), body:storyPrefix (optional), body:templateId (optional), body:title (optional), body:workspaceId (optional) | `sha256:1413962803f0ae5cf41a2b4fa11d94cebf100f69141e737f6887fc62e39eddb9` |
| GET | `/api/specs/kanban` | query:workspaceId (required) | `sha256:ad95225e814086b251035ba4b8bd744a2fbaf81a43e96d9bc2fb2fd5e1bb5c56` |
| GET | `/api/specs/search/stories` | query:q (required), query:workspaceId (required) | `sha256:6292594de8bef5c8eab95de31ebb21a98557ecb8656e31066fa3b4dc2ec522f0` |
| GET | `/api/version` | - | `sha256:4a985e616092d83ff10cfcf7b3c873151122e6fe8fa33a91befa9addf9c54d79` |

