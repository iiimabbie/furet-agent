import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger.js";
import { getDb } from "./db.js";
import { SESSIONS_DIR, ARCHIVE_DIR } from "./paths.js";
import { toSearchTokens } from "./utils/cjk.js";
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
    this.usage = { inputTokens: 0, outputTokens: 0 };
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
        usage: this.usage,
      }, null, 2));
      logger.info({ sessionId: this.id, archivePath, count: this.messages.length, usage: this.usage }, "session archived");
    } catch (err) {
      logger.error({ err, sessionId: this.id }, "session archive failed");
    }

    // 存進 SQLite（session_archive + session_fts）
    try {
      const db = getDb();
      const insert = db.prepare("INSERT INTO session_archive (session_id, role, content, time, msg_id, reply_to) VALUES (?, ?, ?, ?, ?, ?)");
      const insertFts = db.prepare("INSERT INTO session_fts (rowid, content, session_id) VALUES (?, ?, ?)");
      const tx = db.transaction(() => {
        for (const m of this.messages) {
          const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          const result = insert.run(this.id, m.role, content, m.time ?? null, m.msgId ?? null, m.replyTo ?? null);
          // 只對有文字的 user/assistant message 建 FTS。
          // 存 bigram 展開版本（unicode61 不斷中文），原文在 session_archive
          if (typeof m.content === "string" && m.content.length > 0) {
            insertFts.run(result.lastInsertRowid, toSearchTokens(m.content), this.id);
          }
        }
      });
      tx();
      logger.info({ sessionId: this.id, count: this.messages.length }, "session archived to db");
    } catch (err) {
      logger.error({ err: (err as Error).message, sessionId: this.id }, "session db archive failed");
    }

    this.clear();
    return archivePath;
  }

  /** 壓縮 session：用摘要替換前半段 messages，保留最近的 keepRecent 則 */
  compact(summary: string, keepRecent: number): void {
    if (this.messages.length <= keepRecent) return;
    const kept = this.messages.slice(-keepRecent);
    this.messages = [
      { role: "user", content: `[System] Previous conversation summary:\n${summary}` },
      ...kept,
    ];
    this.save();
    logger.info({ sessionId: this.id, kept: kept.length, totalAfter: this.messages.length }, "session compacted");
  }

  get length(): number {
    return this.messages.length;
  }

  private load(): void {
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf-8"));
      this.messages = data.messages ?? [];
      this.usage = data.usage ?? { inputTokens: 0, outputTokens: 0 };
      logger.info({ sessionId: this.id, count: this.messages.length }, "session loaded");
    } catch {
      this.messages = [];
    }
  }


  /** 檢查 session 檔是否已存在（用於區分「從未觸發過」跟「已有對話歷史」） */
  static exists(id: string): boolean {
    return existsSync(resolve(SESSIONS_DIR, `${id}.json`));
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
