export interface SupervisorSandbox { kind: "sandbox-exec" | "bwrap"; command: string }
export function detectSupervisorSandbox(): SupervisorSandbox | null;
export function buildSandboxedShellInvocation(command: string, input: { cwd: string; tempDir?: string; sandbox?: SupervisorSandbox | null; containerized?: boolean }): { command: string; args: string[]; cwd: string; tempDir: string; sandbox: string };
