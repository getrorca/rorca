/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
/**
 * PR-008: Structured JSON logging via pino.
 *
 * - Production: JSON format (pipe to Datadog / Grafana Loki / ELK)
 * - Development: pino-pretty formatted output
 * - Log level controlled by LOG_LEVEL env var (default: 'info')
 */
import pino from 'pino';
const isDev = process.env.NODE_ENV === 'development';
const level = process.env.LOG_LEVEL ?? 'info';
// DIST-004: pino transport system uses dynamic require/worker threads which breaks
// bun compile. Use pino-pretty only in dev AND when not running as compiled binary.
// The Bun compiled binary always has process.env.NODE_ENV='production'.
function createLogger() {
    // Only attempt pino-pretty in dev mode AND when the module is actually available
    if (isDev) {
        try {
            // Dynamic require check — prevents bun bundler from statically resolving
            const prettyTarget = ['pino', 'pretty'].join('-');
            require.resolve(prettyTarget);
            return pino({
                level,
                transport: {
                    target: prettyTarget,
                    options: {
                        colorize: true,
                        translateTime: 'SYS:standard',
                        ignore: 'pid,hostname',
                    },
                },
            });
        }
        catch {
            // pino-pretty not available (bun compiled binary or missing dep) — use JSON
        }
    }
    // When running as the execution-engine subprocess, disable sonic-boom's 4KB
    // write buffer so output streams to the worker in real-time rather than in
    // 4KB blobs. RORCA_PROCESS_ROLE=engine is set by worker.ts before spawning.
    const dest = process.env.RORCA_PROCESS_ROLE === 'engine'
        ? pino.destination({ minLength: 0, sync: false })
        : undefined;
    return pino({
        level,
        timestamp: pino.stdTimeFunctions.isoTime,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }, dest);
}
export const logger = createLogger();
