export function launchPersistentCompanion(configPath: string, options?: { spawn?: typeof import("node:child_process").spawn; sleep?: (ms: number) => Promise<void> }): Promise<number>;
export function main(argv?: string[]): Promise<number>;
