import { Logger } from '@nestjs/common';

type MutableLogger = Logger & {
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
  verbose: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  fatal?: (...args: unknown[]) => void;
};

function noop(..._args: unknown[]): void {}

export function rtbPathLogsEnabled(): boolean {
  return process.env.RTB_ENABLE_ALL_LOGS === 'true';
}

export function createRtbPathLogger(context: string): Logger {
  const logger = new Logger(context);

  if (rtbPathLogsEnabled()) {
    return logger;
  }

  const mutedLogger = logger as MutableLogger;
  mutedLogger.log = noop;
  mutedLogger.error = noop;
  mutedLogger.warn = noop;
  mutedLogger.debug = noop;
  mutedLogger.verbose = noop;

  if (mutedLogger.fatal) {
    mutedLogger.fatal = noop;
  }

  return logger;
}
