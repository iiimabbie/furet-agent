import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger.js";
import { getDb } from "./db.js";
import { SESSIONS_DIR, ARCHIVE_DIR } from "./paths.js";
import { toSearchTokens } from "./utils/cjk.js";
import type { Message, TokenUsage, ToolHistoryEvent } from "./types.js";

// 檔名格式：`{stem}.json` 或 `{stem}__{slug}.json`。
// stem 是把 routing id 的長前綴縮寫的結果（discord-channel- → dc-、discord-dm- → dm-），
// 讓資料夾裡的檔名短又可辨識；內部 id 本身不變。
// id 與縮寫都不含底線，所以用 `__` 當 stem 與頻道名 slug 的分界，掃檔時能在邊界精確比對，
// 避免 `...123` 誤match `...1234`。
function idToStem(id: string): string {
  return id.replace(/^discord-channel-/, "dc-").replace(/^discord-dm-/, "dm-");
}

function stemToId(stem: string): string {
  const base = stem.split("__")[0];
  // 相容舊檔名（未縮寫的完整 id）：沒有縮寫前綴時原樣回傳。
  return base.replace(/^dc-/, "discord-channel-").replace(/^dm-/, "discord-dm-");
}

/** 把頻道名轉成可放進檔名的 slug；保留中文，去掉路徑分隔與控制字元。 */
function slugify(name: string): string {
  return name
    .replace(/[/\\\x00-\x1f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^\.+/, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/** 找出磁碟上屬於這個 id 的 session 檔名（含 slug 後綴），沒有則回 null。 */
function findSessionFile(id: string): string | null {
  try {
    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
    return files.find(f => stemToId(f.slice(0, -5)) === id) ?? null;
  } catch {
    return null;
  }
}

/** Backward-compatible detection for summaries created before isCompactSummary existed. */
function isCompactSummary(message: Message): boolean {
  return message.isCompactSummary
    || (typeof message.content === "string" && message.content.startsWith("[System] Previous conversation summary:\n"));
}

export class Session {
  readonly id: string;
  private filePath: string;
  private messages: Message[] = [];
  private usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  private toolHistory: ToolHistoryEvent[] = [];

  constructor(id: string) {
    this.id = id;
    const existing = findSessionFile(id);
    this.filePath = existing ? resolve(SESSIONS_DIR, existing) : resolve(SESSIONS_DIR, `${idToStem(id)}.json`);
    this.load();
  }

  /** 設定頻道名：把檔名同步成 `{id}__{slug}.json`，頻道改名時自動 rename 舊檔。 */
  setChannelName(name: string): void {
    const slug = slugify(name);
    if (!slug) return;
    const target = resolve(SESSIONS_DIR, `${idToStem(this.id)}__${slug}.json`);
    if (target === this.filePath) return;
    try {
      mkdirSync(SESSIONS_DIR, { recursive: true });
      if (existsSync(this.filePath)) renameSync(this.filePath, target);
      this.filePath = target;
    } catch (err) {
      logger.error({ err: (err as Error).message, sessionId: this.id }, "session rename failed");
    }
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

  /** Append an immutable local-tool execution record without adding it to chat history. */
  recordToolEvent(event: ToolHistoryEvent): void {
    this.toolHistory.push(event);
    this.save();
  }

  /** Return the newest tool events, with their full input and output intact. */
  getRecentToolEvents(limit = 8): ToolHistoryEvent[] {
    return this.toolHistory.slice(-limit);
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
    this.toolHistory = [];
    this.save();
    logger.info({ sessionId: this.id }, "session cleared");
  }

  archive(): string | null {
    // Compact summaries are context caches, not original conversation. Their source
    // messages were saved at compaction time, so never archive the synthetic summary.
    const messages = this.messages.filter(m => !isCompactSummary(m));
    if (messages.length === 0) {
      logger.info({ sessionId: this.id }, "session archive skipped (empty)");
      this.clear();
      return null;
    }

    const archivePath = this.persistArchive(messages, "session");
    // Do not erase the active session if its durable archive could not be written.
    if (archivePath) this.clear();
    else logger.error({ sessionId: this.id }, "session retained because archive write failed");
    return archivePath;
  }

  /**
   * Persist the part about to be replaced by compaction without ending the active
   * session. This makes compaction a cache optimisation rather than data loss.
   *
   * Returns false when the JSON archive could not be written; callers must then
   * leave the active history untouched.
   */
  archiveForCompaction(messages: Message[], summary: string): boolean {
    const originalMessages = messages.filter(m => !isCompactSummary(m));
    if (originalMessages.length === 0) return true;
    return this.persistArchive(originalMessages, "compaction", summary) !== null;
  }

  /** 壓縮 session：用摘要替換前半段 messages，保留最近的 keepRecent 則 */
  compact(summary: string, keepRecent: number): void {
    if (this.messages.length <= keepRecent) return;
    const kept = this.messages.slice(-keepRecent);
    this.messages = [
      {
        role: "user",
        content: `[System] Previous conversation summary:
${summary}`,
        isCompactSummary: true,
      },
      ...kept,
    ];
    this.save();
    logger.info({ sessionId: this.id, kept: kept.length, totalAfter: this.messages.length }, "session compacted");
  }

  get length(): number {
    return this.messages.length;
  }

  /** Write an immutable archive segment and index it for session search. */
  private persistArchive(messages: Message[], kind: "session" | "compaction", summary?: string): string | null {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const suffix = kind === "compaction" ? "-compact" : "";
    const archivePath = resolve(ARCHIVE_DIR, `${this.id}${suffix}-${timestamp}.json`);
    const archivedAt = new Date().toISOString();

    try {
      mkdirSync(ARCHIVE_DIR, { recursive: true });
      writeFileSync(archivePath, JSON.stringify({
        sessionId: this.id,
        archivedAt,
        kind,
        ...(summary ? { summary } : {}),
        messages,
        usage: this.usage,
        toolHistory: this.toolHistory,
      }, null, 2));
      logger.info({ sessionId: this.id, archivePath, kind, count: messages.length, usage: this.usage }, "session archive written");
    } catch (err) {
      logger.error({ err, sessionId: this.id, kind }, "session archive write failed");
      return null;
    }

    // SQLite is an index/search copy. The JSON archive above is the durable source
    // of truth, so a database failure must not make compaction lose history.
    try {
      const db = getDb();
      const insert = db.prepare("INSERT INTO session_archive (session_id, role, content, time, msg_id, reply_to) VALUES (?, ?, ?, ?, ?, ?)");
      const insertFts = db.prepare("INSERT INTO session_fts (rowid, content, session_id) VALUES (?, ?, ?)");
      const tx = db.transaction(() => {
        for (const m of messages) {
          const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          const result = insert.run(this.id, m.role, content, m.time ?? null, m.msgId ?? null, m.replyTo ?? null);
          if (typeof m.content === "string" && m.content.length > 0) {
            insertFts.run(result.lastInsertRowid, toSearchTokens(m.content), this.id);
          }
        }
      });
      tx();
      logger.info({ sessionId: this.id, kind, count: messages.length }, "session archive indexed");
    } catch (err) {
      logger.error({ err: (err as Error).message, sessionId: this.id, kind }, "session archive db index failed");
    }

    return archivePath;
  }

  private load(): void {
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf-8"));
      this.messages = data.messages ?? [];
      this.usage = data.usage ?? { inputTokens: 0, outputTokens: 0 };
      this.toolHistory = data.toolHistory ?? [];
      logger.info({ sessionId: this.id, count: this.messages.length }, "session loaded");
    } catch {
      this.messages = [];
      this.toolHistory = [];
    }
  }


  /** 檢查 session 檔是否已存在（用於區分「從未觸發過」跟「已有對話歷史」） */
  static exists(id: string): boolean {
    return findSessionFile(id) !== null;
  }

  /** 列出所有 active session ID */
  static listActive(): string[] {
    try {
      const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
      return files.map(f => stemToId(f.slice(0, -5)));
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      mkdirSync(SESSIONS_DIR, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify({ messages: this.messages, usage: this.usage, toolHistory: this.toolHistory }, null, 2));
    } catch (err) {
      logger.error({ err, sessionId: this.id }, "session save failed");
    }
  }
}
