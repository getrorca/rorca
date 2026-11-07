import type { ChildProcess } from "node:child_process";
import type { SupervisorConfig, SupervisorState, ValidationResult } from "./autonomous-supervisor-core.js";

export class JsonlRpcClient {
  constructor(child: ChildProcess, options?: { timeoutMs?: number });
  request(command: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  onEvent(listener: (event: any) => void): () => void;
  waitForSettled(signal?: AbortSignal): Promise<any>;
}

export function runValidationCommand(command: string, input?: { cwd?: string; timeoutMs?: number; outputLimit?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<ValidationResult>;

export class SupervisorCompanion {
  constructor(config: SupervisorConfig, options?: {
    spawn?: typeof import("node:child_process").spawn;
    runValidation?: typeof runValidationCommand;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  });
  config: SupervisorConfig;
  state: SupervisorState;
  stopping: boolean;
  start(): Promise<void>;
  onRpcEvent(event: { type: string; [key: string]: unknown }): void;
  heartbeat(): void;
  pause(reason: string): Promise<void>;
  resume(reason: string): Promise<void>;
  stop(reason?: string): Promise<void>;
}

export function main(argv?: string[]): Promise<number>;
