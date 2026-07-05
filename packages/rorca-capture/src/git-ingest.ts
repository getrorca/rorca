import { execFileSync } from "node:child_process";
import path from "node:path";
import type { CaptureConfig } from "./config.js";
import type { ResolvedWorkspace } from "./api.js";
import {
  CONTEXT_SAFETY_CONTRACT_VERSION,
  enforceContextSizeLimit,
  hashContextContent,
  normalizeContextPath,
  redactContextText,
  shouldCapturePath,
} from "./context-safety.js";

export const GIT_COMMIT_EVENT_SCHEMA = "rorca.git_commit/v1";
export const GIT_COMMIT_SOURCE_SYSTEM = "rorca-capture";

export type GitCommitFile = {
  path: string;
  additions?: number;
  deletions?: number;
  sizeBytes?: number;
  captured: boolean;
  ignoredReason?: "path-ignored" | "file-too-large";
};

export type GitCommitMetadata = {
  sha: string;
  shortSha: string;
  inputRef: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  subject: string;
  body: string;
  files: GitCommitFile[];
  relatedFiles: string[];
  ignoredFiles: GitCommitFile[];
  noiseReason?: "no-changed-files" | "all-changed-paths-ignored";
};

export type GitCommitContextEventPayload = {
  workspaceId: string;
  eventType: "git_commit";
  sourceSystem: typeof GIT_COMMIT_SOURCE_SYSTEM;
  sourceRef: string;
  actor: string;
  occurredAt: string;
  summary: string;
  payload: Record<string, unknown>;
  provenance: Record<string, unknown>;
  relatedFiles: string[];
  metadata: Record<string, unknown>;
  trustTier: "agent_observation";
  idempotencyKey: string;
  contentHash: string;
};

export type BuiltGitCommitEvent = {
  commit: GitCommitMetadata;
  payload: GitCommitContextEventPayload;
  contentHash: string;
  idempotencyKey: string;
  noisy: boolean;
  noiseReason?: GitCommitMetadata["noiseReason"];
};

export type LastRorcaRunPointer = {
  workspaceId?: string;
  finishedAt?: string | null;
  lastCompletedRunFinishedAt?: string | null;
  pointer?: string | null;
};

export function readGitCommit(config: CaptureConfig, ref: string): GitCommitMetadata {
  const inputRef = ref.trim() || "HEAD";
  const sha = git(config.repoPath, ["rev-parse", "--verify", `${inputRef}^{commit}`]).trim();
  const raw = git(config.repoPath, [
    "show",
    "-s",
    "--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B",
    sha,
  ]);
  const [fullSha, shortSha, authorName, authorEmail, authorDate, committerName, committerEmail, committerDate, ...messageParts] = raw.split("\0");
  const message = messageParts.join("\0").replace(/\s+$/u, "");
  const [subjectLine = "", ...bodyLines] = message.split(/\r?\n/u);
  const subject = redactContextText(subjectLine.trim(), config.redaction);
  const body = redactContextText(bodyLines.join("\n").trim(), config.redaction);
  const changedPaths = readCommitPaths(config.repoPath, sha);
  const stats = readCommitStats(config.repoPath, sha);
  const files = changedPaths.map((filePath) => buildCommitFile(config, sha, filePath, stats.get(filePath)));
  const relatedFiles = files.filter((file) => file.captured).map((file) => file.path).sort();
  const ignoredFiles = files.filter((file) => !file.captured);
  const noiseReason = files.length === 0
    ? "no-changed-files"
    : relatedFiles.length === 0
      ? "all-changed-paths-ignored"
      : undefined;

  return {
    sha: fullSha || sha,
    shortSha,
    inputRef,
    authorName,
    authorEmail,
    authorDate,
    committerName,
    committerEmail,
    committerDate,
    subject,
    body: truncate(body, 12_000),
    files,
    relatedFiles,
    ignoredFiles,
    ...(noiseReason ? { noiseReason } : {}),
  };
}

