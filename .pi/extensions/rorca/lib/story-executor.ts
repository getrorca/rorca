import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

import { buildStoryPrompt } from "./prompt-builder";

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_CHUNK_BYTES = 6144;
const MAX_STDOUT_BUFFER_BYTES = 10 * 1024 * 1024;
const STDERR_TAIL_LIMIT = 4000;
const KILL_GRACE_MS = 10_000;

export const DEFAULT_MAX_CONCURRENT = 3;

export type Story = {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
};

export type ExecuteStoryParams = {
  runId: number;
  story: Story;
  specSlug: string;
  workspacePath: string;
  model?: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  maxOutputChunkBytes?: number;
  dryRun?: boolean;
};

export type ExecuteStoryResult = {
  status: "passed" | "failed";
  exitCode: number;
  commitSha?: string;
  stderrTail: string;
  durationMs: number;
};

export type StoryExecutionHandle = {
  storyId: string;
  branchName: string;
  worktreePath: string;
  result: Promise<ExecuteStoryResult>;
  cancel: () => void;
};

export class StorySemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent = DEFAULT_MAX_CONCURRENT) {}

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  release(): void {
    if (this.active > 0) {
      this.active -= 1;
    }

    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

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

function trimStderrTail(stderrBuffer: string, chunk: Buffer): string {
  const next = stderrBuffer + chunk.toString("utf8");
  return next.length <= STDERR_TAIL_LIMIT ? next : next.slice(-STDERR_TAIL_LIMIT);
}

function normalizeChunkSize(maxOutputChunkBytes?: number): number {
  if (!Number.isFinite(maxOutputChunkBytes) || !maxOutputChunkBytes || maxOutputChunkBytes <= 0) {
    return DEFAULT_MAX_OUTPUT_CHUNK_BYTES;
  }

  return Math.max(1, Math.floor(maxOutputChunkBytes));
}

function fireAndForgetStoryOutput(params: {
  baseUrl: string;
  headers: Record<string, string>;
  runId: number;
  storyId: string;
  data: string;
  sequence: number;
}): void {
  void fetch(
    `${params.baseUrl}/api/pipeline/runs/${params.runId}/stories/${encodeURIComponent(params.storyId)}/output`,
    {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify({
        data: params.data,
        sequence: params.sequence,
      }),
    },
  ).catch(() => {});
}

async function postStoryResult(params: {
  baseUrl: string;
  headers: Record<string, string>;
  runId: number;
  storyId: string;
  result: ExecuteStoryResult;
  model?: string;
}): Promise<void> {
  const payload: Record<string, unknown> = {
    status: params.result.status,
    exitCode: params.result.exitCode,
    stderrTail: params.result.stderrTail,
    durationMs: params.result.durationMs,
  };

  if (params.result.commitSha) {
    payload.commitSha = params.result.commitSha;
  }

  if (params.model) {
    payload.resolvedModel = params.model;
  }

  const response = await fetch(
    `${params.baseUrl}/api/pipeline/runs/${params.runId}/stories/${encodeURIComponent(params.storyId)}/result`,
    {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to post story result: ${response.status} ${response.statusText}`);
  }
}

function ensureWorktree(params: {
  workspacePath: string;
  storyId: string;
  specSlug: string;
  dryRun?: boolean;
}): { worktreePath: string; branchName: string } {
  const branchName = `feat/${params.specSlug}/${params.storyId}`;
  const worktreePath = path.join(
    params.workspacePath,
    "..",
    `${path.basename(params.workspacePath)}-worktrees`,
    params.storyId,
  );

  if (params.dryRun) {
    return { worktreePath, branchName };
  }

  mkdirSync(path.dirname(worktreePath), { recursive: true });

  const result = existsSync(worktreePath)
    ? spawnSync("git", ["-C", worktreePath, "checkout", branchName], {
        encoding: "utf8",
        timeout: 10_000,
      })
    : spawnSync("git", ["-C", params.workspacePath, "worktree", "add", "-b", branchName, worktreePath, "HEAD"], {
        encoding: "utf8",
        timeout: 10_000,
      });

  if (result.status !== 0 || result.error) {
    throw {
      code: "WORKTREE_CREATE_FAILED",
      stderr: result.stderr?.toString() || result.error?.message || "Unknown git worktree error",
    };
  }

  return { worktreePath, branchName };
}

function getLastCommitSha(worktreePath: string): string | undefined {
  const result = spawnSync("git", ["-C", worktreePath, "log", "-1", "--format=%H"], {
    encoding: "utf8",
    timeout: 5000,
  });

  if (result.status !== 0 || result.error) {
    return undefined;
  }

  const sha = result.stdout.trim();
  return sha || undefined;
}

export function startStoryExecution(params: ExecuteStoryParams): StoryExecutionHandle {
  const startMs = Date.now();
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChunkBytes = normalizeChunkSize(params.maxOutputChunkBytes);
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const headers = buildHeaders(params.token);
  const piBin = process.env.PI_BIN || "pi";
  const { worktreePath, branchName } = ensureWorktree({
    workspacePath: params.workspacePath,
    storyId: params.story.id,
    specSlug: params.specSlug,
    dryRun: params.dryRun,
  });

  let child: ReturnType<typeof spawn> | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let settled = false;
  let cancelled = false;
  let timeoutTimer: NodeJS.Timeout | undefined;
  const result = (async (): Promise<ExecuteStoryResult> => {
    if (params.dryRun) {
      return {
        status: "passed",
        exitCode: 0,
        durationMs: 0,
        stderrTail: "",
      };
    }

    const prompt = await buildStoryPrompt({
      story: params.story,
      specSlug: params.specSlug,
      workspacePath: params.workspacePath,
    });

    const promptFilePath = path.join(os.tmpdir(), `rorca-story-${params.story.id}-${Date.now()}.md`);
    writeFileSync(promptFilePath, prompt, "utf8");

    try {
      return await new Promise<ExecuteStoryResult>((resolve, reject) => {
        const args = ["run", "--jsonl", "--skill", promptFilePath];
        if (params.model) {
          args.push("--model", params.model);
        }
        args.push("--cwd", worktreePath);

        child = spawn(piBin, args, {
          cwd: worktreePath,
          env: {
            ...process.env,
            RORCA_PROCESS_ROLE: "pi_story_executor",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let sequence = 0;
        let stderrTail = "";
        let stdoutBufferedBytes = 0;
        let stdoutBuffer = Buffer.alloc(0);
        let warnedAboutStdoutLimit = false;

        const clearTimers = () => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (killTimer) clearTimeout(killTimer);
        };

        const finish = (result: ExecuteStoryResult) => {
          if (settled) return;
          settled = true;
          clearTimers();
          resolve(result);
        };

        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimers();
          reject(error);
        };

        timeoutTimer = setTimeout(() => {
          timedOut = true;
          child?.kill("SIGTERM");

          const timeoutResult: ExecuteStoryResult = {
            status: "failed",
            exitCode: 124,
            stderrTail: `TIMEOUT: story exceeded ${timeoutMs}ms`,
            durationMs: timeoutMs,
          };

          void postStoryResult({
            baseUrl,
            headers,
            runId: params.runId,
            storyId: params.story.id,
            result: timeoutResult,
            model: params.model,
          }).catch(() => {});

          killTimer = setTimeout(() => {
            if (!settled && child) {
              child.kill("SIGKILL");
            }
          }, KILL_GRACE_MS);
        }, timeoutMs);

        if (cancelled) {
          child.kill("SIGTERM");
        }

        child?.stdout?.on("data", (chunk: Buffer) => {
          if (stdoutBufferedBytes < MAX_STDOUT_BUFFER_BYTES) {
            const remaining = MAX_STDOUT_BUFFER_BYTES - stdoutBufferedBytes;
            const slice = chunk.subarray(0, remaining);
            if (slice.length > 0) {
              stdoutBuffer = Buffer.concat([stdoutBuffer, slice], stdoutBufferedBytes + slice.length);
              stdoutBufferedBytes += slice.length;
            }
            if (slice.length < chunk.length && !warnedAboutStdoutLimit) {
              warnedAboutStdoutLimit = true;
              console.warn(`[rorca] stdout buffer limit reached for ${params.story.id}; dropping in-memory bytes`);
            }
          } else if (!warnedAboutStdoutLimit) {
            warnedAboutStdoutLimit = true;
            console.warn(`[rorca] stdout buffer limit reached for ${params.story.id}; dropping in-memory bytes`);
          }
  
          for (let offset = 0; offset < chunk.length; offset += maxOutputChunkBytes) {
            const slice = chunk.subarray(offset, offset + maxOutputChunkBytes);
            fireAndForgetStoryOutput({
              baseUrl,
              headers,
              runId: params.runId,
              storyId: params.story.id,
              data: slice.toString("base64"),
              sequence: sequence++,
            });
          }
        });

        child?.stderr?.on("data", (chunk: Buffer) => {
          stderrTail = trimStderrTail(stderrTail, chunk);
        });

        child?.once("error", (error: Error) => {
          fail(error);
        });

        child?.once("close", async (code: number | null) => {
          const durationMs = Date.now() - startMs;
          void stdoutBuffer.length;

          if (timedOut) {
            finish({
              status: "failed",
              exitCode: 124,
              stderrTail: `TIMEOUT: story exceeded ${timeoutMs}ms`,
              durationMs: timeoutMs,
            });
            return;
          }

          const exitCode = cancelled && code === null ? 143 : (code ?? 1);
          const result: ExecuteStoryResult = exitCode === 0
            ? {
                status: "passed",
                exitCode: 0,
                commitSha: getLastCommitSha(worktreePath),
                stderrTail,
                durationMs,
              }
            : {
                status: "failed",
                exitCode,
                stderrTail: cancelled
                  ? `CANCELLED: ${stderrTail.slice(-STDERR_TAIL_LIMIT)}`
                  : stderrTail.slice(-STDERR_TAIL_LIMIT),
                durationMs,
              };

          try {
            await postStoryResult({
              baseUrl,
              headers,
              runId: params.runId,
              storyId: params.story.id,
              result,
              model: params.model,
            });
            finish(result);
          } catch (error) {
            fail(error);
          }
          });
      });
    } finally {
      try {
        unlinkSync(promptFilePath);
      } catch {
        // Temp file may already be gone; cleanup is best-effort.
      }
    }
  })();

  return {
    storyId: params.story.id,
    branchName,
    worktreePath,
    result,
    cancel: () => {
      cancelled = true;
      if (!child || settled) {
        return;
      }

      child.kill("SIGTERM");
      if (killTimer) {
        clearTimeout(killTimer);
      }
      killTimer = setTimeout(() => {
        if (!settled && child) {
          child.kill("SIGKILL");
        }
      }, KILL_GRACE_MS);
    },
  };
}

export async function executeStory(params: ExecuteStoryParams): Promise<ExecuteStoryResult> {
  return await startStoryExecution(params).result;
}
