import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger.js";
import { SESSIONS_DIR, ARCHIVE_DIR } from "./paths.js";
import type { Message, TokenUsage } from "./types.js";

/*
 * ⚠️ 注意 ⚠️
 * 在 Pi SDK 版本中，Session 管理由 src/agent.ts 的 SessionManager 處理。
 * 此處的 Session 屬性僅用於向後相容及最後一則訊息的暫存。
 * 實際上寫入磁碟的權威來源已轉移至 workspace/sessions/pi/*.jsonl。
 */
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

  /** 檢查 session 是否已存在（包含 legacy .json 與新版 .jsonl） */
  static exists(id: string): boolean {
    const legacyPath = resolve(SESSIONS_DIR, `${id}.json`);
    const piPath = resolve(SESSIONS_DIR, "pi", `${encodeURIComponent(id)}.jsonl`);
    return existsSync(legacyPath) || existsSync(piPath);
  }

  /** 列出所有 active session ID（合併 legacy 與 pi 目錄） */
  static listActive(): string[] {
    const ids = new Set<string>();
    try {
      if (existsSync(SESSIONS_DIR)) {
        readdirSync(SESSIONS_DIR)
          .filter(f => f.endsWith(".json"))
          .forEach(f => ids.add(f.replace(".json", "")));
      }
      const piDir = resolve(SESSIONS_DIR, "pi");
      if (existsSync(piDir)) {
        readdirSync(piDir)
          .filter(f => f.endsWith(".jsonl"))
          .forEach(f => ids.add(decodeURIComponent(f.replace(".jsonl", ""))));
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, "failed to list active sessions");
    }
    return Array.from(ids);
  }

  private save(): void {
    // ⚠️ Pi SDK 版本中，Session 管理由 SessionManager 處理。
    // 此處不再主動寫入 legacy .json 檔案，以避免磁碟空間浪費與同步衝突。
    // 如果需要保留 legacy 對話歷史，請確保已執行搬家腳本遷移至 pi/*.jsonl。
  }
}
