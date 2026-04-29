import { logger } from "./logger.js";
import { getDb } from "./db.js";

const GEMINI_API_KEY = process.env.GOOGLE_API_KEY ?? "";
const EMBED_MODEL = "gemini-embedding-001";
const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${GEMINI_API_KEY}`;

/** 呼叫 Gemini embedding API */
export async function embed(text: string): Promise<number[]> {
  const res = await fetch(EMBED_URL, {
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
  if (!GEMINI_API_KEY) {
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
          SELECT rowid, distance FROM memory_vectors_vec
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

    // 插入 memory_vectors + memory_vectors_vec + memory_fts
    const insertResult = db.prepare("INSERT INTO memory_vectors (text, file) VALUES (?, ?)").run(text, file);
    const id = Number(insertResult.lastInsertRowid);
    db.prepare("INSERT INTO memory_vectors_vec (embedding) VALUES (?)").run(blob);
    db.prepare("INSERT INTO memory_fts (rowid, text, file) VALUES (?, ?, ?)").run(id, text, file);
    logger.info({ file, id, textLen: text.length }, "vector added to db");

    logger.debug({ file, textLen: text.length, id }, "vector added to db");
  } catch (err) {
    logger.error({ err: (err as Error).message }, "embedding failed");
  }
}

/** 語意搜尋：回傳最相關的記憶 */
export async function searchVectors(query: string, topK = 10): Promise<Array<{ text: string; file: string; score: number }>> {
  if (!GEMINI_API_KEY) return [];

  try {
    const db = getDb();
    const queryVec = await embed(query);
    const blob = vectorToBlob(queryVec);

    const results = db.prepare(`
      SELECT v.rowid, mv.text, mv.file, v.distance
      FROM memory_vectors_vec v
      JOIN memory_vectors mv ON mv.id = v.rowid
      WHERE v.embedding MATCH ? AND k = ?
    `).all(blob, topK) as Array<{ text: string; file: string; distance: number }>;

    return results
      .map(r => ({ text: r.text, file: r.file, score: 1 - r.distance }))
      .filter(r => r.score > 0.3);
  } catch (err) {
    logger.error({ err: (err as Error).message }, "vector search failed");
    return [];
  }
}
