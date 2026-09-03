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
export const SEARCH_DOCUMENT_VEC_TABLE = "search_document_vectors_vec_cos";

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

function ensureColumn(database: Database.Database, table: string, column: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some(item => item.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Numbered, run-once schema migrations. `schema_migrations` records the highest
 * version already applied so a migration body never runs again on later boots.
 * This replaces the previous pattern of executing a full-table `UPDATE` on every
 * process start (which rewrote every attachment row unconditionally).
 */
function hasSchemaVersion(database: Database.Database, version: number): boolean {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  return Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version));
}

function markSchemaVersion(database: Database.Database, version: number): void {
  database.prepare("INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)").run(version);
}

/**
 * Backfill per-stage attachment status from the coarse `status` column. Runs once
 * (migration version 1); subsequent boots skip it entirely instead of rewriting
 * every attachment_records row on each startup.
 */
function migrateAttachmentStageStatus(database: Database.Database): void {
  const SCHEMA_ATTACHMENT_STAGES = 1;
  if (hasSchemaVersion(database, SCHEMA_ATTACHMENT_STAGES)) return;
  database.transaction(() => {
    database.exec(`
      UPDATE attachment_records SET
        ocr_status = CASE WHEN status = 'complete' THEN 'complete' ELSE ocr_status END,
        vision_status = CASE WHEN status = 'complete' THEN 'complete' ELSE vision_status END,
        extract_status = CASE WHEN status = 'complete' THEN 'complete' ELSE extract_status END
    `);
    markSchemaVersion(database, SCHEMA_ATTACHMENT_STAGES);
  })();
}

