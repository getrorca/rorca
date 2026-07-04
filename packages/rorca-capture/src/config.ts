import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  normalizeContextIgnoreSettings,
  normalizeContextRedactionSettings,
  type ContextIgnoreSettings,
  type ContextRedactionSettings,
  type NormalizedContextIgnoreSettings,
  type NormalizedContextRedactionSettings,
} from "./context-safety.js";

export const DEFAULT_RORCA_API_URL = "http://localhost:3030";
export const DEFAULT_CAPTURE_QUEUE_RELATIVE_PATH = ".rorca/capture-queue.ndjson";

export type CaptureMode = "local" | "vm" | "ci";
export type ConfigSource = "flag" | "env" | "rorca-config" | "capture-config" | "auto";

export type CaptureConfigSourceMap = Partial<Record<keyof CaptureConfigValues, ConfigSource>>;

export type CaptureConfigValues = {
  apiUrl?: string;
  workspaceId?: string;
  repoPath?: string;
  queuePath?: string;
  mode?: CaptureMode;
  ignore?: ContextIgnoreSettings;
  redaction?: ContextRedactionSettings;
};

export type CaptureConfigFile = CaptureConfigValues & {
  rorcaApiUrl?: string;
  capture?: CaptureConfigValues & { rorcaApiUrl?: string };
};

export type CaptureConfig = {
  apiUrl: string;
  workspaceId?: string;
  repoPath: string;
  queuePath: string;
  mode: CaptureMode;
  ignore: NormalizedContextIgnoreSettings;
  redaction: NormalizedContextRedactionSettings;
  sources: CaptureConfigSourceMap;
  configFiles: {
    rorcaConfig?: string;
    captureConfig?: string;
  };
  apiOnly: true;
};

export type ResolveCaptureConfigOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  ci?: boolean;
  overrides?: CaptureConfigValues;
  gitRoot?: string | null;
};

export type CaptureConfigErrorCode =
  | "MISSING_API_URL"
  | "MISSING_REPO_PATH"
  | "INVALID_CONFIG"
  | "INVALID_MODE";

