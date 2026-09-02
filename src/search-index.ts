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

export interface SearchIndexIntegrityReport {
  documents: number;
  ftsRowsBefore: number;
  ftsRowsAfter: number;
  orphanFtsRemoved: number;
  orphanVectorsRemoved: number;
  embeddingsRequeued: number;
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

/** Rebuild FTS and repair orphaned/incomplete vector projections from durable documents. */
export function repairSearchIndexProjections(): SearchIndexIntegrityReport {
  const db = getDb();
  return db.transaction(() => {
    const documents = db.prepare(`
      SELECT rowid, id, text, source_type, source_id, session_id, visibility_scope, content_hash, embedding_status
      FROM search_documents ORDER BY rowid
    `).all() as Array<{
      rowid: number; id: string; text: string; source_type: SearchSourceType; source_id: string;
      session_id: string | null; visibility_scope: string; content_hash: string; embedding_status: string;
    }>;
    const validRowids = new Set(documents.map(document => document.rowid));
    const ftsRowsBefore = (db.prepare("SELECT count(*) AS c FROM search_documents_fts").get() as { c: number }).c;
    const orphanFtsRemoved = (db.prepare(`
      SELECT count(*) AS c FROM search_documents_fts f
      LEFT JOIN search_documents d ON d.rowid = f.rowid
      WHERE d.rowid IS NULL
    `).get() as { c: number }).c;

    db.exec("DELETE FROM search_documents_fts");
    const insertFts = db.prepare(`
      INSERT INTO search_documents_fts (rowid, text, source_type, source_id, session_id, visibility_scope)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const document of documents) {
      insertFts.run(
        document.rowid, toSearchTokens(document.text), document.source_type, document.source_id,
        document.session_id ?? "", document.visibility_scope,
      );
    }

    const vectorRows = db.prepare(`SELECT rowid FROM ${SEARCH_DOCUMENT_VEC_TABLE}`).all() as Array<{ rowid: number | bigint }>;
    const vectorRowids = new Set(vectorRows.map(row => Number(row.rowid)));
    let orphanVectorsRemoved = 0;
    for (const rowid of vectorRowids) {
      if (validRowids.has(rowid)) continue;
      db.prepare(`DELETE FROM ${SEARCH_DOCUMENT_VEC_TABLE} WHERE rowid = ?`).run(BigInt(rowid));
      orphanVectorsRemoved++;
    }

    const embeddingRows = db.prepare("SELECT document_id, document_rowid FROM search_document_embeddings").all() as Array<{ document_id: string; document_rowid: number }>;
    const embeddingByDocument = new Map(embeddingRows.map(row => [row.document_id, row.document_rowid]));
    const enqueue = db.prepare(`
      INSERT INTO embedding_jobs (document_id, content_hash, status, attempts, next_retry_at, last_error, updated_at)
      VALUES (?, ?, 'pending', 0, NULL, NULL, datetime('now'))
      ON CONFLICT(document_id) DO UPDATE SET
        content_hash=excluded.content_hash, status='pending', attempts=0, next_retry_at=NULL,
        last_error=NULL, updated_at=datetime('now')
    `);
    let embeddingsRequeued = 0;
    for (const document of documents) {
      if (document.embedding_status !== "complete") continue;
      const metadataRowid = embeddingByDocument.get(document.id);
      const projectionComplete = metadataRowid === document.rowid && vectorRowids.has(document.rowid);
      if (projectionComplete) continue;
      db.prepare(`DELETE FROM ${SEARCH_DOCUMENT_VEC_TABLE} WHERE rowid = ?`).run(BigInt(document.rowid));
      db.prepare("DELETE FROM search_document_embeddings WHERE document_id = ?").run(document.id);
      db.prepare("UPDATE search_documents SET embedding_status='pending', updated_at=datetime('now') WHERE id=?").run(document.id);
      enqueue.run(document.id, document.content_hash);
      embeddingsRequeued++;
    }

    const ftsRowsAfter = (db.prepare("SELECT count(*) AS c FROM search_documents_fts").get() as { c: number }).c;
    return {
      documents: documents.length, ftsRowsBefore, ftsRowsAfter, orphanFtsRemoved,
      orphanVectorsRemoved, embeddingsRequeued,
    };
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

export type UnifiedSearchProfile = "all" | "memory" | "session";

export interface SearchVisibilityContext {
  isOwner: boolean;
  userId?: string;
  channelId?: string;
}

export interface UnifiedSearchOptions {
  profile?: UnifiedSearchProfile;
  limit?: number;
  candidateLimit?: number;
  sourceTypes?: SearchSourceType[];
  excludeSourceTypes?: SearchSourceType[];
  excludeSourceIds?: string[];
  excludeSessionIds?: string[];
  excludeDocumentIds?: string[];
  excludeRecentDays?: number;
  visibility: SearchVisibilityContext;
  includeContext?: boolean;
  debug?: boolean;
}

export interface UnifiedSearchResult {
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
  score: number;
  vectorScore?: number;
  ftsRank?: number;
  matchedBy: Array<"vector" | "fts">;
  context?: Array<{ id: string; role?: string; text: string; occurredAt?: string }>;
}

export interface UnifiedSearchResponse {
  traceId: string;
  results: UnifiedSearchResult[];
  diagnostics: {
    vectorCandidates: number;
    ftsCandidates: number;
    filteredCandidates: number;
    groupedCandidates: number;
    embeddingAvailable: boolean;
  };
}

type SearchRow = {
  rowid: number;
  id: string;
  source_type: SearchSourceType;
  source_id: string;
  parent_id: string | null;
  session_id: string | null;
  channel_id: string | null;
  visibility_scope: string;
  ordinal: number | null;
  role: string | null;
  text: string;
  content_hash: string;
  occurred_at: string | null;
};

const SESSION_SOURCE_TYPES = new Set<SearchSourceType>([
  "session_message", "conversation_window", "compact_summary",
  "tool_call", "tool_result", "tool_evidence_summary", "attachment",
]);
const DURABLE_SOURCE_TYPES = new Set<SearchSourceType>([
  "diary", "diary_note", "people", "memory", "owner",
]);

function canViewScope(scope: string, visibility: SearchVisibilityContext): boolean {
  if (visibility.isOwner) return true;
  if (scope === "public") return true;
  if (visibility.channelId && scope === `channel:${visibility.channelId}`) return true;
  if (visibility.userId && scope === `user:${visibility.userId}`) return true;
  return false;
}

function sourceAllowed(sourceType: SearchSourceType, options: UnifiedSearchOptions): boolean {
  if (options.sourceTypes && !options.sourceTypes.includes(sourceType)) return false;
  if (options.excludeSourceTypes?.includes(sourceType)) return false;
  if (options.profile === "session" && !SESSION_SOURCE_TYPES.has(sourceType)) return false;
  return true;
}

function sourceWeight(sourceType: SearchSourceType, profile: UnifiedSearchProfile): number {
  if (profile === "session") {
    if (sourceType === "session_message") return 1.2;
    if (sourceType === "tool_evidence_summary" || sourceType === "attachment") return 1.1;
    if (sourceType === "conversation_window" || sourceType === "compact_summary") return 1.0;
    return 0.9;
  }
  if (profile === "memory") {
    if (sourceType === "people" || sourceType === "memory" || sourceType === "owner") return 1.25;
    if (sourceType === "diary" || sourceType === "diary_note") return 1.15;
    if (sourceType === "tool_evidence_summary" || sourceType === "compact_summary") return 1.05;
    if (sourceType === "conversation_window") return 0.95;
    return 0.9;
  }
  return DURABLE_SOURCE_TYPES.has(sourceType) ? 1.1 : 1.0;
}

function dateFileCutoff(excludeRecentDays?: number): string | undefined {
  if (!excludeRecentDays || excludeRecentDays <= 0) return undefined;
  const date = new Date();
  date.setDate(date.getDate() - excludeRecentDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function passesSearchFilters(row: SearchRow, options: UnifiedSearchOptions): boolean {
  if (!canViewScope(row.visibility_scope, options.visibility)) return false;
  if (!sourceAllowed(row.source_type, options)) return false;
  if (options.excludeSourceIds?.includes(row.source_id)) return false;
  if (row.session_id && options.excludeSessionIds?.includes(row.session_id)) return false;
  if (options.excludeDocumentIds?.includes(row.id)) return false;
  const cutoff = dateFileCutoff(options.excludeRecentDays);
  if (cutoff && /^\d{4}-\d{2}-\d{2}\.md$/.test(row.source_id) && row.source_id.slice(0, 10) >= cutoff) return false;
  return true;
}

function rowToResult(row: SearchRow): Omit<UnifiedSearchResult, "score" | "matchedBy"> {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    parentId: row.parent_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    channelId: row.channel_id ?? undefined,
    visibilityScope: row.visibility_scope,
    ordinal: row.ordinal ?? undefined,
    role: row.role ?? undefined,
    text: row.text,
    occurredAt: row.occurred_at ?? undefined,
  };
}

function addContext(result: UnifiedSearchResult, visibility: SearchVisibilityContext): void {
  if (result.sourceType !== "session_message" || !result.sessionId || result.ordinal === undefined) return;
  const rows = getDb().prepare(`
    SELECT rowid, id, source_type, source_id, parent_id, session_id, channel_id,
      visibility_scope, ordinal, role, text, content_hash, occurred_at
    FROM search_documents
    WHERE source_type = 'session_message' AND session_id = ? AND ordinal BETWEEN ? AND ?
    ORDER BY ordinal
  `).all(result.sessionId, Math.max(0, result.ordinal - 1), result.ordinal + 1) as SearchRow[];
  const visible = rows.filter(row => row.id !== result.id && canViewScope(row.visibility_scope, visibility));
  if (visible.length > 0) {
    result.context = visible.map(row => ({
      id: row.id,
      role: row.role ?? undefined,
      text: row.text,
      occurredAt: row.occurred_at ?? undefined,
    }));
  }
}

/** Unified permission-aware hybrid search over every indexed source. */
export async function searchUnified(query: string, options: UnifiedSearchOptions): Promise<UnifiedSearchResponse> {
  const traceId = createSearchDocumentId("search-trace", Date.now(), Math.random()).slice(0, 16);
  const normalizedQuery = normalizeText(query);
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 10), 1), 100);
  const candidateLimit = Math.min(Math.max(Math.floor(options.candidateLimit ?? Math.max(60, limit * 8)), limit), 500);
  const profile = options.profile ?? "all";
  const db = getDb();
  const byId = new Map<string, {
    row: SearchRow;
    score: number;
    vectorScore?: number;
    ftsRank?: number;
    matchedBy: Set<"vector" | "fts">;
  }>();
  let vectorCandidates = 0;
  let ftsCandidates = 0;
  let filteredCandidates = 0;
  let embeddingAvailable = false;

  if (!normalizedQuery) {
    return { traceId, results: [], diagnostics: { vectorCandidates, ftsCandidates, filteredCandidates, groupedCandidates: 0, embeddingAvailable } };
  }

  const ftsQuery = toSearchTokens(normalizedQuery)
    .split(/\s+/)
    .filter(Boolean)
    .map(token => `"${token.replace(/"/g, '""')}"`)
    .join(" OR ");
  if (ftsQuery) {
    try {
      const rows = db.prepare(`
        SELECT d.rowid, d.id, d.source_type, d.source_id, d.parent_id, d.session_id,
          d.channel_id, d.visibility_scope, d.ordinal, d.role, d.text, d.content_hash,
          d.occurred_at, bm25(search_documents_fts) AS lexical_score
        FROM search_documents_fts f
        JOIN search_documents d ON d.rowid = f.rowid
        WHERE search_documents_fts MATCH ?
        ORDER BY lexical_score
        LIMIT ?
      `).all(ftsQuery, candidateLimit) as Array<SearchRow & { lexical_score: number }>;
      ftsCandidates = rows.length;
      let rank = 0;
      for (const row of rows) {
        if (!passesSearchFilters(row, options)) { filteredCandidates++; continue; }
        rank++;
        const weighted = (1 / (60 + rank)) * 1.15 * sourceWeight(row.source_type, profile);
        const current = byId.get(row.id) ?? { row, score: 0, matchedBy: new Set<"vector" | "fts">() };
        current.score += weighted;
        current.ftsRank = rank;
        current.matchedBy.add("fts");
        byId.set(row.id, current);
      }
    } catch (error) {
      logger.warn({ traceId, err: (error as Error).message }, "unified FTS search failed");
    }
  }

  if (process.env.GOOGLE_API_KEY) {
    try {
      const count = (db.prepare(`SELECT count(*) AS c FROM ${SEARCH_DOCUMENT_VEC_TABLE}`).get() as { c: number }).c;
      if (count > 0) {
        embeddingAvailable = true;
        const vector = await embed(normalizedQuery);
        const blob = vectorToBlob(vector);
        const k = Math.min(candidateLimit, count);
        const rows = db.prepare(`
          SELECT d.rowid, d.id, d.source_type, d.source_id, d.parent_id, d.session_id,
            d.channel_id, d.visibility_scope, d.ordinal, d.role, d.text, d.content_hash,
            d.occurred_at, v.distance
          FROM ${SEARCH_DOCUMENT_VEC_TABLE} v
          JOIN search_documents d ON d.rowid = v.rowid
          WHERE v.embedding MATCH ? AND k = ?
        `).all(blob, k) as Array<SearchRow & { distance: number }>;
        vectorCandidates = rows.length;
        let rank = 0;
        for (const row of rows) {
          if (!passesSearchFilters(row, options)) { filteredCandidates++; continue; }
          rank++;
          const vectorScore = 1 - row.distance;
          if (vectorScore <= 0) continue;
          const weighted = (1 / (60 + rank)) * sourceWeight(row.source_type, profile);
          const current = byId.get(row.id) ?? { row, score: 0, matchedBy: new Set<"vector" | "fts">() };
          current.score += weighted;
          current.vectorScore = vectorScore;
          current.matchedBy.add("vector");
          byId.set(row.id, current);
        }
      }
    } catch (error) {
      logger.warn({ traceId, err: (error as Error).message }, "unified vector search failed; using FTS candidates only");
    }
  }

  const ranked = [...byId.values()].sort((a, b) => b.score - a.score);
  const grouped: typeof ranked = [];
  const perSession = new Map<string, number>();
  for (const candidate of ranked) {
    const sessionKey = candidate.row.session_id ?? "";
    const sessionCount = sessionKey ? (perSession.get(sessionKey) ?? 0) : 0;
    if (sessionKey && sessionCount >= Math.max(2, Math.ceil(limit / 3))) continue;
    if (sessionKey) perSession.set(sessionKey, sessionCount + 1);
    grouped.push(candidate);
    if (grouped.length >= limit) break;
  }

  const maxScore = grouped[0]?.score || 1;
  const results = grouped.map(candidate => ({
    ...rowToResult(candidate.row),
    score: candidate.score / maxScore,
    vectorScore: candidate.vectorScore,
    ftsRank: candidate.ftsRank,
    matchedBy: [...candidate.matchedBy],
  } satisfies UnifiedSearchResult));
  if (options.includeContext !== false) {
    for (const result of results) addContext(result, options.visibility);
  }

  const response: UnifiedSearchResponse = {
    traceId,
    results,
    diagnostics: {
      vectorCandidates,
      ftsCandidates,
      filteredCandidates,
      groupedCandidates: results.length,
      embeddingAvailable,
    },
  };
  if (options.debug) {
    logger.info({
      traceId,
      query: normalizedQuery.slice(0, 200),
      profile,
      diagnostics: response.diagnostics,
      results: results.map(result => ({
        id: result.id,
        sourceType: result.sourceType,
        sourceId: result.sourceId,
        score: Number(result.score.toFixed(4)),
        vectorScore: result.vectorScore === undefined ? undefined : Number(result.vectorScore.toFixed(4)),
        ftsRank: result.ftsRank,
      })),
    }, "unified search trace");
  }
  return response;
}
