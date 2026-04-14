import pino from "pino";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const logDir = resolve(import.meta.dirname ?? process.cwd(), "..", "logs");
mkdirSync(logDir, { recursive: true });

const logFile = resolve(logDir, "furet.log");

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "debug",
  transport: {
    target: "pino/file",
    options: { destination: logFile, mkdir: true },
  },
});
