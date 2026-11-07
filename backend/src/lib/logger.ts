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

const STRIPE_CREDENTIAL_LOG_VALUE = /\b(?:[sr]k_(?:test|live)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,})\b/g;
export const STRIPE_CREDENTIAL_LOG_REDACTION = '[REDACTED_STRIPE_CREDENTIAL]' as const;

function redactStripeCredentialText(value: string): string {
  return value.replace(STRIPE_CREDENTIAL_LOG_VALUE, STRIPE_CREDENTIAL_LOG_REDACTION);
}

/**
 * Last-resort structured-log boundary for Stripe API keys and webhook signing
 * secrets. Provider adapters must still reject these values before persistence.
 */
export function redactStripeCredentialLogValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === 'string') return redactStripeCredentialText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    return redactStripeCredentialLogValue(pino.stdSerializers.err(value), seen);
  }
  if (Buffer.isBuffer(value)) {
    const text = value.toString('utf8');
    return redactStripeCredentialText(text) === text ? value : STRIPE_CREDENTIAL_LOG_REDACTION;
  }
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => redactStripeCredentialLogValue(entry, seen));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[redactStripeCredentialText(key)] = redactStripeCredentialLogValue(entry, seen);
  }
  return redacted;
}

const stripeCredentialLogHooks: NonNullable<pino.LoggerOptions['hooks']> = {
  logMethod(inputArgs, method) {
    // Pino's overloaded LogFn loses its runtime tuple through Array.map; arity and order are unchanged.
    const redactedArgs = inputArgs
      .map((value) => redactStripeCredentialLogValue(value)) as unknown as Parameters<pino.LogFn>;
    method.apply(this, redactedArgs);
  },
};

// DIST-004: pino transport system uses dynamic require/worker threads which breaks
// bun compile. Use pino-pretty only in dev AND when not running as compiled binary.
// The Bun compiled binary always has process.env.NODE_ENV='production'.
export function createLogger(destination?: pino.DestinationStream): pino.Logger {
  const baseOptions: pino.LoggerOptions = {
    level,
    hooks: stripeCredentialLogHooks,
  };

  if (destination) {
    return pino({
      ...baseOptions,
      timestamp: pino.stdTimeFunctions.isoTime,
    }, destination);
  }

  // Only attempt pino-pretty in dev mode AND when the module is actually available
  if (isDev) {
    try {
      // Dynamic require check — prevents bun bundler from statically resolving
      const prettyTarget = ['pino', 'pretty'].join('-');
      require.resolve(prettyTarget);
      return pino({
        ...baseOptions,
        transport: {
          target: prettyTarget,
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      });
    } catch {
      // pino-pretty not available (bun compiled binary or missing dep) — use JSON
    }
  }
  // When running as the execution-engine subprocess, disable sonic-boom's 4KB
  // write buffer so output streams to the worker in real-time rather than in
  // 4KB blobs. RORCA_PROCESS_ROLE=engine is set by worker.ts before spawning.
  const dest = process.env.RORCA_PROCESS_ROLE === 'engine'
    ? pino.destination({ minLength: 0, sync: false })
    : undefined;
  const options = {
    ...baseOptions,
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return dest ? pino(options, dest) : pino(options);
}

export const logger = createLogger();
