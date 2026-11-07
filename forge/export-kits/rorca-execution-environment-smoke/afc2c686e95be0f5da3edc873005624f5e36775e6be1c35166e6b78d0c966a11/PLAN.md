# Rorca Execution Environment Smoke Test — Delivery Plan

## Story order
1. **SMOKE-001 — Verify selected execution environment can perform a no-op repository-safe change**

## Dependencies
- No inter-story dependencies were declared.

## Verification
- SMOKE-001: The selected execution environment starts the configured agent without authentication or binary errors.
- SMOKE-001: The agent writes a timestamped smoke evidence markdown file under .rorca/smoke/.
- SMOKE-001: The evidence file records the environment name, agent name, current git branch, and validation command used.
- SMOKE-001: No product source files, migrations, secrets, deployment files, or workspace configuration are changed.
- SMOKE-001: A lightweight validation command such as git status --short completes successfully.

## Rollout
- No separate rollout procedure was declared.

## Rollback
- No separate rollback procedure was declared.
