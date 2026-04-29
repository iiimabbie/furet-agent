/**
 * 一次性腳本：把現有的 MEMORY.md、PEOPLE.md、日記檔灌進 SQLite 向量庫
 * 用法：npx tsx scripts/migrate-vectors.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MEMORY_DIR, MEMORY_INDEX } from "../src/paths.js";
import { addVector } from "../src/embedding.js";
import { getDb } from "../src/db.js";
import "dotenv/config";

async function migrate() {
  // 確保 DB 初始化
  getDb();

  const files: Array<{ path: string; name: string }> = [];

  // MEMORY.md
  try {
    files.push({ path: MEMORY_INDEX, name: "MEMORY.md" });
  } catch {}

  // PEOPLE.md
  const peoplePath = resolve(MEMORY_DIR, "..", "PEOPLE.md");
  try {
    readFileSync(peoplePath);
    files.push({ path: peoplePath, name: "PEOPLE.md" });
  } catch {}

  // 日記檔
  try {
    const memoryFiles = readdirSync(MEMORY_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
    for (const f of memoryFiles) {
      files.push({ path: resolve(MEMORY_DIR, f), name: f });
    }
  } catch {}

  console.log(`Found ${files.length} files to migrate`);

  for (const file of files) {
    const content = readFileSync(file.path, "utf-8");
    const paragraphs = content.split(/\n{2,}/).filter(p => p.trim().length > 20);
    console.log(`${file.name}: ${paragraphs.length} paragraphs`);

    for (const p of paragraphs) {
      try {
        await addVector(p.trim(), file.name);
        process.stdout.write(".");
      } catch (err) {
        process.stdout.write("x");
      }
    }
    console.log();
  }

  console.log("Migration done.");
}

migrate().catch(console.error);
