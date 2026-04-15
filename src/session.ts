import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type OpenAI from "openai";
import { logger } from "./logger.js";

const SESSIONS_DIR = resolve(import.meta.dirname ?? process.cwd(), "..", "workspace", "sessions");

export class Session {
  readonly id: string;
  private filePath: string;
  private messages: OpenAI.ChatCompletionMessageParam[] = [];

  constructor(id: string) {
    this.id = id;
    this.filePath = resolve(SESSIONS_DIR, `${id}.json`);
    this.load();
  }

  getMessages(): OpenAI.ChatCompletionMessageParam[] {
    return this.messages;
  }

  append(message: OpenAI.ChatCompletionMessageParam): void {
    this.messages.push(message);
    this.save();
  }

  clear(): void {
    this.messages = [];
    this.save();
    logger.info({ sessionId: this.id }, "session cleared");
  }

  get length(): number {
    return this.messages.length;
  }

  private load(): void {
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf-8"));
      this.messages = data.messages ?? [];
      logger.info({ sessionId: this.id, count: this.messages.length }, "session loaded");
    } catch {
      this.messages = [];
    }
  }

  private save(): void {
    try {
      mkdirSync(SESSIONS_DIR, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify({ messages: this.messages }, null, 2));
    } catch (err) {
      logger.error({ err, sessionId: this.id }, "session save failed");
    }
  }
}
