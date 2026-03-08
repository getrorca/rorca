# Animation System Guide

This document explains how to use Rorca's animation system built with Framer Motion.

## Overview

**Rorca Animation System** provides a unified, consistent animation library across the entire application:
- **Location**: `src/lib/animations.ts`
- **Components**: Pre-built animated wrappers in `src/components/Animated*.tsx`
- **Hook**: `useReducedMotion()` for accessibility
- **Duration**: All animations use 0.15–0.2s (fast, responsive)
- **Easing**: Material Design standard: `[0.4, 0, 0.2, 1]`
- **Accessibility**: All animations respect `prefers-reduced-motion` media query

## Installation

Framer Motion is installed as a production dependency:

```bash
npm install framer-motion
```

## Quick Start

### 1. Wrap Panel Content with AnimatedPanel

Before:
```tsx
export function MyPanel() {
  return <div className="p-4">Content</div>;
}
```

After:
```tsx
import { AnimatedPanel } from '../components/AnimatedPanel';

export function MyPanel() {
  return (
    <AnimatedPanel className="p-4">
      Content
    </AnimatedPanel>
  );
}
```

### 2. Animate List Items with AnimatedList

Before:
```tsx
<div>
  {items.map((item) => <div key={item.id}>{item.name}</div>)}
</div>
```

After:
```tsx
import { AnimatedList } from '../components/AnimatedList';

<AnimatedList>
  {items.map((item) => <div key={item.id}>{item.name}</div>)}
</AnimatedList>
```

### 3. Animate Modals with AnimatedModal

```tsx
import { AnimatedModal } from '../components/AnimatedModal';

<AnimatedModal isOpen={isOpen} onClose={handleClose}>
  <div className="bg-white rounded-lg p-6">
    Modal Content
  </div>
</AnimatedModal>
```

### 4. Show Notifications with AnimatedToast

```tsx
import { AnimatedToast } from '../components/AnimatedToast';

<AnimatedToast
  isOpen={showToast}
  message="Spec approved!"
  type="success"
  onClose={() => setShowToast(false)}
  duration={3000}
/>
```

## Animation Variants (from animations.ts)

### Basic Animations (0.2s)

- **fadeIn** - Fade in/out
- **slideUp** - Slide up + fade (for modal/panel entry from bottom)
- **slideDown** - Slide down + fade (for notifications from top)
- **slideRight** - Slide right + fade (for toasts/drawers)
- **slideLeft** - Slide left + fade (for notifications exiting)
- **scaleIn** - Scale up from 95% + fade (for modals)

### Specialty Animations

- **scalePop** - Bouncy scale entry (checkmarks, success badges)
- **checkmarkPop** - Pop with overshoot (success indicators)
- **dotFadeInPulse** - Fade in with pulse (status dots)
- **pulse** - Infinite opacity pulse (loading states)
- **wavePulse** - Infinite background color wave (active pipeline)
- **successFlash** - Flash green background (story pass)
- **indeterminateProgress** - Infinite progress bar slide

### Stagger Animations

- **staggerContainer** - Parent variant for staggered children
- **staggerItem** - Child variant (same as slideUp)

Use together:
```tsx
<motion.div variants={staggerContainer} initial="initial" animate="animate">
  {items.map((item) => (
    <motion.div key={item.id} variants={staggerItem}>
      {item.name}
    </motion.div>
  ))}
</motion.div>
```

### Misc Animations

- **breath** - Subtle expand/contract (focus states)
- **flip** - 360° Y-axis rotation
- **shake** - Error state wiggle
- **bounce** - Vertical bounce
- **panLeft** / **panRight** - Carousel-style pan

## Using Individual Variants

Import and use with Framer Motion `motion` component:

```tsx
import { motion } from 'framer-motion';
import { slideUp, wavePulse } from '../lib/animations';

// Simple variant usage
<motion.div variants={slideUp} initial="initial" animate="animate">
  Content
</motion.div>

// With custom transition
<motion.div
  variants={slideUp}
  initial="initial"
  animate="animate"
  transition={{ duration: 0.3, ease: 'easeOut' }}
>
  Content
</motion.div>

// Infinite animation
<motion.div animate={wavePulse.animate} transition={wavePulse.transition}>
  Active pipeline indicator
</motion.div>
```

## Respecting User Preferences

**All animations automatically respect `prefers-reduced-motion`.**

To check preference in code:
```tsx
import { useReducedMotion } from '../hooks/useReducedMotion';

export function MyComponent() {
  const prefersReduced = useReducedMotion();

  if (prefersReduced) {
    // Render static version
  }

  // Render animated version
}
```

