# Animation System Integration Example

This document shows a real-world example of how to integrate animations into an existing panel.

## Before: Rorca UI without animations

**File**: `src/panels/ActivityFeedPanel.tsx`

```tsx
import { useState, useEffect } from 'react';
import { Clock, User, CheckCircle2, AlertCircle } from 'lucide-react';

export function ActivityFeedPanel() {
  const [activities, setActivities] = useState<Activity[]>([]);

  useEffect(() => {
    // Fetch activities...
  }, []);

  return (
    <div className="p-6">
      <h2 className="text-xl font-bold mb-4">Activity Feed</h2>
      <div className="space-y-3">
        {activities.map((activity) => (
          <div
            key={activity.id}
            className="p-3 border border-border rounded-lg bg-panel/50 hover:bg-panel transition-colors"
          >
            <div className="flex items-center gap-2">
              {activity.icon === 'success' && <CheckCircle2 className="text-success" />}
              {activity.icon === 'warning' && <AlertCircle className="text-warning" />}
              <div className="flex-1">
                <p className="text-sm font-medium">{activity.title}</p>
                <p className="text-xs text-muted">{formatTime(activity.timestamp)}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

**Problems:**
- No entrance animation (panel feels static)
- List items don't stagger in (visual clutter)
- No feedback when dismissing items
- Not accessible (users with `prefers-reduced-motion` see same animation)

---

## After: With Framer Motion animations

```tsx
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Clock, User, CheckCircle2, AlertCircle } from 'lucide-react';
import { AnimatedPanel } from '../components/AnimatedPanel';
import { slideUp } from '../lib/animations';

export function ActivityFeedPanel() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [dismissing, setDismissing] = useState<string | null>(null);

  useEffect(() => {
    // Fetch activities...
  }, []);

  const handleDismiss = (id: string) => {
    setDismissing(id);
    setTimeout(() => {
      setActivities((prev) => prev.filter((a) => a.id !== id));
      setDismissing(null);
    }, 100); // Wait for exit animation to complete
  };

  return (
    <AnimatedPanel className="p-6">
      <h2 className="text-xl font-bold mb-4">Activity Feed</h2>
      <motion.div
        className="space-y-3"
        initial="initial"
        animate="animate"
        variants={{
          initial: {},
          animate: {
            transition: {
              staggerChildren: 0.03, // 30ms stagger between items
            },
          },
        }}
      >
        <AnimatePresence>
          {activities.map((activity) => (
            <motion.div
              key={activity.id}
              variants={slideUp}
              exit={{ opacity: 0, x: 16 }} // Exit animation
              className="p-3 border border-border rounded-lg bg-panel/50 hover:bg-panel transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-1">
                  {activity.icon === 'success' && <CheckCircle2 className="text-success" />}
                  {activity.icon === 'warning' && <AlertCircle className="text-warning" />}
                  <div className="flex-1">
                    <p className="text-sm font-medium">{activity.title}</p>
                    <p className="text-xs text-muted">{formatTime(activity.timestamp)}</p>
                  </div>
                </div>
                <button
                  onClick={() => handleDismiss(activity.id)}
                  className="p-1 rounded hover:bg-border transition-colors text-muted hover:text-[var(--text)]"
                  aria-label="Dismiss activity"
                >
                  ✕
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>

      {activities.length === 0 && (
        <div className="text-center py-8 text-muted">
          No recent activity
        </div>
      )}
    </AnimatedPanel>
  );
}
```

**Improvements:**
✅ Panel enters with subtle slideUp animation (100ms)
✅ List items stagger in at 30ms intervals (total ~150ms for 5 items)
✅ Dismissing an item exits smoothly with slideLeft animation
✅ Respects `prefers-reduced-motion` automatically (zero duration animations)
✅ No layout shift — uses transform instead of width/height
✅ Accessible — clear visual feedback for interactions

---

## Migration Steps (for any panel)

### Step 1: Wrap panel root with AnimatedPanel
```tsx
// Before
export function MyPanel() {
  return <div className="p-6">...</div>;
}

// After
import { AnimatedPanel } from '../components/AnimatedPanel';

export function MyPanel() {
  return (
    <AnimatedPanel className="p-6">
      ...
    </AnimatedPanel>
  );
}
```

### Step 2: Wrap list renders with motion.div + stagger
```tsx
// Before
<div className="space-y-3">
  {items.map((item) => <div key={item.id}>{item.name}</div>)}
</div>

// After
import { motion } from 'framer-motion';
import { slideUp } from '../lib/animations';

<motion.div
  className="space-y-3"
  initial="initial"
  animate="animate"
  variants={{
    initial: {},
    animate: {
      transition: {
        staggerChildren: 0.03,
      },
    },
  }}
>
  {items.map((item) => (
    <motion.div key={item.id} variants={slideUp}>
      {item.name}
    </motion.div>
  ))}
</motion.div>
```

### Step 3: Add exit animations with AnimatePresence
```tsx
// Before
{items.map((item) => <div key={item.id}>{item.name}</div>)}

// After
import { AnimatePresence } from 'framer-motion';

<AnimatePresence>
  {items.map((item) => (
    <motion.div
      key={item.id}
      variants={slideUp}
      exit={{ opacity: 0, x: 16 }}
    >
      {item.name}
    </motion.div>
  ))}
</AnimatePresence>
```

### Step 4: Wrap modals/dialogs with AnimatedModal
```tsx
// Before
<div className={`fixed inset-0 ${isOpen ? 'block' : 'hidden'}`}>
  <div className="bg-white rounded-lg p-6">Content</div>
</div>

// After
import { AnimatedModal } from '../components/AnimatedModal';

<AnimatedModal isOpen={isOpen} onClose={handleClose}>
  <div className="bg-white rounded-lg p-6">Content</div>
</AnimatedModal>
```

---

## Common Panel Patterns

### Pattern 1: Animated Cards with Status
```tsx
<AnimatedPanel>
  <motion.div
    className="space-y-2"
    variants={{
      initial: {},
      animate: { transition: { staggerChildren: 0.05 } },
    }}
    initial="initial"
    animate="animate"
  >
    {specs.map((spec) => (
      <motion.div
        key={spec.id}
        variants={slideUp}
        className="p-4 border border-border rounded-lg"
      >
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">{spec.name}</h3>
            <p className="text-sm text-muted">{spec.description}</p>
          </div>
          <div className="flex items-center gap-2">
            {spec.status === 'pass' && (
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ duration: 0.3 }}
              >
                <CheckCircle2 className="text-success" />
              </motion.div>
            )}
          </div>
        </div>
      </motion.div>
    ))}
  </motion.div>
