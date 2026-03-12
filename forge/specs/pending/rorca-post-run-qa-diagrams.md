# rorca-post-run-qa — Diagrams

Generated: 2026-03-12T06:26:42.557Z

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
  US-001 --> US-003
  US-002 --> US-003
  US-002 --> US-004
  US-002 --> US-005
  US-002 --> US-006
  US-002 --> US-007
  US-004 --> US-007
  US-002 --> US-008
  US-007 --> US-008
```

### ASCII
```
US-001
  └─ US-003
US-002
  └─ US-004
    └─ US-007
      └─ US-008
  └─ US-005
  └─ US-006
```
