# License Notices

This repository is dual-licensed.

- Files under `packages/rorca-cli/` are licensed under the MIT License. See [packages/rorca-cli/LICENSE](packages/rorca-cli/LICENSE).
- All other files in this repository, including `backend/`, `src/`, `scripts/`, `bin/`, `forge/`, `landing-page/`, and repo-root tooling, are licensed under the Business Source License 1.1. See [LICENSE](LICENSE).

## Why Open-Core

Rorca follows the 2026 open-core playbook used by infrastructure and developer-tooling companies such as LangChain and PostHog:

- The CLI surface can be shared broadly under MIT to support local automation, npm distribution, and community extensions.
- The orchestration engine, dashboard, backend, and surrounding product surface remain under BSL-1.1 so hosted or competitive commercial reuse stays controlled.
- SPDX headers and CI checks enforce the boundary so code does not drift across licenses accidentally.

## Directory Boundaries

- `packages/rorca-cli/`: MIT
- Everything else in this repository: BSL-1.1

If additional shared MIT packages are added later, they must live under `packages/` with their own permissive `LICENSE` file and SPDX headers.

## Contribution Rules

- Contributions to `packages/rorca-cli/` are accepted under MIT terms.
- Contributions everywhere else in this repository are accepted under BSL-1.1 terms.
- Contributors must preserve existing SPDX headers and may not copy BSL-licensed code into MIT trees.
- Maintainers may require a CLA or equivalent contribution agreement for substantial changes before merge.

## Build Artifacts

- Built artifacts produced from BSL-licensed source remain BSL-licensed.
- Built artifacts produced from the standalone MIT CLI package remain MIT-licensed when that package is packed and published independently.
- During the current Phase A monorepo shape, the root `rorca` npm package is governed by the root BSL-1.1 `LICENSE`, even if it contains some MIT-licensed source files from `packages/rorca-cli/`.
- The future standalone `@rorca/cli` tarball must contain only MIT-governed files.
