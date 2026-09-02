import { createHash } from "node:crypto";
import { getDb, SEARCH_DOCUMENT_VEC_TABLE } from "./db.js";
import { embed } from "./embedding.js";
import { logger } from "./logger.js";
import { toSearchTokens } from "./utils/cjk.js";

export const SEARCH_EMBED_MODEL = "gemini-embedding-001";
export const SEARCH_EMBED_DIMENSIONS = 3072;
const MAX_EMBED_ATTEMPTS = 5;

export type SearchSourceType =
  | "session_message"
  | "conversation_window"
  | "compact_summary"
  | "tool_call"
  | "tool_result"
  | "tool_evidence_summary"
  | "diary"
  | "diary_note"
  | "people"
  | "memory"
  | "owner"
  | "attachment";

export interface SearchDocumentInput {
  id: string;
  sourceType: SearchSourceType;
  sourceId: string;
  parentId?: string;
  sessionId?: string;
  channelId?: string;
  visibilityScope: string;
  ordinal?: number;
  role?: string;
  text: string;
  occurredAt?: string;
}

export interface IngestOptions {
  removeMissingForSource?: boolean;
}

export interface IngestResult {
  inserted: number;
  updated: number;
  unchanged: number;
  removed: number;
  skipped: number;
}

export interface EmbeddingWorkerResult {
  completed: number;
  failed: number;
  remaining: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createSearchDocumentId(...parts: Array<string | number | undefined>): string {
  return sha256(parts.map(part => String(part ?? "")).join("\u001f"));
}

export function redactSecrets(text: string): string {
  return text
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
    .replace(/(["']?)(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|cookie)\1\s*[:=]\s*(["']?)([^\s,;"']{4,}|[^"']{4,})\3/gi, (_match, quote, key) => `${quote || ""}${key}${quote || ""}=[REDACTED]`)
    .replace(/([?&](?:key|api_key|access_token|token|signature|sig)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\b(?:ghp|github_pat|sk|AIza)[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED PRIVATE KEY]");
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

function deleteRowsByRowids(rowids: number[]): void {
  if (rowids.length === 0) return;
  const db = getDb();
  const placeholders = rowids.map(() => "?").join(",");
  db.prepare(`DELETE FROM ${SEARCH_DOCUMENT_VEC_TABLE} WHERE rowid IN (${placeholders})`)
    .run(...rowids.map(BigInt));
  db.prepare(`DELETE FROM search_documents_fts WHERE rowid IN (${placeholders})`).run(...rowids);
}

/**
 * Persist rebuildable search documents and atomically enqueue their embeddings.
 * This function deliberately performs no network I/O, so synchronous session
 * persistence can safely call it without fire-and-forget embedding promises.
 */
export function ingestSearchDocuments(
  inputs: SearchDocumentInput[],
  options: IngestOptions = {},
): IngestResult {
  const db = getDb();
  const result: IngestResult = { inserted: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0 };
  const normalized = inputs.flatMap(input => {
    const text = normalizeText(input.text);
    if (!input.id || !input.sourceType || !input.sourceId || !input.visibilityScope || !text) {
      result.skipped++;
      return [];
    }
    return [{ ...input, text, contentHash: sha256(text) }];
  });

  if (options.removeMissingForSource && normalized.length === 0 && inputs.length === 0) {
    throw new Error("removeMissingForSource requires at least one input to identify the source");
  }

  const find = db.prepare("SELECT rowid, content_hash FROM search_documents WHERE id = ?");
  const insert = db.prepare(`
    INSERT INTO search_documents (
      id, source_type, source_id, parent_id, session_id, channel_id,
      visibility_scope, ordinal, role, text, content_hash, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE search_documents SET
      source_type = ?, source_id = ?, parent_id = ?, session_id = ?, channel_id = ?,
      visibility_scope = ?, ordinal = ?, role = ?, text = ?, content_hash = ?,
      occurred_at = ?, updated_at = datetime('now'), embedding_status = 'pending'
    WHERE id = ?
  `);
  const insertFts = db.prepare(`
    INSERT INTO search_documents_fts
      (rowid, text, source_type, source_id, session_id, visibility_scope)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const enqueue = db.prepare(`
    INSERT INTO embedding_jobs (document_id, content_hash, status, attempts, next_retry_at, last_error, updated_at)
    VALUES (?, ?, 'pending', 0, NULL, NULL, datetime('now'))
    ON CONFLICT(document_id) DO UPDATE SET
      content_hash = excluded.content_hash,
      status = 'pending', attempts = 0, next_retry_at = NULL, last_error = NULL,
      updated_at = datetime('now')
  `);
  const removeEmbeddingMeta = db.prepare("DELETE FROM search_document_embeddings WHERE document_id = ?");

  db.transaction(() => {
    for (const doc of normalized) {
      const existing = find.get(doc.id) as { rowid: number; content_hash: string } | undefined;
      if (!existing) {
        const rowid = Number(insert.run(
          doc.id, doc.sourceType, doc.sourceId, doc.parentId ?? null,
          doc.sessionId ?? null, doc.channelId ?? null, doc.visibilityScope,
          doc.ordinal ?? null, doc.role ?? null, doc.text, doc.contentHash,
          doc.occurredAt ?? null,
        ).lastInsertRowid);
        insertFts.run(rowid, toSearchTokens(doc.text), doc.sourceType, doc.sourceId, doc.sessionId ?? "", doc.visibilityScope);
        enqueue.run(doc.id, doc.contentHash);
        result.inserted++;
        continue;
      }

      if (existing.content_hash === doc.contentHash) {
        result.unchanged++;
        continue;
      }

      deleteRowsByRowids([existing.rowid]);
      removeEmbeddingMeta.run(doc.id);
      update.run(
        doc.sourceType, doc.sourceId, doc.parentId ?? null, doc.sessionId ?? null,
        doc.channelId ?? null, doc.visibilityScope, doc.ordinal ?? null,
        doc.role ?? null, doc.text, doc.contentHash, doc.occurredAt ?? null, doc.id,
      );
      insertFts.run(existing.rowid, toSearchTokens(doc.text), doc.sourceType, doc.sourceId, doc.sessionId ?? "", doc.visibilityScope);
      enqueue.run(doc.id, doc.contentHash);
      result.updated++;
    }

    if (options.removeMissingForSource && normalized.length > 0) {
      const first = normalized[0];
      if (normalized.some(doc => doc.sourceType !== first.sourceType || doc.sourceId !== first.sourceId)) {
        throw new Error("removeMissingForSource inputs must share sourceType and sourceId");
      }
      const keep = new Set(normalized.map(doc => doc.id));
      const existing = db.prepare(
        "SELECT rowid, id FROM search_documents WHERE source_type = ? AND source_id = ?",
      ).all(first.sourceType, first.sourceId) as Array<{ rowid: number; id: string }>;
      const stale = existing.filter(row => !keep.has(row.id));
      if (stale.length > 0) {
        deleteRowsByRowids(stale.map(row => row.rowid));
        const placeholders = stale.map(() => "?").join(",");
        db.prepare(`DELETE FROM search_documents WHERE id IN (${placeholders})`).run(...stale.map(row => row.id));
        result.removed += stale.length;
      }
    }
  })();

  return result;
}

export function removeSearchDocumentsForSource(sourceType: SearchSourceType, sourceId: string): number {
  const db = getDb();
  return db.transaction(() => {
    const rows = db.prepare(
      "SELECT rowid FROM search_documents WHERE source_type = ? AND source_id = ?",
    ).all(sourceType, sourceId) as Array<{ rowid: number }>;
    if (rows.length === 0) return 0;
    deleteRowsByRowids(rows.map(row => row.rowid));
    db.prepare("DELETE FROM search_documents WHERE source_type = ? AND source_id = ?")
      .run(sourceType, sourceId);
    return rows.length;
  })();
}

function vectorToBlob(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

function retryAt(attempts: number): string {
  const seconds = Math.min(3600, 15 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** Process durable embedding jobs. Safe to call repeatedly and after restart. */
export async function processEmbeddingJobs(limit = 10): Promise<EmbeddingWorkerResult> {
  const apiKey = process.env.GOOGLE_API_KEY ?? "";
  const db = getDb();
  if (!apiKey) {
    const remaining = (db.prepare("SELECT count(*) AS c FROM embedding_jobs WHERE status IN ('pending', 'failed')").get() as { c: number }).c;
    return { completed: 0, failed: 0, remaining };
  }

  // A previous process may have died after claiming a job. Make it retryable.
  db.prepare(`
    UPDATE embedding_jobs SET status = 'failed', next_retry_at = datetime('now'),
      last_error = COALESCE(last_error, 'worker interrupted'), updated_at = datetime('now')
    WHERE status = 'processing' AND updated_at < datetime('now', '-10 minutes')
  `).run();

  let completed = 0;
  let failed = 0;
  for (let i = 0; i < Math.max(0, limit); i++) {
    const job = db.transaction(() => {
      const row = db.prepare(`
        SELECT j.document_id, j.content_hash, j.attempts, d.rowid, d.text
        FROM embedding_jobs j
        JOIN search_documents d ON d.id = j.document_id
        WHERE j.attempts < ?
          AND (j.status = 'pending' OR (j.status = 'failed' AND (j.next_retry_at IS NULL OR datetime(j.next_retry_at) <= datetime('now'))))
        ORDER BY j.created_at, j.document_id
        LIMIT 1
      `).get(MAX_EMBED_ATTEMPTS) as {
        document_id: string; content_hash: string; attempts: number; rowid: number; text: string;
      } | undefined;
      if (!row) return undefined;
      db.prepare(`
        UPDATE embedding_jobs SET status = 'processing', attempts = attempts + 1,
          updated_at = datetime('now') WHERE document_id = ?
      `).run(row.document_id);
      db.prepare("UPDATE search_documents SET embedding_status = 'processing' WHERE id = ?").run(row.document_id);
      return { ...row, attempts: row.attempts + 1 };
    })();
    if (!job) break;

    try {
      const vector = await embed(redactSecrets(job.text));
      if (vector.length !== SEARCH_EMBED_DIMENSIONS) {
        throw new Error(`unexpected embedding dimensions: ${vector.length}`);
      }
      const blob = vectorToBlob(vector);
      db.transaction(() => {
        const current = db.prepare("SELECT content_hash, rowid FROM search_documents WHERE id = ?").get(job.document_id) as { content_hash: string; rowid: number } | undefined;
        if (!current || current.content_hash !== job.content_hash) {
          db.prepare("UPDATE embedding_jobs SET status = 'pending', updated_at = datetime('now') WHERE document_id = ?").run(job.document_id);
          return;
        }
        db.prepare(`DELETE FROM ${SEARCH_DOCUMENT_VEC_TABLE} WHERE rowid = ?`).run(BigInt(current.rowid));
        db.prepare(`INSERT INTO ${SEARCH_DOCUMENT_VEC_TABLE} (rowid, embedding) VALUES (?, ?)`).run(BigInt(current.rowid), blob);
        db.prepare(`
          INSERT INTO search_document_embeddings
            (document_id, document_rowid, model, dimensions, content_hash, embedded_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(document_id) DO UPDATE SET
            document_rowid = excluded.document_rowid, model = excluded.model,
            dimensions = excluded.dimensions, content_hash = excluded.content_hash,
            embedded_at = datetime('now')
        `).run(job.document_id, current.rowid, SEARCH_EMBED_MODEL, SEARCH_EMBED_DIMENSIONS, job.content_hash);
        db.prepare("UPDATE embedding_jobs SET status = 'complete', next_retry_at = NULL, last_error = NULL, updated_at = datetime('now') WHERE document_id = ?").run(job.document_id);
        db.prepare("UPDATE search_documents SET embedding_status = 'complete', updated_at = datetime('now') WHERE id = ?").run(job.document_id);
      })();
      completed++;
    } catch (error) {
      const message = (error as Error).message.slice(0, 2000);
      const exhausted = job.attempts >= MAX_EMBED_ATTEMPTS;
      db.transaction(() => {
        db.prepare(`
          UPDATE embedding_jobs SET status = 'failed', next_retry_at = ?, last_error = ?, updated_at = datetime('now')
          WHERE document_id = ?
        `).run(exhausted ? null : retryAt(job.attempts), message, job.document_id);
        db.prepare("UPDATE search_documents SET embedding_status = 'failed', updated_at = datetime('now') WHERE id = ?").run(job.document_id);
      })();
      logger.warn({ documentId: job.document_id, attempts: job.attempts, err: message }, "search embedding job failed");
      failed++;
    }
  }

  const remaining = (db.prepare(`
    SELECT count(*) AS c FROM embedding_jobs
    WHERE status IN ('pending', 'processing', 'failed')
  `).get() as { c: number }).c;
  return { completed, failed, remaining };
}

let workerTimer: NodeJS.Timeout | undefined;
let workerRunning = false;

/** Start one durable outbox worker for this process. Re-entrant calls are no-ops. */
export function startSearchIndexWorker(intervalMs = 10_000, batchSize = 20): void {
  if (workerTimer) return;
  const tick = async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      const result = await processEmbeddingJobs(batchSize);
      if (result.completed > 0 || result.failed > 0) {
        logger.info(result, "search embedding worker batch finished");
      }
    } catch (error) {
      logger.error({ err: (error as Error).message }, "search embedding worker tick failed");
    } finally {
      workerRunning = false;
    }
  };
  void tick();
  workerTimer = setInterval(() => { void tick(); }, Math.max(1_000, intervalMs));
  workerTimer.unref?.();
}

export function stopSearchIndexWorker(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = undefined;
}
