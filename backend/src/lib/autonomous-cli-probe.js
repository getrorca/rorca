/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
/** Sandboxed, networkless probes for model/tool CLI version and help output. */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareAutonomousSandboxLaunch } from './autonomous-sandbox';
function probeWorkspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-cli-probe-'));
}
export function probeAutonomousCliSync(command, args, options = {}) {
    const cwd = probeWorkspace();
    try {
        const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter((entry) => entry[1] !== undefined));
        const launch = prepareAutonomousSandboxLaunch({ command, args, cwd, env });
        const result = spawnSync(launch.command, launch.args, {
            cwd: launch.cwd,
            env: launch.env,
            encoding: 'utf8',
            timeout: options.timeoutMs ?? 2_000,
            killSignal: 'SIGKILL',
            maxBuffer: 64 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return {
            status: result.status,
            signal: result.signal,
            stdout: String(result.stdout ?? ''),
            stderr: String(result.stderr ?? ''),
            ...(result.error ? { error: result.error } : {}),
        };
    }
    catch (error) {
        return {
            status: null,
            signal: null,
            stdout: '',
            stderr: '',
            error: error instanceof Error ? error : new Error(String(error)),
        };
    }
    finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
}
export async function probeAutonomousCli(command, args, options = {}) {
    const cwd = probeWorkspace();
    try {
        const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter((entry) => entry[1] !== undefined));
        const launch = prepareAutonomousSandboxLaunch({ command, args, cwd, env });
        return await new Promise(resolve => {
            let stdout = '';
            let stderr = '';
            let settled = false;
            const child = spawn(launch.command, launch.args, {
                cwd: launch.cwd,
                env: launch.env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const finish = (status, signal, error) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                resolve({ status, signal, stdout, stderr, ...(error ? { error } : {}) });
            };
            child.stdout?.on('data', chunk => { if (stdout.length < 64 * 1024)
                stdout += String(chunk); });
            child.stderr?.on('data', chunk => { if (stderr.length < 64 * 1024)
                stderr += String(chunk); });
            child.once('error', error => finish(null, null, error));
            child.once('close', (status, signal) => finish(status, signal));
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                finish(null, 'SIGKILL', new Error('Autonomous CLI probe timed out'));
            }, options.timeoutMs ?? 2_000);
            timer.unref();
        });
    }
    catch (error) {
        return {
            status: null,
            signal: null,
            stdout: '',
            stderr: '',
            error: error instanceof Error ? error : new Error(String(error)),
        };
    }
    finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
}
