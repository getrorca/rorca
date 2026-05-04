import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";

const DEFAULT_MODEL = "claude-opus-4-6";
const MIN_AVAILABLE_DISK_KB = 500 * 1024;
const COMMAND_TIMEOUT_MS = 5000;

type StoryLike = {
  id?: string;
  model?: string;
};

type SpecLike = {
  model?: string;
  _status?: string;
  status?: string;
  userStories?: StoryLike[];
  stories?: StoryLike[];
};

type ModelsResponse =
  | string[]
  | {
      models?: Array<string | { id?: string; model?: string; name?: string }>;
      items?: Array<string | { id?: string; model?: string; name?: string }>;
    };

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function resolveApprovedSpecPath(workspacePath: string, specId: string): string {
  return path.join(workspacePath, "forge", "specs", "approved", `${specId}.json`);
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

function logWarning(message: string): void {
  console.warn(`[rorca] ${message}`);
}

function extractModelIds(payload: ModelsResponse): string[] {
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.models)
      ? payload.models
      : Array.isArray(payload.items)
        ? payload.items
        : [];

  return items
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      return item.id ?? item.model ?? item.name ?? null;
    })
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

async function fetchSupportedModels(baseUrl: string, token?: string): Promise<Set<string> | null> {
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/direction/models`, {
      method: "GET",
      headers: buildHeaders(token),
    });

    if (!response.ok) {
      logWarning(`model validation skipped: GET /api/direction/models returned ${response.status}`);
      return null;
    }

    const payload = (await response.json()) as ModelsResponse;
    return new Set(extractModelIds(payload));
  } catch (error) {
    logWarning(`model validation skipped: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function validateResolvedModel(params: {
  model: string;
  baseUrl: string;
  token?: string;
  warnings?: string[];
  supportedModels?: Set<string> | null;
  skipFetch?: boolean;
}): Promise<Set<string> | null> {
  const supportedModels =
    params.supportedModels !== undefined
      ? params.supportedModels
      : params.skipFetch
        ? null
        : await fetchSupportedModels(params.baseUrl, params.token);
  if (!supportedModels || supportedModels.has(params.model)) {
    return supportedModels;
  }

  const warning = `Model "${params.model}" is not listed by /api/direction/models; continuing anyway`;
  logWarning(warning);
  params.warnings?.push(warning);
  return supportedModels;
}

async function fetchSpec(params: {
  specId: string;
  workspaceId: string;
  baseUrl: string;
  token?: string;
}): Promise<SpecLike | null> {
  try {
    const response = await fetch(
      `${normalizeBaseUrl(params.baseUrl)}/api/specs/${encodeURIComponent(params.specId)}?workspaceId=${encodeURIComponent(params.workspaceId)}`,
      {
        method: "GET",
        headers: buildHeaders(params.token),
      },
    );

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as SpecLike;
  } catch {
    return null;
  }
}

function loadSpecFromDisk(specPath: string): SpecLike | null {
  try {
    return JSON.parse(readFileSync(specPath, "utf8")) as SpecLike;
  } catch (error) {
    logWarning(`failed to read spec from disk (${specPath}): ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function postPreflightFailureWal(params: {
  baseUrl: string;
  token?: string;
  workspaceId: string;
  specId: string;
  errors: string[];
}): Promise<void> {
  try {
    const response = await fetch(`${normalizeBaseUrl(params.baseUrl)}/api/wal`, {
      method: "POST",
      headers: buildHeaders(params.token),
      body: JSON.stringify({
        type: "pi_native_preflight_failed",
        workspaceId: params.workspaceId,
        specId: params.specId,
        errors: params.errors,
      }),
    });

    if (!response.ok) {
      logWarning(`failed to post preflight WAL event: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    logWarning(`failed to post preflight WAL event: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseAvailableDiskKb(dfOutput: string): number | null {
  const lines = dfOutput.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return null;
  }

  const columns = lines[1].trim().split(/\s+/);
  if (columns.length < 4) {
    return null;
  }

  const available = Number(columns[3]);
  return Number.isFinite(available) ? available : null;
}

function resolvePiBin(): string {
  const envBin = process.env.PI_BIN?.trim();
  return envBin || "pi";
}

export function resolveStoryModel(story: { model?: string }, spec: { model?: string }): string {
  // Canonical precedence only: story -> spec -> env -> hard default.
  return story.model || spec.model || process.env.RORCA_MODEL || DEFAULT_MODEL;
}

export async function preflight(params: {
  specId: string;
  workspaceId: string;
  workspacePath: string;
  baseUrl: string;
  token?: string;
}): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const approvedSpecPath = resolveApprovedSpecPath(params.workspacePath, params.specId);
  const approvedSpecExists = existsSync(approvedSpecPath);

  if (!existsSync(params.workspacePath)) {
    errors.push(`Workspace path does not exist: ${params.workspacePath}`);
  } else {
    const gitStatus = spawnSync("git", ["-C", params.workspacePath, "status"], {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
    });
    if (gitStatus.status !== 0) {
      errors.push("Workspace is not a git repository");
    }
  }

  const apiSpec = await fetchSpec({
    specId: params.specId,
    workspaceId: params.workspaceId,
    baseUrl,
    token: params.token,
  });
  const diskSpec = approvedSpecExists ? loadSpecFromDisk(approvedSpecPath) : null;
  const apiSpecApproved = apiSpec?._status === "approved" || apiSpec?.status === "approved";
  const spec = apiSpecApproved ? apiSpec : (diskSpec ?? apiSpec);
  const isApproved = apiSpecApproved || approvedSpecExists;
  if (!isApproved) {
    errors.push(`Spec ${params.specId} is not approved — move it to forge/specs/approved/ first`);
  }

  const piBin = resolvePiBin();
  const piVersion = spawnSync(piBin, ["--version"], {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (piVersion.status !== 0) {
    errors.push(`Pi binary not found or not executable: ${piBin}. Run: npm i -g @mariozechner/pi-coding-agent`);
  }

  if (existsSync(params.workspacePath)) {
    const dirtyStatus = spawnSync("git", ["-C", params.workspacePath, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
    });
    if ((dirtyStatus.stdout ?? "").trim().length > 0) {
      warnings.push(
        "Workspace has uncommitted changes — worktrees will branch from the current state including uncommitted files",
      );
    }
  }

  if (process.platform === "win32") {
    warnings.push("Disk space check skipped on this platform");
  } else if (existsSync(params.workspacePath)) {
    const diskCheck = spawnSync("df", ["-k", params.workspacePath], {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
    });

    if (diskCheck.status === 0) {
      const availableKb = parseAvailableDiskKb(diskCheck.stdout ?? "");
      if (availableKb !== null && availableKb < MIN_AVAILABLE_DISK_KB) {
        errors.push(`Insufficient disk space: ${availableKb}KB available, 500MB required per worktree slot`);
      } else if (availableKb === null) {
        warnings.push("Disk space check could not parse `df -k` output");
      }
    } else {
      warnings.push("Disk space check could not run `df -k`");
    }
  }

  if (spec) {
    const stories = spec.userStories ?? spec.stories ?? [];
    const modelsToValidate = new Set<string>();
    const supportedModels = await fetchSupportedModels(baseUrl, params.token);

    modelsToValidate.add(resolveStoryModel({}, spec));

    for (const story of stories) {
      modelsToValidate.add(resolveStoryModel(story, spec));
    }

    for (const model of modelsToValidate) {
      await validateResolvedModel({
        model,
        baseUrl,
        token: params.token,
        warnings,
        supportedModels,
        skipFetch: true,
      });
    }
  }

  if (errors.length > 0) {
    await postPreflightFailureWal({
      baseUrl,
      token: params.token,
      workspaceId: params.workspaceId,
      specId: params.specId,
      errors,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}
