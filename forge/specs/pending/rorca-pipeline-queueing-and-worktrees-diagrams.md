# rorca-pipeline-queueing-and-worktrees — Diagrams

Generated: 2026-03-17T19:26:23.932Z

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
  US-009["US-009"]
  US-010["US-010"]
  US-011["US-011"]
  US-012["US-012"]
  US-001 --> US-002
  US-002 --> US-003
  US-003 --> US-004
  US-003 --> US-005
  US-004 --> US-005
  US-001 --> US-006
  US-003 --> US-007
  US-004 --> US-007
  US-003 --> US-008
  US-007 --> US-008
  US-004 --> US-009
  US-007 --> US-009
  US-005 --> US-010
  US-008 --> US-011
  US-010 --> US-011
  US-005 --> US-012
  US-010 --> US-012
  US-011 --> US-012
```

### ASCII
```
US-001
  └─ US-002
    └─ US-003
      └─ US-004
        └─ US-005
          └─ US-010
            └─ US-011
              └─ US-012
        └─ US-007
          └─ US-008
          └─ US-009
  └─ US-006
```
