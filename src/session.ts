import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger.js";

type Message = { role: string; content: unknown; [key: string]: unknown };

const SESSIONS_DIR = resolve(import.meta.dirname ?? process.cwd(), "..", "workspace", "sessions");
const ARCHIVE_DIR = resolve(SESSIONS_DIR, "archive");

export class Session {
  readonly id: string;
  private filePath: string;
  private messages: Message[] = [];

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

  /** 在最後一則 assistant 訊息的 content 前面加 prefix（用來標 Discord message id） */
  prependToLastAssistantContent(prefix: string): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === "assistant" && typeof m.content === "string") {
        m.content = prefix + m.content;
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

  /** 歸檔當前對話到 archive/，然後清空 */
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
      this.repairDanglingToolCalls();
      logger.info({ sessionId: this.id, count: this.messages.length }, "session loaded");
    } catch {
      this.messages = [];
    }
  }

  /**
   * 掃全陣列，找出 assistant 帶 tool_calls 但下一則不是匹配的 tool result，
   * 或 tool_call 與 tool_result 數量/ID 不對的地方，移除整組壞掉的 block。
   */
  private repairDanglingToolCalls(): void {
    const repaired: Message[] = [];
    let i = 0;
    let removed = 0;

    while (i < this.messages.length) {
      const msg = this.messages[i];
      if (msg.role === "assistant") {
        const calls = (msg as unknown as Record<string, unknown>).tool_calls as Array<{ id: string }> | undefined;
        if (calls && calls.length > 0) {
          // 檢查後面緊接著的 tool results 是否涵蓋所有 tool_call id
          const expectedIds = new Set(calls.map(c => c.id));
          const actualIds = new Set<string>();
          let j = i + 1;
          while (j < this.messages.length && this.messages[j].role === "tool") {
            actualIds.add((this.messages[j] as unknown as { tool_call_id: string }).tool_call_id);
            j++;
          }
          const allMatched = [...expectedIds].every(id => actualIds.has(id));
          if (!allMatched) {
            // 整組跳過（assistant + 後面所有連續 tool）
            i = j;
            removed++;
            continue;
          }
          // 正常：收 assistant + 所有 tool results
          repaired.push(msg);
          for (let k = i + 1; k < j; k++) repaired.push(this.messages[k]);
          i = j;
          continue;
        }
      }
      repaired.push(msg);
      i++;
    }

    if (removed > 0) {
      logger.warn({ sessionId: this.id, removedGroups: removed, before: this.messages.length, after: repaired.length }, "repair: removed broken tool_call groups");
      this.messages = repaired;
      this.save();
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
