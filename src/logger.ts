import pino from "pino";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { LOGS_DIR } from "./paths.js";

mkdirSync(LOGS_DIR, { recursive: true });

/**
 * Preserve the full Error chain in structured logs.
 *
 * Error.message, Error.stack, and Error.cause are non-enumerable, so logging an
 * Error as a plain object can silently drop the transport error details we need
 * for incidents such as `TypeError: fetch failed`.
 */
function serializeError(error: unknown, seen = new WeakSet<object>()): unknown {
  if (!(error instanceof Error)) return error;
  if (seen.has(error)) return { type: error.name, message: error.message, circular: true };
  seen.add(error);

  const serialized: Record<string, unknown> = {
    type: error.name,
    message: error.message,
    stack: error.stack,
  };

  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === "name" || key === "message" || key === "stack" || key === "cause") continue;
    serialized[key] = (error as unknown as Record<string, unknown>)[key];
  }

  if (error.cause !== undefined) {
    serialized.cause = serializeError(error.cause, seen);
  }

  return serialized;
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "debug",
  serializers: { err: serializeError },
  transport: {
    target: "pino-pretty",
    options: {
      destination: resolve(LOGS_DIR, "furet.log"),
      mkdir: true,
      colorize: false,
      translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
      ignore: "pid,hostname",
      singleLine: true,
    },
  },
});
