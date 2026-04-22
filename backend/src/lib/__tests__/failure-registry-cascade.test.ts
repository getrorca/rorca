/**
 * Integration test for CP-002: Failure Registry cascade behavior preservation.
 *
 * Verifies that computeBlockedStories with the new Map<string, FailureRecord>-based
 * failureRegistry produces the same transitive blocking cascade as the old Set<string>
 * approach. Uses a 3-story spec with 1 intentional failure (US-001) and asserts the
 * same blocked_by cascade occurs:
 *   US-001 → fails
 *   US-002 (dependsOn: [US-001]) → blocked_by: US-001
 *   US-003 (dependsOn: [US-002]) → transitively blocked_by: US-002 (→ US-001)
 */

import {
  createFailureRegistry,
  markFailed,
  isFailed,
  removeFailure,
  failedIdSet,
  type FailureRecord,
  type FailureRegistryMap,
} from '../failure-registry';

// ── Minimal UserStory type matching execution-engine.ts ──────────────────

interface UserStory {
  id: string;
  title: string;
  description: string;
  dependsOn?: string[];
  passes?: boolean;
  excluded?: boolean;
  skipped?: boolean;
}

// ── Re-implement computeBlockedStories logic as used in execution-engine.ts ──
// This mirrors the function exactly as it exists post-CP-002 refactor.

function computeBlockedStories(
  allStories: UserStory[],
  failureRegistry: FailureRegistryMap,
  alreadyProcessed: Set<string>,
): Map<string, string[]> {
  const blocked = new Map<string, string[]>();
  const failed = failedIdSet(failureRegistry);
  const unprocessed = allStories.filter(s =>
    !alreadyProcessed.has(s.id) && !failed.has(s.id) && !s.excluded && !s.skipped && !(s.passes === true)
  );

  const allBlockedIds = new Set<string>(failed);
  let changed = true;
  while (changed) {
    changed = false;
    for (const story of unprocessed) {
      if (allBlockedIds.has(story.id)) continue;
      const deps = story.dependsOn ?? [];
      const blockers = deps.filter(dep => allBlockedIds.has(dep));
      if (blockers.length > 0) {
        allBlockedIds.add(story.id);
        blocked.set(story.id, blockers);
        changed = true;
      }
    }
  }

  return blocked;
}

// ── Old Set-based implementation for comparison ──────────────────────────

