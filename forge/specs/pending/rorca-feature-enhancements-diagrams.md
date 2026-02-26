# rorca-feature-enhancements — Diagrams

Generated: 2026-02-22T09:31:45.570Z

## architecture

### Mermaid
```mermaid
graph TB
  Client[Frontend Client]
  API[Express API Server]
  DB[(SQLite DB)]
  LLM[Claude CLI]
  FS[File System]
  SSE[SSE Hub]

  Client --> API
  API --> DB
  API --> LLM
  API --> FS
  API --> SSE
  SSE --> Client

  subgraph "Enhanced Modules"
    SpecForge[Spec Forge + Templates + Multi-Model]
    DiffEngine[Diff Engine + Versioning]
    Search[Full-Text Search]
    Pipeline[Pipeline + Selective Retry]
    DAG[Dependency DAG]
    Batch[Batch Queue]
    Validator[Stack Validator]
  end

  API --> SpecForge
  API --> DiffEngine
  API --> Search
  API --> Pipeline
  API --> DAG
  API --> Batch
  API --> Validator

  SpecForge --> LLM
  SpecForge --> FS
  DiffEngine --> DB
  Search --> DB
  Pipeline --> FS
  Batch --> SpecForge
```

### ASCII
```
┌─────────────┐     ┌──────────────────┐     ┌──────────┐
│   Frontend   │────▶│  Express API     │────▶│ SQLite   │
│   Client     │◀────│  Server          │     │ Database │
└─────────────┘ SSE  ├──────────────────┤     └──────────┘
                     │ Enhanced Modules: │     ┌──────────┐
                     │ • Spec Forge     │────▶│ Claude   │
                     │ • Diff Engine    │     │ CLI      │
                     │ • Search         │     └──────────┘
                     │ • Pipeline Retry │     ┌──────────┐
                     │ • DAG Visualizer │────▶│ File     │
                     │ • Batch Queue    │     │ System   │
                     │ • Stack Validator│     └──────────┘
                     └──────────────────┘
```

## userFlow

### Mermaid
```mermaid
sequenceDiagram
  participant Dev as Developer
  participant UI as Frontend
  participant API as Backend API
  participant LLM as Claude CLI
  participant DB as SQLite

  Dev->>UI: Write spec brief
  UI->>API: POST /specs/generate (model, template)
  API->>LLM: Generate with selected model
  LLM-->>API: Spec JSON
  API->>DB: Store spec + version
  API-->>UI: Spec with cost estimate

  Dev->>UI: View diff vs previous version
  UI->>API: GET /specs/:id/diff
  API-->>UI: Structured diff

  Dev->>UI: Approve spec
  UI->>API: POST /specs/:id/approve
  API->>DB: Move to approved

  Dev->>UI: Start pipeline
  UI->>API: POST /pipeline/runs
  API-->>UI: SSE stream updates

  Dev->>UI: Retry failed stories only
  UI->>API: POST /pipeline/runs/:id/retry
  API-->>UI: SSE retry events
```

### ASCII
```
Developer ──▶ Write Brief ──▶ Generate Spec (choose model)
                                    │
                              ┌─────▼─────┐
                              │ Compare    │
                              │ Versions   │──▶ View Diff
                              └─────┬─────┘
                                    │
                              ┌─────▼─────┐
                              │ Approve /  │
                              │ Reject     │
                              └─────┬─────┘
                                    │
                              ┌─────▼─────┐
                              │ Pipeline   │
                              │ Execute    │
                              └─────┬─────┘
                                    │
                              ┌─────▼─────┐
                              │ Retry      │
                              │ Failed     │
                              └─────┘
```

## storyDeps

### Mermaid
```mermaid
graph LR
  US-001["US-001"]
  US-002["US-002"]
  US-003["US-003"]
  US-004["US-004"]
  US-005["US-005"]
  US-006["US-006"]
  US-007["US-007"]
  US-008["US-008"]
  US-003 --> US-008
```

### ASCII
```
US-001
US-002
US-003
  └─ US-008
US-004
US-005
US-006
US-007
```
