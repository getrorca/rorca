# Animation System — Quick Start Card

## Install
```bash
npm install  # framer-motion already in package.json
```

## Add Animation to Panel

### Option 1: Wrap with AnimatedPanel (Recommended)
```tsx
import { AnimatedPanel } from '../components/AnimatedPanel';

export function MyPanel() {
  return (
    <AnimatedPanel className="p-6">
      {/* content */}
    </AnimatedPanel>
  );
}
```

### Option 2: Use motion directly
```tsx
import { motion } from 'framer-motion';
import { slideUp } from '../lib/animations';

<motion.div variants={slideUp} initial="initial" animate="animate">
  Content
</motion.div>
```

## Animate Lists
```tsx
import { AnimatedList } from '../components/AnimatedList';

<AnimatedList>
  {items.map(item => <div key={item.id}>{item.name}</div>)}
</AnimatedList>
```

## Show Modal
```tsx
import { AnimatedModal } from '../components/AnimatedModal';

<AnimatedModal isOpen={isOpen} onClose={onClose}>
  <div className="bg-white rounded-lg p-6">Modal content</div>
</AnimatedModal>
```

## Show Toast
```tsx
import { AnimatedToast } from '../components/AnimatedToast';

<AnimatedToast
  isOpen={isOpen}
  message="Done!"
  type="success"
  onClose={() => setOpen(false)}
  duration={3000}
/>
```

## Common Variants (duration 0.2s)
- `slideUp` — Slide up + fade
- `slideDown` — Slide down + fade
- `slideRight` — Slide right + fade
- `slideLeft` — Slide left + fade
- `fadeIn` — Fade in/out
- `scaleIn` — Scale from 95%
- `scalePop` — Pop with bounce
- `pulse` — Infinite opacity pulse
- `wavePulse` — Infinite background wave
- `successFlash` — Green flash
- Plus 15+ more in `src/lib/animations.ts`

## Check Accessibility
```tsx
import { useReducedMotion } from '../hooks/useReducedMotion';

const prefersReduced = useReducedMotion();
// Render simplified version if true
```

## Docs
- **Full guide**: `src/lib/ANIMATIONS_GUIDE.md`
- **Integration examples**: `src/lib/ANIMATIONS_INTEGRATION_EXAMPLE.md`
- **All variants**: `src/lib/animations.ts` (300+ lines)

## Verify
```bash
npm run typecheck  # Should pass with no errors
npm run build      # Should build successfully
```

## Key Points
✅ All animations respect `prefers-reduced-motion` automatically
✅ Uses Material Design easing: `[0.4, 0, 0.2, 1]`
✅ Duration: 0.15–0.2s (fast & responsive)
✅ No layout shift (uses `transform` only)
✅ 4 ready-to-use components (Panel, List, Modal, Toast)
✅ 25+ pre-built animation variants
✅ Full TypeScript support

## Example: Full Panel
```tsx
import { AnimatedPanel } from '../components/AnimatedPanel';
import { AnimatedList } from '../components/AnimatedList';

export function ExamplePanel() {
  const [items, setItems] = useState([]);

  return (
    <AnimatedPanel className="p-6">
      <h2 className="text-xl font-bold mb-4">Items</h2>
      <AnimatedList>
        {items.map(item => (
          <div key={item.id} className="p-3 border rounded">
            {item.name}
          </div>
        ))}
      </AnimatedList>
    </AnimatedPanel>
  );
}
```

Done! Panel now has polished animations. ✨
