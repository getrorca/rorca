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

export const logger = pino({
  level,
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      }
    : {
        timestamp: pino.stdTimeFunctions.isoTime,
      }),
});
