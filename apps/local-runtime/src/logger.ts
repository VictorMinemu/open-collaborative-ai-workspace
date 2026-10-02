// Tiny stderr logger. Every line passes through redact(); callers must still never pass secrets.

import { redact } from './sanitize.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: LogLevel = 'info', write: (line: string) => void = (l) => process.stderr.write(l)): Logger {
  const min = ORDER[level];
  const log = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    let line = `${new Date().toISOString()} ${lvl.toUpperCase()} ${msg}`;
    if (meta && Object.keys(meta).length > 0) {
      try {
        line += ` ${JSON.stringify(meta)}`;
      } catch {
        // ignore unserialisable meta
      }
    }
    write(`${redact(line)}\n`);
  };
  return {
    debug: (m, x) => log('debug', m, x),
    info: (m, x) => log('info', m, x),
    warn: (m, x) => log('warn', m, x),
    error: (m, x) => log('error', m, x),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
