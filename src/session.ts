import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger.js";
import { SESSIONS_DIR, ARCHIVE_DIR } from "./paths.js";
import type { Message, TokenUsage } from "./types.js";

export class Session {
  readonly id: string;
  private filePath: string;
  private messages: Message[] = [];
  private usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(id: string) {
    this.id = id;
    this.filePath = resolve(SESSIONS_DIR, `${id}.json`);
    this.load();
  }

  getMessages(): Message[] {
    return this.messages;
  }

  append(message: Message): void {
    this.messages.push(message);
    this.save();
  }

  addUsage(usage: TokenUsage): void {
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
    this.save();
  }

  getUsage(): TokenUsage {
    return { ...this.usage };
  }

  /** 在最後一則 assistant message 上設定 msgId */
  setLastAssistantMsgId(msgId: string): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "assistant") {
        this.messages[i].msgId = msgId;
        this.save();
        return;
      }
    }
  }

  clear(): void {
    this.messages = [];
    this.save();
    logger.info({ sessionId: this.id }, "session cleared");
  }

  archive(): string | null {
    if (this.messages.length === 0) {
      logger.info({ sessionId: this.id }, "session archive skipped (empty)");
      this.clear();
      return null;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = resolve(ARCHIVE_DIR, `${this.id}-${timestamp}.json`);
    try {
      mkdirSync(ARCHIVE_DIR, { recursive: true });
      writeFileSync(archivePath, JSON.stringify({
        sessionId: this.id,
        archivedAt: new Date().toISOString(),
        messages: this.messages,
      }, null, 2));
      logger.info({ sessionId: this.id, archivePath, count: this.messages.length }, "session archived");
    } catch (err) {
      logger.error({ err, sessionId: this.id }, "session archive failed");
    }
    this.clear();
    return archivePath;
  }

  get length(): number {
    return this.messages.length;
  }

  private load(): void {
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf-8"));
      this.messages = data.messages ?? [];
      this.usage = data.usage ?? { inputTokens: 0, outputTokens: 0 };
      this.migrateOldFormat();
      logger.info({ sessionId: this.id, count: this.messages.length }, "session loaded");
    } catch {
      this.messages = [];
    }
  }

  /** 遷移舊格式：ContentBlock[] → string，過濾 tool blocks */
  private migrateOldFormat(): void {
    let changed = false;
    const migrated: Message[] = [];
    for (const m of this.messages) {
      if (typeof m.content === "string") {
        migrated.push(m);
      } else if (Array.isArray(m.content)) {
        const blocks = m.content as Array<{ type: string; text?: string }>;
        const textBlocks = blocks.filter(b => b.type === "text");
        if (textBlocks.length > 0) {
          migrated.push({ ...m, content: textBlocks.map(b => b.text ?? "").join("") });
          changed = true;
        } else {
          changed = true; // 整則跳過（純 tool blocks）
        }
      }
    }
    if (changed) {
      this.messages = migrated;
      logger.info({ sessionId: this.id, before: this.messages.length, after: migrated.length }, "migrated old session format");
      this.save();
    }
  }

  /** 列出所有 active session ID */
  static listActive(): string[] {
    try {
      const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
      return files.map(f => f.replace(".json", ""));
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      mkdirSync(SESSIONS_DIR, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify({ messages: this.messages, usage: this.usage }, null, 2));
    } catch (err) {
      logger.error({ err, sessionId: this.id }, "session save failed");
    }
  }
}
