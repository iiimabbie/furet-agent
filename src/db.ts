import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { resolve } from "node:path";
import { WORKSPACE_CONFIG_DIR } from "./paths.js";
import { logger } from "./logger.js";

const DB_PATH = resolve(WORKSPACE_CONFIG_DIR, "furet.db");

let db: Database.Database | null = null;

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
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors_vec USING vec0(
      embedding FLOAT[3072]
    )
  `);

  // 全文搜尋：記憶
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      text, file
    )
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

  logger.info({ path: DB_PATH }, "database initialized");
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
