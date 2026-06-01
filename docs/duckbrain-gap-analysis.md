# DuckBrain gap analysis

Date: 2026-05-28

## Goal
Borrow the open-source hygiene and release discipline that DuckBrain already shows well, without copying its product design.

## What DuckBrain had that Rorca was missing

- **Clear Apache 2.0 licensing** in repo metadata and docs
- **Contributor guide** (`CONTRIBUTING.md`)
- **Security policy** (`SECURITY.md`)
- **CODEOWNERS** for explicit review ownership
- **Secret scanning config** (`.gitleaks.toml`)
- **Readable README structure** with install, run, docs, screenshots, and architecture summary
- **Clear contribution/packaging story** for an OSS-ready repo

## What Rorca needed

### 1. Real Apache 2.0 repo posture
Rorca was still carrying BSL/MIT-era metadata. The repo now needs a clean Apache 2.0 story everywhere visible:
- root `LICENSE`
- package manifests
- license notices
- source headers
- public docs

### 2. Secret hygiene
Rorca had a tracked `.env.local` with live credentials. The repo now needs:
- `.env.local` ignored
- secret scanning in CI
- clear `SECURITY.md`
- no live secrets in tracked files

### 3. OSS contributor hygiene
Rorca benefits from the same “public repo ready” basics:
- `CONTRIBUTING.md`
- `CODEOWNERS`
- `SECURITY.md`
- secret-scanning config

## What was added

- Apache 2.0 license files
- package manifest license updates
- `.env.local` ignore + untracking
- `CONTRIBUTING.md`
- `SECURITY.md`
- `.github/CODEOWNERS`
- `.gitleaks.toml`
- secret-scan workflow
- updated security model docs

## Follow-up
- Review any remaining docs that still describe old licensing or gated-feature assumptions.
- Keep the repo clean before any public release or relicensing announcement.