</AnimatedPanel>
```

### Pattern 2: Tab-based panel with cross-fade
```tsx
import { AnimatePresence } from 'framer-motion';

<div className="flex gap-4">
  <div className="flex gap-2 border-b border-border">
    {tabs.map((tab) => (
      <button
        key={tab.id}
        onClick={() => setActiveTab(tab.id)}
        className={`px-4 py-2 transition-colors ${
          activeTab === tab.id ? 'border-b-2 border-accent' : 'text-muted'
        }`}
      >
        {tab.label}
      </button>
    ))}
  </div>

  <AnimatePresence mode="wait">
    <motion.div
      key={activeTab}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2 }}
    >
      {/* Tab content */}
    </motion.div>
  </AnimatePresence>
</div>
```

### Pattern 3: Search results with progressive rendering
```tsx
<AnimatedPanel>
  <input
    type="search"
    placeholder="Search..."
    onChange={(e) => setQuery(e.target.value)}
    className="w-full px-4 py-2 rounded border border-border"
  />

  <motion.div
    className="mt-4 space-y-2"
    initial="initial"
    animate="animate"
    variants={{
      initial: {},
      animate: {
        transition: {
          staggerChildren: 0.03,
        },
      },
    }}
  >
    <AnimatePresence>
      {results.map((result, i) => (
        <motion.div
          key={result.id}
          variants={slideUp}
          layout
          className="p-3 border border-border rounded cursor-pointer hover:bg-panel transition-colors"
        >
          <p className="font-semibold">{result.name}</p>
          <p className="text-sm text-muted">{result.description}</p>
        </motion.div>
      ))}
    </AnimatePresence>
  </motion.div>

  {results.length === 0 && (
    <div className="text-center py-8 text-muted">
      {query ? 'No results found' : 'Type to search'}
    </div>
  )}
</AnimatedPanel>
```

---

## Testing Animations

### 1. Visual Testing
Open browser DevTools → F12 → More tools → Rendering → Enable "Highlight CSS media feature prefers-reduced-motion"

With this enabled, all animations should run at 0 duration.

### 2. Performance Testing
DevTools → Performance tab → Record → Interact with animations → Stop

Look for:
- 60 FPS (16.67ms frames)
- No red triangles (jank indicators)
- No long tasks (>50ms)

### 3. Accessibility Testing
```bash
# Check for animation-related accessibility issues
axe DevTools → Run scan → Check for "Motion" section
```

---

## Checklist for Panel Animation Integration

- [ ] Import `AnimatedPanel` at top of panel file
- [ ] Wrap panel root div with `<AnimatedPanel>`
- [ ] Import `motion` from `framer-motion` for list/nested animations
- [ ] Wrap lists with `motion.div` + stagger variants
- [ ] Add `AnimatePresence` wrapper around items that can be deleted
- [ ] Add `exit` prop to items for smooth deletion animation
- [ ] Wrap modals/dialogs with `AnimatedModal` component
- [ ] Test with `prefers-reduced-motion: reduce` enabled
- [ ] Check performance (60fps target)
- [ ] Verify TypeScript compiles: `npm run typecheck`
- [ ] Run visual regression tests (Playwright)

---

## Troubleshooting

### List items appear/disappear instantly
**Problem**: Missing `AnimatePresence` wrapper
**Solution**:
```tsx
import { AnimatePresence } from 'framer-motion';

<AnimatePresence>
  {items.map((item) => (
    <motion.div key={item.id} variants={slideUp} exit={{ opacity: 0 }}>
      {item.name}
    </motion.div>
  ))}
</AnimatePresence>
```

### Animation stutters on first load
**Problem**: Likely CSS or heavy component rendering
**Solution**: Check that `contain-layout` class is applied to container

### Animation disabled when `prefers-reduced-motion` is enabled
**Expected behavior!** This is correct. Users with motion sensitivity should see instant transitions.

### Key prop warnings in console
**Problem**: Using array index as key in `.map()`
**Solution**: Use unique, stable IDs
```tsx
// Bad
{items.map((item, i) => <div key={i}>...)</div>)}

// Good
{items.map((item) => <div key={item.id}>...)</div>)}
```