export function getDb(): Database.Database {
  if (db) return db;

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
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

  // Unified search index. Source files/session JSON remain the durable truth; these
  // tables are rebuildable projections. `rowid` is the sqlite-vec/FTS join key while
  // `id` is the deterministic identity used for idempotent reconciliation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_documents (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      parent_id TEXT,
      session_id TEXT,
      channel_id TEXT,
      visibility_scope TEXT NOT NULL,
      ordinal INTEGER,
      role TEXT,
      text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      occurred_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      embedding_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (embedding_status IN ('pending', 'processing', 'complete', 'failed', 'skipped'))
    );
    CREATE INDEX IF NOT EXISTS search_documents_source
      ON search_documents(source_type, source_id);
    CREATE INDEX IF NOT EXISTS search_documents_session_time
      ON search_documents(session_id, occurred_at);
    CREATE INDEX IF NOT EXISTS search_documents_content_hash
      ON search_documents(content_hash);
    CREATE INDEX IF NOT EXISTS search_documents_embedding_status
      ON search_documents(embedding_status);
    CREATE INDEX IF NOT EXISTS search_documents_visibility
      ON search_documents(visibility_scope);

    CREATE VIRTUAL TABLE IF NOT EXISTS search_documents_fts USING fts5(
      text,
      source_type UNINDEXED,
      source_id UNINDEXED,
      session_id UNINDEXED,
      visibility_scope UNINDEXED
    );

    CREATE TABLE IF NOT EXISTS search_document_embeddings (
      document_id TEXT PRIMARY KEY REFERENCES search_documents(id) ON DELETE CASCADE,
      document_rowid INTEGER NOT NULL UNIQUE,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      embedded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS embedding_jobs (
      document_id TEXT PRIMARY KEY REFERENCES search_documents(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS embedding_jobs_ready
      ON embedding_jobs(status, next_retry_at, attempts);
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${SEARCH_DOCUMENT_VEC_TABLE} USING vec0(
      embedding FLOAT[3072] distance_metric=cosine
    )
  `);

  // Durable attachment references and retryable download/OCR/document-analysis jobs.
  // Session JSON keeps the reference identity; these tables retain processing state
  // and extracted projections without placing binary payloads inside SQLite.
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachment_records (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      channel_id TEXT,
      parent_id TEXT NOT NULL,
      url TEXT,
      original_name TEXT,
      content_type TEXT,
      local_path TEXT,
      size_bytes INTEGER,
      content_hash TEXT,
      visibility_scope TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'upload',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
      ocr_text TEXT,
      visual_description TEXT,
      extracted_text TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS attachment_records_session_parent
      ON attachment_records(session_id, parent_id);
    CREATE INDEX IF NOT EXISTS attachment_records_hash
      ON attachment_records(content_hash);
    CREATE INDEX IF NOT EXISTS attachment_records_status
      ON attachment_records(status);

    CREATE TABLE IF NOT EXISTS attachment_jobs (
      attachment_id TEXT PRIMARY KEY REFERENCES attachment_records(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS attachment_jobs_ready
      ON attachment_jobs(status, next_retry_at, attempts);

    -- Per-local-day counter of successful visual descriptions. The attachment worker
    -- enforces attachment_analysis.daily_budget against this; the row is keyed by the
    -- local date string (config.timezone-aware, same convention as diary/log filenames)
    -- so a budget resets naturally at local midnight without any scheduled job.
    CREATE TABLE IF NOT EXISTS vision_usage (
      day TEXT PRIMARY KEY,
      descriptions INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  ensureColumn(db, "attachment_records", "ocr_status", "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn(db, "attachment_records", "vision_status", "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn(db, "attachment_records", "extract_status", "TEXT NOT NULL DEFAULT 'pending'");
  // Discord provenance for signed-CDN-URL refresh. Nullable and added via ensureColumn so
  // pre-existing attachment rows migrate forward with NULLs (refresh simply degrades to the
  // stored URL for rows that predate provenance capture).
  ensureColumn(db, "attachment_records", "discord_channel_id", "TEXT");
  ensureColumn(db, "attachment_records", "discord_message_id", "TEXT");
  ensureColumn(db, "attachment_records", "discord_attachment_id", "TEXT");
  // Count of refreshable (non-permanent) job failures — e.g. a stale signed URL or a
  // transient daily-budget stop — that must NOT drain the permanent retry attempts budget.
  ensureColumn(db, "attachment_jobs", "refresh_attempts", "INTEGER NOT NULL DEFAULT 0");
  // One-time backfill of the per-stage status columns, gated by schema version so it
  // stops touching every attachment row on subsequent process starts.
  migrateAttachmentStageStatus(db);

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

/** Rebuild legacy and unified FTS projections when their own token versions change. */
function rebuildFtsIfNeeded(database: Database.Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS fts_meta (key TEXT PRIMARY KEY, value INTEGER)`);
  const legacy = database.prepare("SELECT value FROM fts_meta WHERE key='content_version'").get() as { value: number } | undefined;
  const unified = database.prepare("SELECT value FROM fts_meta WHERE key='search_documents_content_version'").get() as { value: number } | undefined;

  try {
    if (legacy?.value !== FTS_CONTENT_VERSION) {
      const memRows = database.prepare("SELECT id, text, file FROM memory_vectors").all() as Array<{ id: number; text: string; file: string }>;
      const sessRows = database.prepare("SELECT id, content, session_id FROM session_archive").all() as Array<{ id: number; content: string; session_id: string }>;
      const insMem = database.prepare("INSERT INTO memory_fts (rowid, text, file) VALUES (?, ?, ?)");
      const insSess = database.prepare("INSERT INTO session_fts (rowid, content, session_id) VALUES (?, ?, ?)");
      database.transaction(() => {
        database.exec("DELETE FROM memory_fts");
        for (const r of memRows) insMem.run(r.id, toSearchTokens(r.text), r.file);
        database.exec("DELETE FROM session_fts");
        for (const r of sessRows) if (r.content && !isJsonArray(r.content)) insSess.run(r.id, toSearchTokens(r.content), r.session_id);
        database.prepare("INSERT INTO fts_meta (key, value) VALUES ('content_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(FTS_CONTENT_VERSION);
      })();
      logger.info({ version: FTS_CONTENT_VERSION, memory: memRows.length, session: sessRows.length }, "legacy FTS indexes rebuilt");
    }

    if (unified?.value !== FTS_CONTENT_VERSION) {
      const rows = database.prepare("SELECT rowid, text, source_type, source_id, session_id, visibility_scope FROM search_documents").all() as Array<{ rowid: number; text: string; source_type: string; source_id: string; session_id: string | null; visibility_scope: string }>;
      const insert = database.prepare("INSERT INTO search_documents_fts (rowid, text, source_type, source_id, session_id, visibility_scope) VALUES (?, ?, ?, ?, ?, ?)");
      database.transaction(() => {
        database.exec("DELETE FROM search_documents_fts");
        for (const r of rows) insert.run(r.rowid, toSearchTokens(r.text), r.source_type, r.source_id, r.session_id ?? "", r.visibility_scope);
        database.prepare("INSERT INTO fts_meta (key, value) VALUES ('search_documents_content_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(FTS_CONTENT_VERSION);
      })();
      logger.info({ version: FTS_CONTENT_VERSION, searchDocuments: rows.length }, "unified FTS index rebuilt");
    }
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
