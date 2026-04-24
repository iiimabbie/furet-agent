import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger.js";
import { MEMORY_DIR } from "./paths.js";

const VECTORS_FILE = resolve(MEMORY_DIR, "vectors.json");
const GEMINI_API_KEY = process.env.GOOGLE_API_KEY ?? "";
const EMBED_MODEL = "gemini-embedding-001";
const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${GEMINI_API_KEY}`;

export interface VectorEntry {
  text: string;
  file: string;
  vector: number[];
}

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

/** Cosine similarity */
function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 載入向量索引 */
function loadVectors(): VectorEntry[] {
  try {
    return JSON.parse(readFileSync(VECTORS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

/** 儲存向量索引 */
function saveVectors(entries: VectorEntry[]): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(VECTORS_FILE, JSON.stringify(entries));
}

const DEDUP_THRESHOLD = 0.92;

/** 新增一筆記憶的向量（自動去重） */
export async function addVector(text: string, file: string): Promise<void> {
  if (!GEMINI_API_KEY) {
    logger.warn("GOOGLE_API_KEY not set, skipping embedding");
    return;
  }
  try {
    const entries = loadVectors();

    // 完全相同文字 → 跳過
    if (entries.some(e => e.text === text)) {
      logger.debug({ file }, "vector skipped: exact duplicate");
      return;
    }

    const vector = await embed(text);

    // 語意高度重複 → 跳過
    for (const e of entries) {
      if (cosine(vector, e.vector) >= DEDUP_THRESHOLD) {
        logger.debug({ file, duplicateOf: e.file }, "vector skipped: semantic duplicate (>= 0.92)");
        return;
      }
    }

    entries.push({ text, file, vector });
    saveVectors(entries);
    logger.debug({ file, textLen: text.length }, "vector added");
  } catch (err) {
    logger.error({ err: (err as Error).message }, "embedding failed");
  }
}

/** 語意搜尋：回傳最相關的記憶 */
export async function searchVectors(query: string, topK = 10): Promise<Array<{ text: string; file: string; score: number }>> {
  if (!GEMINI_API_KEY) return [];
  const entries = loadVectors();
  if (entries.length === 0) return [];

  try {
    const queryVec = await embed(query);
    const scored = entries.map(e => ({
      text: e.text,
      file: e.file,
      score: cosine(queryVec, e.vector),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).filter(s => s.score > 0.3);
  } catch (err) {
    logger.error({ err: (err as Error).message }, "vector search failed");
    return [];
  }
}
