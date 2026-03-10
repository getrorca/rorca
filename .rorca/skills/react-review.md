---
name: react-review
description: Review React components for best practices and performance issues
license: MIT
compatibility: opencode
metadata:
  audience: developers
  category: development
---

# React Review Skill

Review React components for best practices, performance issues, and common patterns.

## When to use me

Use this skill when:
- Reviewing React component code
- Optimizing component performance
- Checking for React best practices
- Refactoring legacy components
- Auditing component architecture

## What I do

- Analyze React components for performance issues (unnecessary re-renders, large bundles)
- Check for React best practices (hooks usage, prop patterns, state management)
- Identify anti-patterns (prop drilling, useEffect misuse, missing keys)
- Suggest optimizations (memoization, code splitting, lazy loading)
- Review TypeScript usage and type safety

## Key Patterns

### Performance
- Use `React.memo` for components receiving object/function props from parent
- Memoize expensive calculations with `useMemo`
- Stabilize callback references with `useCallback`
- Avoid inline object/array creation in JSX props
- Use `React.lazy` + `Suspense` for code splitting

### Hooks
- Always include all dependencies in `useEffect` dependency arrays
- Never call hooks conditionally or inside loops
- Extract complex logic into custom hooks
- Clean up subscriptions and timers in useEffect return

### TypeScript
- Define explicit interfaces for all component props
- Use discriminated unions for variant components
- Prefer `interface` over `type` for component props
- Use `React.FC` sparingly — prefer explicit return types

## Notes

- Focuses on React 18+ patterns and best practices
- Considers both class and function components
- Includes TypeScript and JavaScript variants
- References official React documentation and community patterns
