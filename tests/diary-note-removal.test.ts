import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";

const dbPath = resolve("workspace/attachments/test-diary-note-removal.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });
if (existsSync(dbPath)) rmSync(dbPath);
process.env.UMIRO_DB_PATH = dbPath;

const { closeDb, getDb, migrateRemovedDiaryNotes } = await import("../src/db.js");

function seedObsoleteDiaryNote(): void {
  const db = getDb();
  db.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
  db.prepare(`INSERT INTO search_documents
    (id, source_type, source_id, visibility_scope, text, content_hash, embedding_status)
    VALUES ('old-note', 'diary_note', '2026-09-05.md', 'owner_private', 'old note', 'hash', 'pending')`).run();
  const row = db.prepare("SELECT rowid FROM search_documents WHERE id = 'old-note'").get() as { rowid: number };
  db.prepare("INSERT INTO search_documents_fts (rowid, text, source_type, source_id, session_id, visibility_scope) VALUES (?, 'old note', 'diary_note', '2026-09-05.md', '', 'owner_private')").run(row.rowid);
  db.prepare("INSERT INTO embedding_jobs (document_id, content_hash, status) VALUES ('old-note', 'hash', 'pending')").run();
  db.prepare("INSERT INTO search_document_embeddings (document_id, document_rowid, model, dimensions, content_hash) VALUES ('old-note', ?, 'test', 3072, 'hash')").run(row.rowid);
  db.prepare("INSERT INTO search_document_vectors_vec_cos (rowid, embedding) VALUES (?, ?)").run(BigInt(row.rowid), new Float32Array(3072).fill(0.1));
  migrateRemovedDiaryNotes(db);
  migrateRemovedDiaryNotes(db);
}

seedObsoleteDiaryNote();

test("startup migration removes obsolete diary_note projections once", () => {
  const db = getDb();
  const documentCount = (db.prepare("SELECT count(*) AS count FROM search_documents WHERE source_type = 'diary_note'").get() as { count: number }).count;
  const ftsCount = (db.prepare("SELECT count(*) AS count FROM search_documents_fts WHERE source_type = 'diary_note'").get() as { count: number }).count;
  const jobCount = (db.prepare("SELECT count(*) AS count FROM embedding_jobs WHERE document_id = 'old-note'").get() as { count: number }).count;
  const migrationCount = (db.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version = 2").get() as { count: number }).count;
  assert.equal(documentCount, 0);
  assert.equal(ftsCount, 0);
  assert.equal(jobCount, 0);
  assert.equal(migrationCount, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM search_document_embeddings WHERE document_id = 'old-note'").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM search_document_vectors_vec_cos").get() as { n: number }).n, 0);
  closeDb();
  assert.doesNotThrow(() => getDb());
});

test.after(() => {
  closeDb();
  if (existsSync(dbPath)) rmSync(dbPath);
  for (const suffix of ["-shm", "-wal"]) {
    const file = `${dbPath}${suffix}`;
    if (existsSync(file)) rmSync(file);
  }
});
