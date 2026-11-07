# Rorca Execution Environment Smoke Test — Product Requirements

## Problem
Deliver the behavior defined by the canonical Rorca Execution Environment Smoke Test specification.

## Target users
- No target-user segment was declared in the canonical spec.

## Desired outcomes
- SMOKE-001 — Verify selected execution environment can perform a no-op repository-safe change

## In scope
- Perform a minimal non-destructive smoke validation of the selected Rorca execution environment. The runner should inspect the repository, create or update only a smoke evidence file under .rorca/smoke/, and run a lightweight validation command. Do not modify product code, secrets, deployment configuration, database migrations, or remote services.

## Out of scope
- No explicit exclusions were declared.

## Functional requirements
### SMOKE-001
Perform a minimal non-destructive smoke validation of the selected Rorca execution environment. The runner should inspect the repository, create or update only a smoke evidence file under .rorca/smoke/, and run a lightweight validation command. Do not modify product code, secrets, deployment configuration, database migrations, or remote services.

**Acceptance criteria**
- The selected execution environment starts the configured agent without authentication or binary errors.
- The agent writes a timestamped smoke evidence markdown file under .rorca/smoke/.
- The evidence file records the environment name, agent name, current git branch, and validation command used.
- No product source files, migrations, secrets, deployment files, or workspace configuration are changed.
- A lightweight validation command such as git status --short completes successfully.

## Success metrics
- SMOKE-001: The selected execution environment starts the configured agent without authentication or binary errors.
- SMOKE-001: The agent writes a timestamped smoke evidence markdown file under .rorca/smoke/.
- SMOKE-001: The evidence file records the environment name, agent name, current git branch, and validation command used.
- SMOKE-001: No product source files, migrations, secrets, deployment files, or workspace configuration are changed.
- SMOKE-001: A lightweight validation command such as git status --short completes successfully.

## Non-goals
- No explicit non-goals were declared.

## Research provenance
- No external research package informed this canonical spec.

