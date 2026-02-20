import pino, { type LoggerOptions } from "pino";

type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

export function createLogger(level: LogLevel) {
  const options: LoggerOptions = {
    level,
    timestamp: pino.stdTimeFunctions.isoTime
  };

  return pino(options);
}