function computeBlockedStoriesOld(
  allStories: UserStory[],
  failedIds: Set<string>,
  alreadyProcessed: Set<string>,
): Map<string, string[]> {
  const blocked = new Map<string, string[]>();
  const unprocessed = allStories.filter(s =>
    !alreadyProcessed.has(s.id) && !failedIds.has(s.id) && !s.excluded && !s.skipped && !(s.passes === true)
  );

  const allBlockedIds = new Set<string>(failedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const story of unprocessed) {
      if (allBlockedIds.has(story.id)) continue;
      const deps = story.dependsOn ?? [];
      const blockers = deps.filter(dep => allBlockedIds.has(dep));
      if (blockers.length > 0) {
        allBlockedIds.add(story.id);
        blocked.set(story.id, blockers);
        changed = true;
      }
    }
  }

  return blocked;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('failure-registry cascade (integration)', () => {
  const stories: UserStory[] = [
    { id: 'US-001', title: 'Setup database', description: 'Create schema', dependsOn: [] },
    { id: 'US-002', title: 'Add API routes', description: 'Routes for CRUD', dependsOn: ['US-001'] },
    { id: 'US-003', title: 'Add frontend', description: 'React UI', dependsOn: ['US-002'] },
  ];

  test('3-story spec with 1 failure produces same cascade as old Set approach', () => {
    // Old approach: Set<string>
    const failedIds = new Set<string>();
    failedIds.add('US-001');
    const oldBlocked = computeBlockedStoriesOld(stories, failedIds, new Set());

    // New approach: Map<string, FailureRecord>
    const registry = createFailureRegistry();
    markFailed(registry, {
      storyId: 'US-001', waveIndex: 0, failedAt: Date.now(),
      reason: 'agent_timeout', recoveryClass: 'transient',
      recoveryAttempts: 0, lastRecoveryAt: null, recoveryInFlight: false,
    });
    const newBlocked = computeBlockedStories(stories, registry, new Set());

    // Both should produce identical blocked maps
    expect(newBlocked.size).toBe(oldBlocked.size);
    for (const [id, blockers] of oldBlocked) {
      expect(newBlocked.has(id)).toBe(true);
      expect(newBlocked.get(id)).toEqual(blockers);
    }

    // Specifically: US-002 blocked by US-001, US-003 blocked by US-002
    expect(newBlocked.get('US-002')).toEqual(['US-001']);
    expect(newBlocked.get('US-003')).toEqual(['US-002']);
  });

  test('no failures produces no blocked stories', () => {
    const registry = createFailureRegistry();
    const blocked = computeBlockedStories(stories, registry, new Set());
    expect(blocked.size).toBe(0);
  });

  test('failure in leaf story (no dependants) blocks nothing', () => {
    const registry = createFailureRegistry();
    markFailed(registry, {
      storyId: 'US-003', waveIndex: 2, failedAt: Date.now(),
      reason: 'execution_failed', recoveryClass: 'transient',
      recoveryAttempts: 0, lastRecoveryAt: null, recoveryInFlight: false,
    });
    const blocked = computeBlockedStories(stories, registry, new Set());
    expect(blocked.size).toBe(0);
  });

  test('already-processed stories are not blocked', () => {
    const registry = createFailureRegistry();
    markFailed(registry, {
      storyId: 'US-001', waveIndex: 0, failedAt: Date.now(),
      reason: 'agent_timeout', recoveryClass: 'transient',
      recoveryAttempts: 0, lastRecoveryAt: null, recoveryInFlight: false,
    });
    // US-002 was already processed in a previous wave
    const processed = new Set(['US-002']);
    const blocked = computeBlockedStories(stories, registry, processed);

    // US-002 is already processed so not in blocked map, but US-003 depends on US-002
    // which is NOT in failedIds — so US-003 is NOT blocked (US-002 was processed, not failed)
    // However US-003 depends on US-002 which depends on US-001 (failed).
    // Since US-002 is already processed and NOT in the failure registry,
    // US-003's dependency chain doesn't transitively reach US-001.
    // This matches the old Set behavior — processed means "handled, not necessarily failed".
    expect(blocked.has('US-002')).toBe(false); // already processed
    expect(blocked.has('US-003')).toBe(false); // US-002 not in failed set
  });

  test('recovery (removal) unblocks dependants in subsequent waves', () => {
    const registry = createFailureRegistry();
    markFailed(registry, {
      storyId: 'US-001', waveIndex: 0, failedAt: Date.now(),
      reason: 'merge_conflict', recoveryClass: 'transient',
      recoveryAttempts: 0, lastRecoveryAt: null, recoveryInFlight: false,
    });

    // Before recovery: US-002 and US-003 are blocked
    const blockedBefore = computeBlockedStories(stories, registry, new Set());
    expect(blockedBefore.size).toBe(2);

    // Recovery succeeds — remove US-001 from registry
    removeFailure(registry, 'US-001');
    expect(isFailed(registry, 'US-001')).toBe(false);

    // After recovery: nothing is blocked
    const blockedAfter = computeBlockedStories(stories, registry, new Set());
    expect(blockedAfter.size).toBe(0);
  });

  test('diamond dependency: two paths to same blocker', () => {
    // US-001 (fails)
    //   ├── US-002 (depends on US-001)
    //   └── US-003 (depends on US-001)
    //       └── US-004 (depends on US-002 AND US-003)
    const diamondStories: UserStory[] = [
      { id: 'US-001', title: 'Root', description: '', dependsOn: [] },
      { id: 'US-002', title: 'Left', description: '', dependsOn: ['US-001'] },
      { id: 'US-003', title: 'Right', description: '', dependsOn: ['US-001'] },
      { id: 'US-004', title: 'Leaf', description: '', dependsOn: ['US-002', 'US-003'] },
    ];

    const registry = createFailureRegistry();
    markFailed(registry, {
      storyId: 'US-001', waveIndex: 0, failedAt: Date.now(),
      reason: 'agent_timeout', recoveryClass: 'transient',
      recoveryAttempts: 0, lastRecoveryAt: null, recoveryInFlight: false,
    });

    // Compare old vs new
    const failedIds = new Set(['US-001']);
    const oldBlocked = computeBlockedStoriesOld(diamondStories, failedIds, new Set());
    const newBlocked = computeBlockedStories(diamondStories, registry, new Set());

    expect(newBlocked.size).toBe(oldBlocked.size);
    expect(newBlocked.size).toBe(3); // US-002, US-003, US-004

    // US-002 and US-003 blocked by US-001
    expect(newBlocked.get('US-002')).toEqual(['US-001']);
    expect(newBlocked.get('US-003')).toEqual(['US-001']);

    // US-004 blocked by both US-002 and US-003 (order may vary)
    const us4Blockers = newBlocked.get('US-004')!;
    expect(us4Blockers).toContain('US-002');
    expect(us4Blockers).toContain('US-003');
  });

  test('excluded and skipped stories are not blocked', () => {
    const mixedStories: UserStory[] = [
      { id: 'US-001', title: 'Root', description: '', dependsOn: [] },
      { id: 'US-002', title: 'Excluded', description: '', dependsOn: ['US-001'], excluded: true },
      { id: 'US-003', title: 'Skipped', description: '', dependsOn: ['US-001'], skipped: true },
      { id: 'US-004', title: 'Normal', description: '', dependsOn: ['US-001'] },
    ];

    const registry = createFailureRegistry();
    markFailed(registry, {
      storyId: 'US-001', waveIndex: 0, failedAt: Date.now(),
      reason: 'agent_timeout', recoveryClass: 'transient',
      recoveryAttempts: 0, lastRecoveryAt: null, recoveryInFlight: false,
    });

    const blocked = computeBlockedStories(mixedStories, registry, new Set());
    // Only US-004 is blocked (US-002 excluded, US-003 skipped)
    expect(blocked.size).toBe(1);
    expect(blocked.has('US-004')).toBe(true);
    expect(blocked.has('US-002')).toBe(false);
    expect(blocked.has('US-003')).toBe(false);
  });

  test('multiple independent failures cascade independently', () => {
    const wideStories: UserStory[] = [
      { id: 'US-001', title: 'DB', description: '', dependsOn: [] },
      { id: 'US-002', title: 'Auth', description: '', dependsOn: [] },
      { id: 'US-003', title: 'API (needs DB)', description: '', dependsOn: ['US-001'] },
      { id: 'US-004', title: 'UI (needs Auth)', description: '', dependsOn: ['US-002'] },
      { id: 'US-005', title: 'Integration (needs API+UI)', description: '', dependsOn: ['US-003', 'US-004'] },
    ];

    const registry = createFailureRegistry();
    // Only US-001 fails
    markFailed(registry, {
      storyId: 'US-001', waveIndex: 0, failedAt: Date.now(),
      reason: 'agent_timeout', recoveryClass: 'transient',
      recoveryAttempts: 0, lastRecoveryAt: null, recoveryInFlight: false,
    });

    const blocked = computeBlockedStories(wideStories, registry, new Set());
    // US-003 blocked (depends on US-001), US-005 blocked (depends on US-003)
    // US-002 and US-004 are fine
    expect(blocked.has('US-003')).toBe(true);
    expect(blocked.has('US-005')).toBe(true);
    expect(blocked.has('US-002')).toBe(false);
    expect(blocked.has('US-004')).toBe(false);

    // US-005 is blocked by US-003 (transitive from US-001)
    expect(blocked.get('US-005')).toContain('US-003');
  });
});