export function buildGitCommitContextEvent(
  config: CaptureConfig,
  workspace: Pick<ResolvedWorkspace, "id">,
  commit: GitCommitMetadata,
): BuiltGitCommitEvent {
  const contentHash = hashContextContent(commit.sha);
  const idempotencyKey = `context-event:${workspace.id}:git_commit:${contentHash}`;
  const actor = commit.authorEmail ? `git:${commit.authorEmail}` : "git";
  const summarySubject = commit.subject || "(no subject)";
  const summary = `git commit ${commit.shortSha}: ${summarySubject}`;
  const changedFiles = commit.files.map((file) => ({
    path: file.path,
    captured: file.captured,
    ...(file.additions !== undefined ? { additions: file.additions } : {}),
    ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
    ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
    ...(file.ignoredReason ? { ignoredReason: file.ignoredReason } : {}),
  }));
  const payloadBody = {
    schema: GIT_COMMIT_EVENT_SCHEMA,
    commit: {
      sha: commit.sha,
      shortSha: commit.shortSha,
      subject: commit.subject,
      body: commit.body,
      author: {
        name: commit.authorName,
        email: commit.authorEmail,
        date: commit.authorDate,
      },
      committer: {
        name: commit.committerName,
        email: commit.committerEmail,
        date: commit.committerDate,
      },
    },
    files: {
      changed: changedFiles,
      captured: commit.relatedFiles,
      ignored: commit.ignoredFiles.map((file) => ({ path: file.path, reason: file.ignoredReason ?? "path-ignored" })),
      changedCount: commit.files.length,
      capturedCount: commit.relatedFiles.length,
      ignoredCount: commit.ignoredFiles.length,
    },
    safety: {
      contractVersion: CONTEXT_SAFETY_CONTRACT_VERSION,
      redactionEnabled: config.redaction.enabled,
      maxFileBytes: config.ignore.maxFileBytes,
      maxEventBytes: config.ignore.maxEventBytes,
      ...(commit.noiseReason ? { noiseReason: commit.noiseReason } : {}),
    },
  };

  const eventPayload: GitCommitContextEventPayload = {
    workspaceId: workspace.id,
    eventType: "git_commit",
    sourceSystem: GIT_COMMIT_SOURCE_SYSTEM,
    sourceRef: `git:${commit.sha}`,
    actor,
    occurredAt: commit.committerDate || commit.authorDate || new Date().toISOString(),
    summary,
    payload: payloadBody,
    provenance: {
      command: "rorca-capture ingest-commit",
      sourceSystem: GIT_COMMIT_SOURCE_SYSTEM,
      gitRef: commit.inputRef,
      repoPathHash: hashContextContent(path.resolve(config.repoPath)),
      safetyContract: CONTEXT_SAFETY_CONTRACT_VERSION,
      pathFiltering: "context-safety",
    },
    relatedFiles: commit.relatedFiles,
    metadata: {
      schema: GIT_COMMIT_EVENT_SCHEMA,
      gitSha: commit.sha,
      gitShaHash: contentHash,
      idempotencyMode: "git-sha",
      candidateCount: 0,
    },
    trustTier: "agent_observation",
    idempotencyKey,
    contentHash,
  };

  const eventBytes = Buffer.byteLength(JSON.stringify(eventPayload), "utf8");
  if (!enforceContextSizeLimit(eventBytes, config.ignore, "event")) {
    throw new Error(`Git commit context event exceeds capture event size limit: ${commit.sha}`);
  }

  return {
    commit,
    payload: eventPayload,
    contentHash,
    idempotencyKey,
    noisy: Boolean(commit.noiseReason),
    ...(commit.noiseReason ? { noiseReason: commit.noiseReason } : {}),
  };
}

export function resolveGitRange(repoPath: string, sinceRef: string): string[] {
  const range = `${sinceRef}..HEAD`;
  return gitLines(repoPath, ["log", "--reverse", "--format=%H", range]);
}

export function resolveGitRangeSinceTimestamp(repoPath: string, timestamp: string): { baseRef: string | null; shas: string[] } {
  const baseRef = gitOptional(repoPath, ["rev-list", "-n", "1", `--before=${timestamp}`, "HEAD"])?.trim() || null;
  if (baseRef) {
    return { baseRef, shas: resolveGitRange(repoPath, baseRef) };
  }
  return {
    baseRef: null,
    shas: gitLines(repoPath, ["log", "--reverse", "--format=%H", `--since=${timestamp}`, "HEAD"]),
  };
}

export function extractLastRorcaRunFinishedAt(pointer: LastRorcaRunPointer): string | null {
  return pointer.finishedAt ?? pointer.lastCompletedRunFinishedAt ?? pointer.pointer ?? null;
}

function readCommitPaths(repoPath: string, sha: string): string[] {
  return [...new Set(gitLines(repoPath, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", sha])
    .map((item) => normalizeContextPath(item.trim()))
    .filter(Boolean))].sort();
}

function readCommitStats(repoPath: string, sha: string): Map<string, { additions?: number; deletions?: number }> {
  const stats = new Map<string, { additions?: number; deletions?: number }>();
  for (const line of gitLines(repoPath, ["show", "--numstat", "--format=", "--no-renames", sha])) {
    const [rawAdditions, rawDeletions, ...pathParts] = line.split("\t");
    const filePath = normalizeContextPath(pathParts.join("\t").trim());
    if (!filePath) continue;
    stats.set(filePath, {
      additions: parseNumstat(rawAdditions),
      deletions: parseNumstat(rawDeletions),
    });
  }
  return stats;
}

function buildCommitFile(
  config: CaptureConfig,
  sha: string,
  rawPath: string,
  stats: { additions?: number; deletions?: number } | undefined,
): GitCommitFile {
  const normalizedPath = normalizeContextPath(rawPath);
  if (!shouldCapturePath(normalizedPath, config.ignore)) {
    return {
      path: normalizedPath,
      captured: false,
      ignoredReason: "path-ignored",
      ...(stats?.additions !== undefined ? { additions: stats.additions } : {}),
      ...(stats?.deletions !== undefined ? { deletions: stats.deletions } : {}),
    };
  }

  const sizeBytes = readBlobSize(config.repoPath, sha, normalizedPath);
  if (sizeBytes !== undefined && !enforceContextSizeLimit(sizeBytes, config.ignore, "file")) {
    return {
      path: normalizedPath,
      captured: false,
      ignoredReason: "file-too-large",
      sizeBytes,
      ...(stats?.additions !== undefined ? { additions: stats.additions } : {}),
      ...(stats?.deletions !== undefined ? { deletions: stats.deletions } : {}),
    };
  }

  return {
    path: normalizedPath,
    captured: true,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(stats?.additions !== undefined ? { additions: stats.additions } : {}),
    ...(stats?.deletions !== undefined ? { deletions: stats.deletions } : {}),
  };
}

function readBlobSize(repoPath: string, sha: string, filePath: string): number | undefined {
  const output = gitOptional(repoPath, ["cat-file", "-s", `${sha}:${filePath}`]);
  if (!output) return undefined;
  const parsed = Number(output.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseNumstat(value: string | undefined): number | undefined {
  if (!value || value === "-") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function gitLines(repoPath: string, args: string[]): string[] {
  return git(repoPath, args).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function gitOptional(repoPath: string, args: string[]): string | null {
  try {
    return git(repoPath, args);
  } catch {
    return null;
  }
}

function git(repoPath: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    const message = stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(`git ${args.join(" ")} failed: ${message}`);
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}