export class CaptureConfigError extends Error {
  readonly code: CaptureConfigErrorCode;
  readonly statusCode = 400;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: CaptureConfigErrorCode, details?: Record<string, unknown>) {
    super(message);
    this.name = "CaptureConfigError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { error: string; code: string; details?: Record<string, unknown> } {
    return {
      error: this.message,
      code: this.code,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function resolveCaptureConfig(options: ResolveCaptureConfigOptions = {}): CaptureConfig {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const ciMode = options.ci === true || env.CI === "true";
  const detectedGitRoot = options.gitRoot === undefined ? detectGitRoot(cwd) : options.gitRoot;
  const fileRoot = path.resolve(options.overrides?.repoPath ?? env.RORCA_REPO_PATH ?? detectedGitRoot ?? cwd);

  const values: CaptureConfigValues = {};
  const sources: CaptureConfigSourceMap = {};

  applyCandidate(values, sources, normalizeConfigInput(options.overrides), "flag");
  applyCandidate(values, sources, envConfig(env), "env");

  const rorcaConfigPath = path.join(fileRoot, ".rorca", "config.json");
  const captureConfigPath = path.join(fileRoot, ".rorca", "capture.json");
  const rorcaFile = readConfigFile(rorcaConfigPath);
  const captureFile = readConfigFile(captureConfigPath);

  applyCandidate(values, sources, rorcaFile?.values, "rorca-config");
  applyCandidate(values, sources, captureFile?.values, "capture-config", { overrideLowerPriority: true });

  if (ciMode) {
    values.mode = "ci";
    sources.mode = options.ci === true ? "flag" : "env";
  } else if (!values.mode) {
    values.mode = "local";
    sources.mode = "auto";
  }

  if (!isCaptureMode(values.mode)) {
    throw new CaptureConfigError(`Invalid Rorca capture mode: ${String(values.mode)}`, "INVALID_MODE", {
      validModes: ["local", "vm", "ci"],
    });
  }

  if (!values.repoPath) {
    if (detectedGitRoot) {
      values.repoPath = detectedGitRoot;
      sources.repoPath = "auto";
    } else if (values.mode === "ci") {
      throw new CaptureConfigError("Rorca capture requires an explicit repo path or git root in CI mode.", "MISSING_REPO_PATH", {
        cwd,
      });
    } else {
      values.repoPath = cwd;
      sources.repoPath = "auto";
    }
  }
  values.repoPath = path.resolve(values.repoPath);

  if (!values.apiUrl) {
    if (values.mode === "ci") {
      throw new CaptureConfigError("RORCA_API_URL is required for rorca-capture in CI mode.", "MISSING_API_URL", {
        mode: values.mode,
        discoveryOrder: ["RORCA_API_URL", ".rorca/config.json", ".rorca/capture.json"],
      });
    }
    values.apiUrl = DEFAULT_RORCA_API_URL;
    sources.apiUrl = "auto";
  }
  values.apiUrl = values.apiUrl.replace(/\/$/, "");

  if (!values.queuePath) {
    values.queuePath = path.join(values.repoPath, DEFAULT_CAPTURE_QUEUE_RELATIVE_PATH);
    sources.queuePath = "auto";
  } else if (!path.isAbsolute(values.queuePath)) {
    values.queuePath = path.join(values.repoPath, values.queuePath);
  }

  const ignore = normalizeContextIgnoreSettings(values.ignore);
  const redaction = normalizeContextRedactionSettings(values.redaction);

  return {
    apiUrl: values.apiUrl,
    workspaceId: values.workspaceId,
    repoPath: values.repoPath,
    queuePath: values.queuePath,
    mode: values.mode,
    ignore,
    redaction,
    sources,
    configFiles: {
      ...(rorcaFile ? { rorcaConfig: rorcaConfigPath } : {}),
      ...(captureFile ? { captureConfig: captureConfigPath } : {}),
    },
    apiOnly: true,
  };
}

export function detectGitRoot(cwd: string): string | null {
  try {
    const stdout = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const root = stdout.trim();
    return root.length > 0 ? path.resolve(root) : null;
  } catch {
    return null;
  }
}

function readConfigFile(filePath: string): { values: CaptureConfigValues } | null {
  if (!existsSync(filePath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as CaptureConfigFile;
    return { values: normalizeConfigInput(parsed) ?? {} };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CaptureConfigError(`Invalid Rorca capture config at ${filePath}: ${message}`, "INVALID_CONFIG", {
      filePath,
    });
  }
}

function applyCandidate(
  values: CaptureConfigValues,
  sources: CaptureConfigSourceMap,
  candidate: CaptureConfigValues | undefined,
  source: ConfigSource,
  options: { overrideLowerPriority?: boolean } = {},
): void {
  if (!candidate) return;
  setIfPresent(values, sources, "apiUrl", candidate.apiUrl, source, options);
  setIfPresent(values, sources, "workspaceId", candidate.workspaceId, source, options);
  setIfPresent(values, sources, "repoPath", candidate.repoPath, source, options);
  setIfPresent(values, sources, "queuePath", candidate.queuePath, source, options);
  setIfPresent(values, sources, "mode", candidate.mode, source, options);
  mergeNested(values, sources, "ignore", candidate.ignore, source, options);
  mergeNested(values, sources, "redaction", candidate.redaction, source, options);
}

function setIfPresent<K extends keyof CaptureConfigValues>(
  values: CaptureConfigValues,
  sources: CaptureConfigSourceMap,
  key: K,
  value: CaptureConfigValues[K],
  source: ConfigSource,
  options: { overrideLowerPriority?: boolean } = {},
): void {
  if (value == null || value === "") return;
  const currentSource = sources[key];
  if (values[key] != null && !(options.overrideLowerPriority && canOverride(currentSource))) return;
  values[key] = value;
  sources[key] = source;
}

function mergeNested<K extends "ignore" | "redaction">(
  values: CaptureConfigValues,
  sources: CaptureConfigSourceMap,
  key: K,
  value: CaptureConfigValues[K],
  source: ConfigSource,
  options: { overrideLowerPriority?: boolean } = {},
): void {
  const incoming = compactObject(value);
  if (!incoming) return;
  const existing = compactObject(values[key]);
  const currentSource = sources[key];
  const incomingWins = options.overrideLowerPriority && canOverride(currentSource);
  values[key] = incomingWins
    ? { ...(existing ?? {}), ...incoming } as CaptureConfigValues[K]
    : { ...incoming, ...(existing ?? {}) } as CaptureConfigValues[K];
  if (!currentSource || incomingWins) sources[key] = source;
}

function canOverride(source: ConfigSource | undefined): boolean {
  return source == null || source === "rorca-config" || source === "auto";
}

function envConfig(env: NodeJS.ProcessEnv): CaptureConfigValues {
  return normalizeConfigInput({
    apiUrl: env.RORCA_API_URL,
    workspaceId: env.RORCA_WORKSPACE_ID,
    repoPath: env.RORCA_REPO_PATH,
    queuePath: env.RORCA_QUEUE_PATH,
    mode: env.RORCA_CAPTURE_MODE as CaptureMode | undefined,
    ignore: {
      paths: splitList(env.RORCA_CAPTURE_IGNORE_PATHS),
      maxFileBytes: parsePositiveInteger(env.RORCA_CAPTURE_MAX_FILE_BYTES),
      maxEventBytes: parsePositiveInteger(env.RORCA_CAPTURE_MAX_EVENT_BYTES),
    },
    redaction: {
      enabled: parseBoolean(env.RORCA_CAPTURE_REDACTION_ENABLED),
      patterns: splitList(env.RORCA_CAPTURE_REDACTION_PATTERNS),
    },
  }) ?? {};
}

function normalizeConfigInput(input: CaptureConfigFile | CaptureConfigValues | undefined): CaptureConfigValues | undefined {
  if (!input) return undefined;
  const fileInput = input as CaptureConfigFile;
  const nested = fileInput.capture ?? {};
  const apiUrl = input.apiUrl ?? fileInput.rorcaApiUrl ?? nested.apiUrl ?? nested.rorcaApiUrl;
  const workspaceId = input.workspaceId ?? nested.workspaceId;
  const repoPath = input.repoPath ?? nested.repoPath;
  const queuePath = input.queuePath ?? nested.queuePath;
  const mode = normalizeMode(input.mode ?? nested.mode);
  const ignore = mergeDefined(input.ignore, nested.ignore);
  const redaction = mergeDefined(input.redaction, nested.redaction);

  return {
    ...(apiUrl ? { apiUrl } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(repoPath ? { repoPath } : {}),
    ...(queuePath ? { queuePath } : {}),
    ...(mode ? { mode } : {}),
    ...(ignore ? { ignore } : {}),
    ...(redaction ? { redaction } : {}),
  };
}

function mergeDefined<T extends object>(base?: T, nested?: T): T | undefined {
  const compactBase = compactObject(base);
  const compactNested = compactObject(nested);
  if (!compactBase && !compactNested) return undefined;
  return { ...(compactBase ?? {}), ...(compactNested ?? {}) } as T;
}

function compactObject<T extends object>(value?: T): T | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== "");
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries) as T;
}

function normalizeMode(value: unknown): CaptureMode | undefined {
  if (value == null || value === "") return undefined;
  if (value === "local" || value === "vm" || value === "ci") return value;
  return value as CaptureMode;
}

function isCaptureMode(value: unknown): value is CaptureMode {
  return value === "local" || value === "vm" || value === "ci";
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value == null || value === "") return undefined;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return undefined;
}
