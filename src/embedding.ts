import { logger } from "./logger.js";
import { getDb, VEC_TABLE } from "./db.js";

const EMBED_MODEL = "gemini-embedding-001";

function getApiKey(): string { return process.env.GOOGLE_API_KEY ?? ""; }
function getEmbedUrl(): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${getApiKey()}`;
}

/** 刪除某個檔案的所有向量 */
export function removeVectorsByFile(file: string): void {
  try {
    const db = getDb();
    const rows = db.prepare("SELECT id FROM memory_vectors WHERE file = ?").all(file) as Array<{ id: number }>;
    if (rows.length === 0) return;
    const ids = rows.map(r => Number(r.id));
    db.transaction(() => {
      db.prepare(`DELETE FROM ${VEC_TABLE} WHERE rowid IN (${ids.join(",")})`).run();
      db.prepare(`DELETE FROM memory_fts WHERE rowid IN (${ids.join(",")})`).run();
      db.prepare(`DELETE FROM memory_vectors WHERE file = ?`).run(file);
    })();
    logger.info({ file, count: ids.length }, "vectors removed for file");
  } catch (err) {
    logger.error({ err: (err as Error).message, file }, "remove vectors failed");
  }
}

/** 呼叫 Gemini embedding API */
export async function embed(text: string): Promise<number[]> {
  const res = await fetch(getEmbedUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text }] },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embedding API ${res.status}: ${err}`);
  }
  const data = await res.json() as { embedding: { values: number[] } };
  return data.embedding.values;
}

/** Float32Array → Buffer for sqlite-vec */
function vectorToBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

const DEDUP_THRESHOLD = 0.92;

/** 新增一筆記憶的向量（自動去重） */
export async function addVector(text: string, file: string): Promise<void> {
  if (!getApiKey()) {
    logger.warn("GOOGLE_API_KEY not set, skipping embedding");
    return;
  }
  try {
    const db = getDb();

    // 完全相同文字 → 跳過
    const exists = db.prepare("SELECT 1 FROM memory_vectors WHERE text = ?").get(text);
    if (exists) {
      logger.debug({ file }, "vector skipped: exact duplicate");
      return;
    }

    const vector = await embed(text);

    // 語意高度重複 → 用 sqlite-vec KNN 查
    const blob = vectorToBlob(vector);

    // 語意去重：用 sqlite-vec KNN 查最近鄰（空表跳過）
    const count = (db.prepare("SELECT count(*) as c FROM memory_vectors").get() as { c: number }).c;
    if (count > 0) {
      try {
        const similar = db.prepare(`
          SELECT rowid, distance FROM ${VEC_TABLE}
          WHERE embedding MATCH ? AND k = 1
        `).get(blob) as { rowid: number; distance: number } | undefined;

        if (similar && (1 - similar.distance) >= DEDUP_THRESHOLD) {
          logger.debug({ file }, "vector skipped: semantic duplicate");
          return;
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "dedup check failed, continuing");
      }
    }

    // 插入 memory_vectors + memory_vectors_vec + memory_fts。
    // 三張表用同一個 rowid 對齊，必須明寫 rowid（不能靠隱式遞增）並包在
    // transaction 裡——任何一句失敗就整批回滾，否則 rowid 會永久錯位，
    // 之後所有搜尋都會 JOIN 到錯誤的記憶內容。
    const insertMain = db.prepare("INSERT INTO memory_vectors (text, file) VALUES (?, ?)");
    const insertVec = db.prepare(`INSERT INTO ${VEC_TABLE} (rowid, embedding) VALUES (?, ?)`);
    const insertFts = db.prepare("INSERT INTO memory_fts (rowid, text, file) VALUES (?, ?, ?)");

    const id = db.transaction(() => {
      const rowId = Number(insertMain.run(text, file).lastInsertRowid);
      // vec0 的 rowid 綁定只吃 BigInt，傳一般 number 會被拒
      insertVec.run(BigInt(rowId), blob);
      insertFts.run(rowId, text, file);
      return rowId;
    })();

    logger.info({ file, id, textLen: text.length }, "vector added to db");
  } catch (err) {
    logger.error({ err: (err as Error).message }, "embedding failed");
  }
}

export interface SearchOptions {
  /** 排除特定檔案（例如已在 prompt 中的 MEMORY.md） */
  excludeFiles?: string[];
  /** 排除最近 N 天的日記檔（startup 已讀，避免重複） */
  excludeRecentDays?: number;
}

const DATE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const SCORE_THRESHOLD = 0.65;

/** 語意搜尋：回傳最相關的記憶 */
export async function searchVectors(query: string, topK = 10, options: SearchOptions = {}): Promise<Array<{ text: string; file: string; score: number }>> {
  if (!getApiKey()) return [];

  try {
    const db = getDb();
    const queryVec = await embed(query);
    const blob = vectorToBlob(queryVec);

    const results = db.prepare(`
      SELECT v.rowid, mv.text, mv.file, v.distance
      FROM ${VEC_TABLE} v
      JOIN memory_vectors mv ON mv.id = v.rowid
      WHERE v.embedding MATCH ? AND k = ?
    `).all(blob, topK) as Array<{ text: string; file: string; distance: number }>;

    const { excludeFiles = [], excludeRecentDays } = options;
    let cutoffDate: string | null = null;
    if (excludeRecentDays) {
      const d = new Date();
      d.setDate(d.getDate() - excludeRecentDays);
      cutoffDate = d.toISOString().split("T")[0];
    }

    return results
      .map(r => ({ text: r.text, file: r.file, score: 1 - r.distance }))
      .filter(r => {
        if (r.score <= SCORE_THRESHOLD) return false;
        if (excludeFiles.includes(r.file)) return false;
        if (cutoffDate && DATE_FILE_RE.test(r.file) && r.file.slice(0, 10) >= cutoffDate) return false;
        return true;
      });
  } catch (err) {
    logger.error({ err: (err as Error).message }, "vector search failed");
    return [];
  }
}
