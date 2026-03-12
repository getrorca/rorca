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
function createLogger(): pino.Logger {
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
    } catch {
      // pino-pretty not available (bun compiled binary or missing dep) — use JSON
    }
  }
  return pino({
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const logger = createLogger();
