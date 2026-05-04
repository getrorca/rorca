import { spawnSync } from "child_process";

import {
  DEFAULT_MAX_CONCURRENT,
  StorySemaphore,
  type ExecuteStoryResult,
  type Story,
  type StoryExecutionHandle,
  startStoryExecution,
} from "./story-executor";
import { preflight, resolveStoryModel } from "./preflight";

type SpecStory = Story & {
  excluded?: boolean;
  passes?: boolean;
  model?: string;
};

type RunStoryResult = {
  storyId?: string;
  story_id?: string;
  status?: string;
};

type RunResponse = {
  run?: {
    status?: string;
  };
  status?: string;
  storyResults?: RunStoryResult[];
};

type SpecResponse = {
  model?: string;
  status?: string;
  userStories?: SpecStory[];
  stories?: SpecStory[];
  _status?: string;
};

type FinalRunStatus = "passed" | "failed" | "cancelled";

type RunSpecParams = {
  specId: string;
  workspaceId: string;
  workspacePath: string;
  runId: number;
  model?: string;
  baseUrl?: string;
  token?: string;
  maxConcurrent?: number;
  dryRun?: boolean;
  onStoryUpdate?: (storyId: string, status: string) => void;
};

type StoryAttemptOutcome = {
  story: SpecStory;
  handle?: StoryExecutionHandle;
  result?: ExecuteStoryResult;
  error?: unknown;
  cancelledBeforeStart?: boolean;
};

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? "http://localhost:3030").replace(/\/$/, "");
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function apiFetchJson<T>(params: {
  baseUrl: string;
  token?: string;
  pathname: string;
  init?: RequestInit;
}): Promise<T> {
  const response = await fetch(`${params.baseUrl}${params.pathname}`, {
    ...params.init,
    headers: {
      ...buildHeaders(params.token),
      ...(params.init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText} (${params.pathname})`);
  }

  return (await response.json()) as T;
}

async function apiPostJson<T>(params: {
  baseUrl: string;
  token?: string;
  pathname: string;
  body: Record<string, unknown>;
}): Promise<T> {
  return await apiFetchJson<T>({
    baseUrl: params.baseUrl,
    token: params.token,
    pathname: params.pathname,
    init: {
      method: "POST",
      body: JSON.stringify(params.body),
    },
  });
}

function normalizeStoryStatus(status?: string): string {
  switch (status) {
    case "passed":
      return "pass";
    case "failed":
      return "fail";
    default:
      return status ?? "";
  }
}

function isStoryPassed(status?: string): boolean {
  return normalizeStoryStatus(status) === "pass";
}

function isStoryFailed(status?: string): boolean {
  return normalizeStoryStatus(status) === "fail";
}

function asFinalStatus(status?: string): FinalRunStatus | null {
  if (status === "passed" || status === "failed" || status === "cancelled") {
    return status;
  }

  return null;
}

function extractRunStatus(run: RunResponse): string | undefined {
  return run.run?.status ?? run.status;
}

async function fetchRun(baseUrl: string, token: string | undefined, runId: number): Promise<RunResponse> {
  return await apiFetchJson<RunResponse>({
    baseUrl,
    token,
    pathname: `/api/pipeline/runs/${runId}`,
  });
}

async function fetchSpec(params: {
  baseUrl: string;
  token?: string;
  specId: string;
  workspaceId: string;
}): Promise<SpecResponse> {
  return await apiFetchJson<SpecResponse>({
    baseUrl: params.baseUrl,
    token: params.token,
    pathname: `/api/specs/${encodeURIComponent(params.specId)}?workspaceId=${encodeURIComponent(params.workspaceId)}`,
  });
}

function getPassedStoryIdsFromRun(run: RunResponse): Set<string> {
  const passed = new Set<string>();

  for (const storyResult of run.storyResults ?? []) {
    const storyId = storyResult.storyId ?? storyResult.story_id;
    if (storyId && isStoryPassed(storyResult.status)) {
      passed.add(storyId);
    }
  }

  return passed;
}

function getFailedStoryIdsFromRun(run: RunResponse): Set<string> {
  const failed = new Set<string>();

  for (const storyResult of run.storyResults ?? []) {
    const storyId = storyResult.storyId ?? storyResult.story_id;
    if (storyId && isStoryFailed(storyResult.status)) {
      failed.add(storyId);
    }
  }

  return failed;
}

function summarizeError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "CYCLE_DETECTED") {
    const cycleError = error as { storyIds?: unknown };
    const storyIds = Array.isArray(cycleError.storyIds)
      ? cycleError.storyIds.filter((storyId): storyId is string => typeof storyId === "string")
      : [];
    return `CYCLE_DETECTED: ${storyIds.join(", ")}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function buildWaves(stories: Story[]): Story[][] {
  const storyMap = new Map<string, Story>();
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const story of stories) {
    storyMap.set(story.id, story);
    adjacency.set(story.id, []);
    inDegree.set(story.id, 0);
  }

  for (const story of stories) {
    const dependencyIds = new Set(story.dependsOn ?? []);
    for (const dependencyId of dependencyIds) {
      if (!storyMap.has(dependencyId)) {
        continue;
      }

      adjacency.get(dependencyId)?.push(story.id);
      inDegree.set(story.id, (inDegree.get(story.id) ?? 0) + 1);
    }
  }

  let ready = stories
    .filter((story) => (inDegree.get(story.id) ?? 0) === 0)
    .map((story) => story.id);

  const waves: Story[][] = [];
  const processed = new Set<string>();

  while (ready.length > 0) {
    const currentWaveIds = ready;
    const currentWave = currentWaveIds
      .map((storyId) => storyMap.get(storyId))
      .filter((story): story is Story => Boolean(story));

    waves.push(currentWave);
    ready = [];

    for (const storyId of currentWaveIds) {
      processed.add(storyId);
      for (const dependentId of adjacency.get(storyId) ?? []) {
        const nextDegree = (inDegree.get(dependentId) ?? 0) - 1;
        inDegree.set(dependentId, nextDegree);
        if (nextDegree === 0) {
          ready.push(dependentId);
        }
      }
    }
  }

  if (processed.size !== stories.length) {
    throw {
      code: "CYCLE_DETECTED",
      storyIds: stories.map((story) => story.id).filter((storyId) => !processed.has(storyId)),
    };
  }

  return waves;
}

function runGitCommand(args: string[], workspacePath: string): { ok: boolean; stderr: string } {
  const result = spawnSync("git", ["-C", workspacePath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });

  return {
    ok: result.status === 0 && !result.error,
    stderr: result.stderr?.toString().trim() || result.error?.message || "",
  };
}

async function finalizeRun(params: {
  baseUrl: string;
  token?: string;
  runId: number;
  status: FinalRunStatus;
  summary: string | null;
}): Promise<void> {
  await apiPostJson({
    baseUrl: params.baseUrl,
    token: params.token,
    pathname: `/api/pipeline/runs/${params.runId}/finalize`,
    body: {
      status: params.status,
      summary: params.summary,
    },
  });
}

function requestCancellation(activeHandles: Map<string, StoryExecutionHandle>): void {
  for (const handle of activeHandles.values()) {
    handle.cancel();
  }
}

async function waitForActiveHandles(activeHandles: Map<string, StoryExecutionHandle>): Promise<void> {
  const handles = Array.from(activeHandles.values());
  if (handles.length === 0) {
    return;
  }

  await Promise.allSettled(handles.map((handle) => handle.result));
}

async function mergeWave(params: {
  workspacePath: string;
  waveIndex: number;
  stories: SpecStory[];
  handles: Map<string, StoryExecutionHandle>;
  failedStories: Set<string>;
  onStoryUpdate?: (storyId: string, status: string) => void;
  dryRun?: boolean;
}): Promise<void> {
  if (params.dryRun) {
    return;
  }

  const mergedHandles: StoryExecutionHandle[] = [];

  for (const story of params.stories) {
    const handle = params.handles.get(story.id);
    if (!handle) {
      continue;
    }

    params.onStoryUpdate?.(story.id, "merging");
    const mergeResult = runGitCommand(
      ["merge", "--no-ff", handle.branchName, "--message", `Wave ${params.waveIndex + 1}: ${story.id} passed`],
      params.workspacePath,
    );

    if (!mergeResult.ok) {
      params.failedStories.add(story.id);
      params.onStoryUpdate?.(story.id, "failed");
      console.warn(`[rorca] merge failed for ${story.id}: ${mergeResult.stderr}`);
      continue;
    }

    mergedHandles.push(handle);
  }

  for (const handle of mergedHandles) {
    const removeWorktree = runGitCommand(["worktree", "remove", "--force", handle.worktreePath], params.workspacePath);
    if (!removeWorktree.ok) {
      console.warn(`[rorca] worktree cleanup failed for ${handle.storyId}: ${removeWorktree.stderr}`);
    }

    const deleteBranch = runGitCommand(["branch", "-d", handle.branchName], params.workspacePath);
    if (!deleteBranch.ok) {
      console.warn(`[rorca] branch cleanup failed for ${handle.storyId}: ${deleteBranch.stderr}`);
    }
  }
}

async function executeStoryBatch(params: {
  stories: SpecStory[];
  runId: number;
  specId: string;
  specModel?: string;
  workspacePath: string;
  baseUrl: string;
  token?: string;
  semaphore: StorySemaphore;
  activeHandles: Map<string, StoryExecutionHandle>;
  cancellation: { requested: boolean };
  onStoryUpdate?: (storyId: string, status: string) => void;
  dryRun?: boolean;
}): Promise<Array<PromiseSettledResult<StoryAttemptOutcome>>> {
  return await Promise.allSettled(
    params.stories.map((story) =>
      params.semaphore.acquire().then(async () => {
        try {
          if (params.cancellation.requested) {
            return { story, cancelledBeforeStart: true };
          }

          params.onStoryUpdate?.(story.id, "running");

          const resolvedModel = resolveStoryModel(story, { model: params.specModel });

          const handle = startStoryExecution({
            runId: params.runId,
            story,
            specSlug: params.specId,
            workspacePath: params.workspacePath,
            model: resolvedModel,
            baseUrl: params.baseUrl,
            token: params.token,
            dryRun: params.dryRun,
          });

          params.activeHandles.set(story.id, handle);
          try {
            const result = await handle.result;
            return { story, handle, result };
          } catch (error) {
            return { story, handle, error };
          } finally {
            params.activeHandles.delete(story.id);
          }
        } finally {
          params.semaphore.release();
        }
      }),
    ),
  );
}

function collectAttemptOutcomes(
  settled: Array<PromiseSettledResult<StoryAttemptOutcome>>,
): { outcomes: StoryAttemptOutcome[]; rejectedErrors: unknown[] } {
  const outcomes: StoryAttemptOutcome[] = [];
  const rejectedErrors: unknown[] = [];

  for (const result of settled) {
    if (result.status === "fulfilled") {
      outcomes.push(result.value);
    } else {
      rejectedErrors.push(result.reason);
    }
  }

  return { outcomes, rejectedErrors };
}

async function syncPassedStoryIds(baseUrl: string, token: string | undefined, runId: number, passedStoryIds: Set<string>): Promise<RunResponse> {
  const run = await fetchRun(baseUrl, token, runId);
  for (const storyId of getPassedStoryIdsFromRun(run)) {
    passedStoryIds.add(storyId);
  }
  return run;
}

export async function runSpec(
  params: RunSpecParams,
): Promise<{ status: "passed" | "failed" | "cancelled"; failedStories: string[]; durationMs: number }> {
  const startedAt = Date.now();
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const maxConcurrent = params.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const retryCounts = new Map<string, number>();
  const passedStoryIds = new Set<string>();
  const failedStoryIds = new Set<string>();
  const activeHandles = new Map<string, StoryExecutionHandle>();
  const cancellation = { requested: false };
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let cancelPollTimer: NodeJS.Timeout | undefined;
  let finalized = false;

  const finalizeOnce = async (status: FinalRunStatus, summary: string | null): Promise<void> => {
    if (finalized) {
      return;
    }

    finalized = true;
    await finalizeRun({
      baseUrl,
      token: params.token,
      runId: params.runId,
      status,
      summary,
    });
  };

  const cancelAndFinalize = async (): Promise<{
    status: "cancelled";
    failedStories: [];
    durationMs: number;
  }> => {
    cancellation.requested = true;
    requestCancellation(activeHandles);
    await waitForActiveHandles(activeHandles);
    await finalizeOnce("cancelled", "Cancelled by user request");

    return {
      status: "cancelled",
      failedStories: [],
      durationMs: Date.now() - startedAt,
    };
  };

  try {
    const initialRun = await syncPassedStoryIds(baseUrl, params.token, params.runId, passedStoryIds);
    const existingTerminalStatus = asFinalStatus(extractRunStatus(initialRun));
    if (existingTerminalStatus) {
      return {
        status: existingTerminalStatus,
        failedStories: existingTerminalStatus === "failed" ? Array.from(getFailedStoryIdsFromRun(initialRun)).sort() : [],
        durationMs: Date.now() - startedAt,
      };
    }

    const preflightResult = await preflight({
      specId: params.specId,
      workspaceId: params.workspaceId,
      workspacePath: params.workspacePath,
      baseUrl,
      token: params.token,
    });
    if (!preflightResult.ok) {
      const summary = preflightResult.errors.join("; ");
      await finalizeOnce("failed", summary);
      return {
        status: "failed",
        failedStories: [],
        durationMs: Date.now() - startedAt,
      };
    }

    for (const warning of preflightResult.warnings) {
      console.warn(`[rorca] preflight warning: ${warning}`);
    }

    const spec = await fetchSpec({
      baseUrl,
      token: params.token,
      specId: params.specId,
      workspaceId: params.workspaceId,
    });

    if (spec._status !== "approved") {
      throw new Error(`Spec ${params.specId} is not approved`);
    }

    const fetchedStories = spec.userStories ?? spec.stories ?? [];
    const activeStories = fetchedStories.filter(
      (story): story is SpecStory => Boolean(story?.id) && story.excluded !== true,
    );

    for (const story of activeStories) {
      if (story.passes === true) {
        passedStoryIds.add(story.id);
      }
    }

    const waves = buildWaves(activeStories);

    const refreshCancellation = async (): Promise<void> => {
      try {
        const run = await syncPassedStoryIds(baseUrl, params.token, params.runId, passedStoryIds);
        const status = extractRunStatus(run);
        if (status === "cancelling" || status === "cancelled") {
          cancellation.requested = true;
          requestCancellation(activeHandles);
        }
      } catch (error) {
        console.warn(`[rorca] cancellation poll failed for run ${params.runId}: ${summarizeError(error)}`);
      }
    };

    await refreshCancellation();
    if (cancellation.requested) {
      return await cancelAndFinalize();
    }

    heartbeatTimer = setInterval(() => {
      void apiPostJson({
        baseUrl,
        token: params.token,
        pathname: `/api/pipeline/runs/${params.runId}/heartbeat`,
        body: {},
      }).catch((error) => {
        console.warn(`[rorca] heartbeat failed for run ${params.runId}: ${summarizeError(error)}`);
      });
    }, 60_000);

    cancelPollTimer = setInterval(() => {
      void refreshCancellation();
    }, 10_000);

    for (const [waveIndex, wave] of waves.entries()) {
      await refreshCancellation();
      if (cancellation.requested) {
        return await cancelAndFinalize();
      }

      const runnableStories = wave.filter((story) => !passedStoryIds.has(story.id));
      if (runnableStories.length === 0) {
        continue;
      }

      const waveHandles = new Map<string, StoryExecutionHandle>();
      const semaphore = new StorySemaphore(maxConcurrent);
      const settled = await executeStoryBatch({
        stories: runnableStories,
        runId: params.runId,
        specId: params.specId,
        specModel: spec.model,
        workspacePath: params.workspacePath,
        baseUrl,
        token: params.token,
        semaphore,
        activeHandles,
        cancellation,
        onStoryUpdate: params.onStoryUpdate,
        dryRun: params.dryRun,
      });

      if (cancellation.requested) {
        return await cancelAndFinalize();
      }

      const { outcomes, rejectedErrors } = collectAttemptOutcomes(settled);
      for (const error of rejectedErrors) {
        console.warn(`[rorca] story batch promise rejected: ${summarizeError(error)}`);
      }

      const storiesNeedingRetry: SpecStory[] = [];

      for (const outcome of outcomes) {
        if (outcome.cancelledBeforeStart) {
          continue;
        }

        if (outcome.handle) {
          waveHandles.set(outcome.story.id, outcome.handle);
        }

        if (outcome.result?.status === "passed") {
          passedStoryIds.add(outcome.story.id);
          failedStoryIds.delete(outcome.story.id);
          params.onStoryUpdate?.(outcome.story.id, "passed");
          continue;
        }

        const currentRetries = retryCounts.get(outcome.story.id) ?? 0;
        if (currentRetries < 1 && !cancellation.requested) {
          retryCounts.set(outcome.story.id, currentRetries + 1);
          storiesNeedingRetry.push(outcome.story);
          params.onStoryUpdate?.(outcome.story.id, "retrying");
          continue;
        }

        failedStoryIds.add(outcome.story.id);
        params.onStoryUpdate?.(outcome.story.id, "failed");
      }

      if (storiesNeedingRetry.length > 0) {
        const retrySemaphore = new StorySemaphore(maxConcurrent);
        const retrySettled = await executeStoryBatch({
          stories: storiesNeedingRetry,
          runId: params.runId,
          specId: params.specId,
          specModel: spec.model,
          workspacePath: params.workspacePath,
          baseUrl,
          token: params.token,
          semaphore: retrySemaphore,
          activeHandles,
          cancellation,
          onStoryUpdate: params.onStoryUpdate,
          dryRun: params.dryRun,
        });

        if (cancellation.requested) {
          return await cancelAndFinalize();
        }

        const { outcomes: retryOutcomes, rejectedErrors: retryRejectedErrors } = collectAttemptOutcomes(retrySettled);
        for (const error of retryRejectedErrors) {
          console.warn(`[rorca] retry batch promise rejected: ${summarizeError(error)}`);
        }

        for (const outcome of retryOutcomes) {
          if (outcome.cancelledBeforeStart) {
            continue;
          }

          if (outcome.handle) {
            waveHandles.set(outcome.story.id, outcome.handle);
          }

          if (outcome.result?.status === "passed") {
            passedStoryIds.add(outcome.story.id);
            failedStoryIds.delete(outcome.story.id);
            params.onStoryUpdate?.(outcome.story.id, "passed");
            continue;
          }

          failedStoryIds.add(outcome.story.id);
          params.onStoryUpdate?.(outcome.story.id, "failed");
        }
      }

      await syncPassedStoryIds(baseUrl, params.token, params.runId, passedStoryIds);

      const mergeableStories = runnableStories.filter((story) => passedStoryIds.has(story.id));
      const waveFailed = runnableStories.some((story) => !passedStoryIds.has(story.id));
      if (waveFailed) {
        for (const story of runnableStories) {
          if (!passedStoryIds.has(story.id)) {
            failedStoryIds.add(story.id);
          }
        }
        continue;
      }

      await mergeWave({
        workspacePath: params.workspacePath,
        waveIndex,
        stories: mergeableStories,
        handles: waveHandles,
        failedStories: failedStoryIds,
        onStoryUpdate: params.onStoryUpdate,
        dryRun: params.dryRun,
      });

      for (const story of mergeableStories) {
        if (!failedStoryIds.has(story.id)) {
          params.onStoryUpdate?.(story.id, "merged");
        }
      }
    }

    if (cancellation.requested) {
      return await cancelAndFinalize();
    }

    const failedStories = Array.from(failedStoryIds).sort();
    const status: FinalRunStatus = failedStories.length === 0 ? "passed" : "failed";
    await finalizeOnce(
      status,
      failedStories.length > 0 ? `Failed stories: ${failedStories.join(", ")}` : null,
    );

    return {
      status,
      failedStories,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const summary = summarizeError(error);
    await finalizeOnce("failed", summary);

    return {
      status: "failed",
      failedStories: Array.from(failedStoryIds).sort(),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    if (cancelPollTimer) {
      clearInterval(cancelPollTimer);
    }
  }
}
