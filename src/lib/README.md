# Animation System Library

Complete animation system for Rorca, built with Framer Motion.

## Files in This Directory

### animations.ts (Main)
Core animation library with 25+ pre-built variants:
- Basic: fadeIn, slideUp, slideDown, slideRight, slideLeft, scaleIn
- Specialty: pulse, wavePulse, successFlash, checkmarkPop, etc.
- Stagger: staggerContainer, staggerItem
- Utility functions: prefersReducedMotion(), getTransition()

**Usage**:
```tsx
import { slideUp, wavePulse, pulse } from '../lib/animations';
```

### ANIMATIONS_GUIDE.md (Full Reference)
Complete 400+ line guide covering:
- Overview and installation
- Quick start examples
- All animation variants documented
- Common patterns (loading, stagger, success flash, etc.)
- Best practices and accessibility
- Migration checklist
- Troubleshooting

**Read this if**: You need comprehensive documentation on all features.

### ANIMATIONS_INTEGRATION_EXAMPLE.md (Real-World Example)
350+ lines showing how to integrate animations into existing panels:
- Before/after comparison
- Step-by-step migration guide
- ActivityFeedPanel real-world example
- Common panel patterns with full code
- Testing procedures

**Read this if**: You're adding animations to a specific panel.

## Components in ../components/

### AnimatedPanel.tsx
Wraps any panel with slideUp + fadeIn entry animation.
```tsx
import { AnimatedPanel } from '../components/AnimatedPanel';
<AnimatedPanel className="p-6">Content</AnimatedPanel>
```

### AnimatedList.tsx
Renders list items with 30ms stagger delay.
```tsx
import { AnimatedList } from '../components/AnimatedList';
<AnimatedList>{items.map(...)}</AnimatedList>
```

### AnimatedModal.tsx
Modal with scaleIn backdrop + fade animations.
```tsx
import { AnimatedModal } from '../components/AnimatedModal';
<AnimatedModal isOpen={isOpen} onClose={onClose}>Content</AnimatedModal>
```

### AnimatedToast.tsx
Toast notifications with slideRight entry/exit.
```tsx
import { AnimatedToast } from '../components/AnimatedToast';
<AnimatedToast isOpen={isOpen} message="Done!" type="success" />
```

## Hooks in ../hooks/

### useReducedMotion.ts
Detects if user prefers reduced motion (accessibility).
```tsx
import { useReducedMotion } from '../hooks/useReducedMotion';
const prefersReduced = useReducedMotion();
```

## Quick Reference

### Most Used Variants
- `slideUp` — Use for panel entry, modal from bottom
- `slideRight` — Use for toasts, success notifications
- `scaleIn` — Use for modal/dialog entry
- `staggerContainer` + `staggerItem` — Use for list items
- `pulse` — Use for loading states
- `wavePulse` — Use for active/running states

### Animation Duration
- Standard: **0.2s** (200ms)
- Modal/Dialog: **0.15s** (150ms)
- List stagger: **30ms** between items
- All respect `prefers-reduced-motion: reduce` (0ms duration)

### Easing
All animations use **Material Design standard easing**: `[0.4, 0, 0.2, 1]`

## Common Patterns

### Animated Panel
```tsx
import { AnimatedPanel } from '../components/AnimatedPanel';

<AnimatedPanel>
  <div>Content</div>
</AnimatedPanel>
```

### Animated List
```tsx
import { AnimatedList } from '../components/AnimatedList';

<AnimatedList>
  {items.map(item => <div key={item.id}>{item.name}</div>)}
</AnimatedList>
```

### Manual Motion
```tsx
import { motion } from 'framer-motion';
import { slideUp } from './animations';

<motion.div variants={slideUp} initial="initial" animate="animate">
  Content
</motion.div>
```

### Exit Animation
```tsx
import { AnimatePresence, motion } from 'framer-motion';

<AnimatePresence>
  {isVisible && (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      Content that can disappear
    </motion.div>
  )}
</AnimatePresence>
```

## Installation

Framer Motion is already installed in `package.json`:
```json
{
  "dependencies": {
    "framer-motion": "^12.35.1"
  }
}
```

Run:
```bash
npm install
```

## Development

### TypeScript Check
```bash
npm run typecheck
```

### Build
```bash
npm run build
```

### Dev Server
```bash
npm run dev
```

## Testing Accessibility

In browser DevTools:
1. Open DevTools (F12)
2. Go to **Rendering** tab
3. Enable **"Highlight CSS media feature prefers-reduced-motion"**

With this enabled, all animations should run at 0ms duration instantly.

## Performance

- All animations use `transform` and `opacity` (GPU-accelerated)
- No layout shift (CLS = 0)
- Target: 60 FPS on modern devices
- Bundle impact: ~15-20KB gzipped

## Resources

- [Framer Motion Docs](https://www.framer.com/motion/)
- [Material Design Motion](https://material.io/design/motion/)
- [Prefers Reduced Motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)

## Next Steps

1. **Read**: Start with `docs/archive/implementation-notes/ANIMATIONS_QUICK_START.md` (1 page)
2. **Integrate**: Use `ANIMATIONS_INTEGRATION_EXAMPLE.md` for your panel
3. **Reference**: Consult `ANIMATIONS_GUIDE.md` for all options
4. **Build**: Run `npm run build` to verify

---

**Questions?** Check the troubleshooting section in `ANIMATIONS_GUIDE.md`.