Or check at animation definition time:
```tsx
import { prefersReducedMotion } from '../lib/animations';

const myVariant = {
  animate: { opacity: 1 },
  transition: prefersReducedMotion() ? { duration: 0 } : { duration: 0.3 },
};
```

## Replacing CSS Animations

**Old CSS approach:**
```css
@keyframes slideUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.animate-slide-up { animation: slideUp 200ms ease-out; }
```

```tsx
<div className="animate-slide-up">Content</div>
```

**New Framer Motion approach:**
```tsx
import { motion } from 'framer-motion';
import { slideUp } from '../lib/animations';

<motion.div variants={slideUp} initial="initial" animate="animate">
  Content
</motion.div>
```

**Why Framer Motion is better:**
- No CSS namespace pollution
- Dynamic transitions (pause, reverse, combine)
- Exit animations (AnimatePresence)
- Built-in stagger support
- Better TypeScript support
- Respects prefers-reduced-motion by default

## Common Patterns

### Loading State Pulse
```tsx
<motion.div animate={pulse.animate} transition={pulse.transition}>
  Loading...
</motion.div>
```

### Staggered List
```tsx
<AnimatedList staggerDelay={0.05}>
  {specs.map((spec) => (
    <SpecCard key={spec.id} spec={spec} />
  ))}
</AnimatedList>
```

### Success Flash
```tsx
<motion.div
  animate={successFlash.animate}
  transition={successFlash.transition}
  className="bg-emerald-500/18 p-4"
>
  Story passed!
</motion.div>
```

### Fade Out on Exit
```tsx
import { AnimatePresence, motion } from 'framer-motion';

<AnimatePresence>
  {isVisible && (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      Content that can disappear
    </motion.div>
  )}
</AnimatePresence>
```

### Modal with Backdrop
```tsx
<AnimatedModal isOpen={isOpen} onClose={onClose}>
  <div className="bg-white rounded-lg p-6 shadow-xl">
    Modal content
  </div>
</AnimatedModal>
```

## Best Practices

1. **Keep animations short** — 0.15–0.3s maximum. Faster feels more responsive.

2. **Use consistent easing** — Use Material Design easing `[0.4, 0, 0.2, 1]` for all animations.

3. **Respect prefers-reduced-motion** — Always use our animation variants; they check this automatically.

4. **Avoid layout shift** — Use `contain-layout` class on containers to prevent Cumulative Layout Shift (CLS).

5. **Animate on intent** — Only animate when user intentionally triggers an action (click, scroll, change), not on every state change.

6. **Test on real devices** — 60fps animations can stutter on low-end devices. Keep animations simple.

7. **Exit animations** — Use `AnimatePresence` when removing elements so they can animate out gracefully.

8. **Combine modestly** — Don't combine too many animations (scale + rotate + skew). 2–3 transforms max.

## Migration Checklist

- [ ] Identify CSS @keyframes animations in `src/styles/index.css`
- [ ] Replace with Framer Motion variants from `src/lib/animations.ts`
- [ ] Wrap panel containers with `AnimatedPanel`
- [ ] Wrap list renders with `AnimatedList`
- [ ] Wrap modals with `AnimatedModal`
- [ ] Wrap toast/notifications with `AnimatedToast`
- [ ] Run `npm run typecheck` to verify no TS errors
- [ ] Test with `prefers-reduced-motion: reduce` enabled in browser DevTools
- [ ] Test on real device to ensure 60fps performance
- [ ] Update component documentation with animation examples

## Troubleshooting

### Animation not working

**Check:**
1. Is `motion.div` imported from `framer-motion`?
2. Are `initial` and `animate` props set?
3. Is the component re-rendering unexpectedly? (Use `key` prop on lists)

### Jank/stuttering

**Check:**
1. Are you animating expensive properties (layout, width, height)? Use `transform` instead.
2. Is `contain-layout` class applied to reduce reflows?
3. Are there too many simultaneous animations? (Max 5–10 elements per frame)

### Animation too slow

**Check:**
1. Is `prefers-reduced-motion: reduce` enabled? (DevTools > Rendering > Highlight CSS media feature prefers-reduced-motion)
2. Is the browser under heavy load? (Performance tab)

## Resources

- [Framer Motion Docs](https://www.framer.com/motion/)
- [Material Design Motion](https://material.io/design/motion/)
- [Prefers Reduced Motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)
- [Web Vitals: CLS](https://web.dev/articles/cls)
