import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { resolve } from "node:path";
import { WORKSPACE_CONFIG_DIR } from "./paths.js";
import { logger } from "./logger.js";
import { toSearchTokens } from "./utils/cjk.js";

const DB_PATH = resolve(WORKSPACE_CONFIG_DIR, "furet.db");

let db: Database.Database | null = null;

/** 向量表名稱（cosine 版）。embedding.ts 一律走這張。 */
export const VEC_TABLE = "memory_vectors_vec_cos";
export const SESSION_SUMMARY_VEC_TABLE = "session_summary_vectors_vec_cos";

/**
 * 把 L2 向量表的內容搬到 cosine 表。
 * 向量值本身不變（只是距離算法不同），所以直接複製 blob，不用重打 embedding API。
 */
function migrateVecTable(database: Database.Database): void {
  const hasOld = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_vectors_vec'"
  ).get();
  if (!hasOld) return;

  const target = (database.prepare(`SELECT count(*) c FROM ${VEC_TABLE}`).get() as { c: number }).c;
  if (target > 0) return; // 已經搬過

  try {
    const rows = database.prepare(
      "SELECT rowid, embedding FROM memory_vectors_vec"
    ).all() as Array<{ rowid: number; embedding: Buffer }>;
    if (rows.length === 0) return;

    const insert = database.prepare(`INSERT INTO ${VEC_TABLE} (rowid, embedding) VALUES (?, ?)`);
    database.transaction(() => {
      // vec0 的 rowid 綁定只吃 BigInt，傳一般 number 會被拒
      for (const r of rows) insert.run(BigInt(r.rowid), r.embedding);
    })();
    logger.info({ count: rows.length }, "vec table migrated to cosine metric");
  } catch (err) {
    logger.error({ err: (err as Error).message }, "vec table migration failed");
  }
}

export function getDb(): Database.Database {
  if (db) return db;

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  sqliteVec.load(db);

  // 向量表：記憶的 embedding
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_vectors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      file TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  // vec0 預設用 L2 距離，但 searchVectors 把 (1 - distance) 當成 cosine 相似度在比。
  // 兩者對不上（L2 ∈ [0,2] 但意義不同），閾值形同永遠不成立。
  // 指定 distance_metric=cosine，此時 distance = 1 - cos，(1 - distance) 才真的是相似度。
  // CREATE TABLE IF NOT EXISTS 不會改既有表的 schema，所以開一張新表並搬遷。
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors_vec_cos USING vec0(
      embedding FLOAT[3072] distance_metric=cosine
    )
  `);
  migrateVecTable(db);

  // 全文搜尋：記憶
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      text, file
    )
  `);

  // Persistent Discord button state. Flexible button/action payloads remain JSON, while
  // lifecycle fields stay queryable for atomic transitions and retention cleanup.
  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_button_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      content TEXT NOT NULL,
      buttons_json TEXT NOT NULL,
      allowed_user_ids_json TEXT NOT NULL,
      preview_button_id TEXT,
      preview_field TEXT,
      preview_label TEXT,
      interaction_mode TEXT NOT NULL,
      disabled_button_ids_json TEXT NOT NULL DEFAULT '[]',
      button_results_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT,
      result TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS discord_button_messages_message_id
      ON discord_button_messages(message_id);
    CREATE INDEX IF NOT EXISTS discord_button_messages_status_expires
      ON discord_button_messages(status, expires_at);
  `);

  // Session archive
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      time TEXT,
      msg_id TEXT,
      reply_to TEXT,
      archived_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 全文搜尋：session archive
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
      content, session_id
    )
  `);

  // Semantic session search indexes compact continuation summaries rather than every
  // raw message. The JSON compact archive remains the durable source; these tables are
  // a rebuildable search projection.
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_summary_vectors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(session_id, summary)
    )
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_summary_vectors_vec_cos USING vec0(
      embedding FLOAT[3072] distance_metric=cosine
    )
  `);

  rebuildFtsIfNeeded(db);

  logger.info({ path: DB_PATH }, "database initialized");
  return db;
}

/**
 * FTS 索引的內容格式版本。
 *
 * FTS 表存的不是原文，而是 `toSearchTokens()` 展開後的 token 序列
 * （中文 bigram 化，否則 unicode61 不斷中文，中文查詢永遠搜不到）。
 * 展開規則改變時把這個數字 +1，開機就會用新規則重建索引。
 */
const FTS_CONTENT_VERSION = 2;

function isJsonArray(s: string): boolean {
  if (!s.startsWith("[")) return false;
  try { return Array.isArray(JSON.parse(s)); } catch { return false; }
}

/** 用 bigram 展開規則重建 FTS 索引。原文都還在來源表，重建是安全的。 */
function rebuildFtsIfNeeded(database: Database.Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS fts_meta (key TEXT PRIMARY KEY, value INTEGER)`);
  const row = database.prepare("SELECT value FROM fts_meta WHERE key='content_version'").get() as { value: number } | undefined;
  if (row?.value === FTS_CONTENT_VERSION) return;

  try {
    const memRows = database.prepare("SELECT id, text, file FROM memory_vectors").all() as Array<{ id: number; text: string; file: string }>;
    const sessRows = database.prepare("SELECT id, content, session_id FROM session_archive").all() as Array<{ id: number; content: string; session_id: string }>;

    const insMem = database.prepare("INSERT INTO memory_fts (rowid, text, file) VALUES (?, ?, ?)");
    const insSess = database.prepare("INSERT INTO session_fts (rowid, content, session_id) VALUES (?, ?, ?)");

    database.transaction(() => {
      database.exec("DELETE FROM memory_fts");
      for (const r of memRows) insMem.run(r.id, toSearchTokens(r.text), r.file);

      database.exec("DELETE FROM session_fts");
      for (const r of sessRows) {
        // 歸檔時只對純文字訊息建 FTS。content blocks 是 JSON.stringify 存的，
        // 這裡靠 parse 得到 array 來排除——不能用 startsWith("[") 判斷，
        // 因為使用者訊息本身就常以 "[System] " / "[msg:123 …]" 開頭。
        if (r.content && !isJsonArray(r.content)) insSess.run(r.id, toSearchTokens(r.content), r.session_id);
      }

      database.prepare("INSERT INTO fts_meta (key, value) VALUES ('content_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(FTS_CONTENT_VERSION);
    })();

    logger.info(
      { version: FTS_CONTENT_VERSION, memory: memRows.length, session: sessRows.length },
      "FTS index rebuilt with CJK bigram tokens"
    );
  } catch (err) {
    logger.error({ err: (err as Error).message }, "FTS rebuild failed");
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
