---
name: rorca-spec-templates
description: "Pre-built Rorca spec templates for common project types — SaaS MVP, CLI tool, API service, React component library, E2E test suite. Uses rorca_create_spec."
version: 1.0.0
author: Rorca + Hermes Agent
license: Apache-2.0
tags: [rorca, template, spec, scaffold, saas, cli, api, react]
---

# Rorca Spec Templates

Pre-built spec templates that you can instantiate with `rorca_create_spec`. Each template includes a complete story breakdown, acceptance criteria, and direction stack defaults.

## Available Templates

### 1. SaaS MVP
A full-stack SaaS application with auth, payments, dashboard, and API.
```
Brief: "Build a SaaS application with user authentication, Stripe payments, a dashboard, and REST API."
Direction: React + Node.js + PostgreSQL, TypeScript, Tailwind CSS, Stripe, NextAuth.js.
```

### 2. CLI Tool
A command-line tool with subcommands, config, and output formatting.
```
Brief: "Build a CLI tool for managing project templates with init, list, create, and validate commands."
Direction: Node.js + Commander, TypeScript, chalk for output, yaml for config.
```

### 3. REST API Service
A REST API with CRUD, auth, rate limiting, and OpenAPI docs.
```
Brief: "Build a REST API for a task management system with CRUD operations, JWT auth, and rate limiting."
Direction: Express + TypeScript, PostgreSQL, JWT, Swagger/OpenAPI, helmet.
```

### 4. React Component Library
A reusable React component library with Storybook, tests, and TypeScript.
```
Brief: "Build a React component library with Button, Input, Modal, Table, and Form components."
Direction: React 19 + TypeScript, Storybook, vitest + testing-library, CSS modules.
```

### 5. E2E Test Suite
An end-to-end test suite for a web application.
```
Brief: "Build an E2E test suite covering auth flow, CRUD operations, error states, and edge cases."
Direction: Playwright + TypeScript, page object pattern, CI-ready, parallel execution.
```

## How to Use

1. Make sure Rorca is running: `rorca start`
2. Load this skill: `/skill rorca-spec-templates`
3. Pick a template brief from above
4. Use `rorca_create_spec` with the brief and direction
5. Review and approve the generated spec
6. Run the pipeline to execute

## Adding Your Own Templates

Submit new templates as skills! Each template should include:
- A clear brief (what to build)
- Direction stack defaults (conventions, architecture, constraints)
- Recommended agent (Claude Code / OpenCode / Codex)
- Tips for iteration
