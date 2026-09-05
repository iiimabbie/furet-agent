import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const tempDir = mkdtempSync(join(tmpdir(), "umiro-workspace-index-"));
process.env.UMIRO_DB_PATH = join(tempDir, "test.db");

const { closeDb, getDb } = await import("../src/db.js");
const { shouldEmbedSource } = await import("../src/search-index.js");
const { reindexMemory, reindexOwner, reindexPeople } = await import("../src/workspace-index.js");

after(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

test("PEOPLE remains vector-backed while always-inlined profiles skip embedding", () => {
  assert.equal(shouldEmbedSource("people"), true);
  assert.equal(shouldEmbedSource("owner"), false);
  assert.equal(shouldEmbedSource("memory"), false);

  reindexPeople(`<people>
## Alpha
- Discord ID: 101
- Notes: first
</people>`);
  reindexOwner(`<owner>
## Owner
- Notes: always inline
</owner>`);
  reindexMemory(`<memory>
## Rules
- Notes: always inline
</memory>`);

  const db = getDb();
  const statuses = db.prepare(`
    SELECT source_type, embedding_status FROM search_documents
    WHERE source_type IN ('people', 'owner', 'memory') ORDER BY source_type
  `).all() as Array<{ source_type: string; embedding_status: string }>;
  assert.deepEqual(statuses, [
    { source_type: "memory", embedding_status: "skipped" },
    { source_type: "owner", embedding_status: "skipped" },
    { source_type: "people", embedding_status: "pending" },
  ]);
  const jobs = db.prepare("SELECT count(*) AS count FROM embedding_jobs").get() as { count: number };
  assert.equal(jobs.count, 1);
});

test("profile reconciliation preserves unchanged sections and replaces changed or removed sections", () => {
  const first = `<people>
## Alpha
- Discord ID: 101
- Notes: first

## Beta
- Discord ID: 102
- Notes: stable
</people>`;
  reindexPeople(first);
  const db = getDb();
  const betaBefore = db.prepare(`
    SELECT id FROM search_documents WHERE source_type='people' AND text LIKE '## Beta%'
  `).get() as { id: string };
  db.prepare("UPDATE search_documents SET embedding_status='complete' WHERE id=?").run(betaBefore.id);
  db.prepare("UPDATE embedding_jobs SET status='complete' WHERE document_id=?").run(betaBefore.id);

  reindexPeople(`<people>
## Alpha
- Discord ID: 101
- Notes: changed

## Beta
- Discord ID: 102
- Notes: stable
</people>`);
  const betaAfter = db.prepare(`
    SELECT id, embedding_status FROM search_documents WHERE source_type='people' AND text LIKE '## Beta%'
  `).get() as { id: string; embedding_status: string };
  assert.equal(betaAfter.id, betaBefore.id);
  assert.equal(betaAfter.embedding_status, "complete");
  assert.equal((db.prepare(`SELECT count(*) AS count FROM search_documents WHERE source_type='people'`).get() as { count: number }).count, 2);
  assert.match((db.prepare(`SELECT text FROM search_documents WHERE source_type='people' AND text LIKE '## Alpha%'`).get() as { text: string }).text, /changed/);

  reindexPeople(`<people>
## Beta
- Discord ID: 102
- Notes: stable
</people>`);
  const remaining = db.prepare(`SELECT id, text FROM search_documents WHERE source_type='people'`).all() as Array<{ id: string; text: string }>;
  assert.deepEqual(remaining, [{ id: betaBefore.id, text: "## Beta\n- Discord ID: 102\n- Notes: stable" }]);
});
