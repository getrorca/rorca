---
name: tailwind
description: Tailwind CSS conventions — utility-first patterns, component composition, theme tokens
globs:
  - "**/*.tsx"
  - "**/*.css"
  - "tailwind.config.*"
alwaysApply: false
---

# Tailwind CSS Conventions

## Utility-First
- Use Tailwind utilities directly in JSX. No custom CSS unless absolutely necessary.
- For repeated patterns, extract a React component — not a CSS class.

```tsx
// GOOD — component extraction
function Badge({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">{children}</span>;
}

// BAD — @apply in CSS (defeats the purpose)
// .badge { @apply inline-flex items-center rounded-full ... }
```

## Class Organization
Order utilities logically: layout → spacing → sizing → typography → visual → interactive.

```tsx
<div className="flex items-center gap-4 p-4 w-full text-sm text-gray-700 bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow">
```

## cn() Helper
- Use `cn()` (clsx + tailwind-merge) for conditional classes. Import from `@/lib/utils`.

```tsx
import { cn } from '@/lib/utils';

function Button({ variant = 'primary', className, ...props }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors',
        variant === 'primary' && 'bg-blue-600 text-white hover:bg-blue-700',
        variant === 'secondary' && 'bg-gray-100 text-gray-900 hover:bg-gray-200',
        className,
      )}
      {...props}
    />
  );
}
```

## Spacing
- Use the default spacing scale: `p-1` (4px), `p-2` (8px), `p-4` (16px), `p-6` (24px), `p-8` (32px).
- `gap-*` for flex/grid spacing — not margin hacks.
- `space-y-*` for vertical stacks of variable children.

## Responsive Design
- Mobile-first: base styles for mobile, `sm:`, `md:`, `lg:`, `xl:` for larger screens.
- Common breakpoint pattern: single column on mobile, two columns at `md:`, three at `lg:`.

```tsx
<div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
```

## Dark Mode
- Use `dark:` prefix with `class` strategy in `tailwind.config.ts`.
- Never hardcode colors. Use semantic tokens: `text-foreground`, `bg-background`, `border-border`.

## Colors
- Define a design token palette in `tailwind.config.ts` extending the theme.
- Use semantic names: `primary`, `secondary`, `destructive`, `muted` — not raw color names in components.

## Animation
- Use Tailwind's built-in transitions: `transition-colors`, `transition-opacity`, `transition-all`.
- Duration: `duration-150` for micro-interactions, `duration-300` for layout transitions.
- Custom keyframes in `tailwind.config.ts` for complex animations.

## Avoid
- `@apply` — defeats utility-first philosophy. Extract a component instead.
- Arbitrary values (`w-[137px]`) — indicates missing design tokens. Add to config instead.
- `!important` — fix specificity issues at the source, not with overrides.
