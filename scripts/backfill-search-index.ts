import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { ARCHIVE_DIR, ATTACHMENTS_DIR, MEMORY_DIR, SESSIONS_DIR } from "../src/paths.js";
import type { Message, ToolHistoryEvent } from "../src/types.js";
import { getDb } from "../src/db.js";
import { Session } from "../src/session.js";
import { indexCompactSummary, indexConversationWindow, reconcileSessionIndex } from "../src/session-index.js";
import { reindexDiary, reindexMemory, reindexOwner, reindexPeople } from "../src/workspace-index.js";
import { processAttachmentJobs } from "../src/attachment-index.js";
import { processEmbeddingJobs, repairSearchIndexProjections, type SearchIndexIntegrityReport } from "../src/search-index.js";

interface SessionPayload {
  sessionId?: string;
  messages?: Message[];
  toolHistory?: ToolHistoryEvent[];
  summary?: string;
}

interface BackfillReport {
  startedAt: string;
  completedAt?: string;
  dryRun: boolean;
  scanned: {
    activeSessions: number;
    archiveFiles: number;
    messages: number;
    toolEvents: number;
    compactSummaries: number;
    diaries: number;
    attachmentRecords?: number;
  };
  indexed: {
    activeSessions: number;
    archiveFiles: number;
    workspaceSources: number;
  };
  failures: Array<{ source: string; error: string }>;
  database?: Record<string, number>;
  sourceDistribution?: Record<string, number>;
  jobStatus?: Record<string, number>;
  integrity?: SearchIndexIntegrityReport;
}

function parseArgs(argv: string[]): {
  dryRun: boolean;
  drainEmbeddings: boolean;
  processAttachments: boolean;
  reportPath: string;
} {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    dryRun: argv.includes("--dry-run"),
    drainEmbeddings: argv.includes("--drain-embeddings"),
    processAttachments: argv.includes("--process-attachments"),
    reportPath: resolve(value("--report") || resolve(ATTACHMENTS_DIR, "search-index-backfill-report.json")),
  };
}

function readPayload(path: string): SessionPayload {
  return JSON.parse(readFileSync(path, "utf8")) as SessionPayload;
}

function archiveFiles(): string[] {
  if (!existsSync(ARCHIVE_DIR)) return [];
  return readdirSync(ARCHIVE_DIR)
    .filter(file => file.endsWith(".json"))
    .sort()
    .map(file => resolve(ARCHIVE_DIR, file));
}

function diaryFiles(): string[] {
  if (!existsSync(MEMORY_DIR)) return [];
  return readdirSync(MEMORY_DIR)
    .filter(file => /^\d{4}-\d{2}-\d{2}\.md$/.test(file))
    .sort()
    .map(file => resolve(MEMORY_DIR, file));
}

function databaseCounts(): Record<string, number> {
  const db = getDb();
  const tables = [
    "search_documents", "search_documents_fts", "search_document_embeddings",
    "embedding_jobs", "attachment_records", "attachment_jobs",
  ];
  return Object.fromEntries(tables.map(table => {
    const count = (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
    return [table, count];
  }));
}


function groupedCounts(table: string, column: string): Record<string, number> {
  const rows = getDb().prepare(`SELECT ${column} AS key, count(*) AS count FROM ${table} GROUP BY ${column} ORDER BY ${column}`).all() as Array<{ key: string; count: number }>;
  return Object.fromEntries(rows.map(row => [row.key, row.count]));
}

async function drainJobs(): Promise<void> {
  for (;;) {
    const result = await processEmbeddingJobs(20);
    if (result.remaining === 0 || (result.completed === 0 && result.failed === 0)) break;
  }
}

async function drainAttachmentJobs(): Promise<void> {
  for (;;) {
    const result = await processAttachmentJobs(2);
    if (result.remaining === 0 || (result.completed === 0 && result.failed === 0)) break;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const archives = archiveFiles();
  const diaries = diaryFiles();
  const activeIds = Session.listActive();
  const report: BackfillReport = {
    startedAt: new Date().toISOString(),
    dryRun: options.dryRun,
    scanned: {
      activeSessions: activeIds.length,
      archiveFiles: archives.length,
      messages: 0,
      toolEvents: 0,
      compactSummaries: 0,
      diaries: diaries.length,
      ...(!options.dryRun ? { attachmentRecords: (getDb().prepare("SELECT count(*) AS count FROM attachment_records").get() as { count: number }).count } : {}),
    },
    indexed: { activeSessions: 0, archiveFiles: 0, workspaceSources: 0 },
    failures: [],
  };

  for (const id of activeIds) {
    try {
      const session = new Session(id);
      report.scanned.messages += session.getMessages().length;
      if (!options.dryRun) {
        session.reconcileSearchIndex();
        indexConversationWindow(id, session.getMessages());
        report.indexed.activeSessions++;
      }
    } catch (error) {
      report.failures.push({ source: `active:${id}`, error: (error as Error).message });
    }
  }

  // Read active JSON separately for exact tool-event accounting without widening Session's public API.
  for (const file of readdirSync(SESSIONS_DIR).filter(name => name.endsWith(".json"))) {
    try {
      const payload = readPayload(resolve(SESSIONS_DIR, file));
      report.scanned.toolEvents += payload.toolHistory?.length ?? 0;
    } catch (error) {
      report.failures.push({ source: `active-file:${file}`, error: (error as Error).message });
    }
  }

  for (const path of archives) {
    try {
      const payload = readPayload(path);
      if (!payload.sessionId) throw new Error("archive has no sessionId");
      const messages = payload.messages ?? [];
      const tools = payload.toolHistory ?? [];
      report.scanned.messages += messages.length;
      report.scanned.toolEvents += tools.length;
      if (payload.summary?.trim()) report.scanned.compactSummaries++;
      if (!options.dryRun) {
        reconcileSessionIndex(payload.sessionId, messages, tools);
        indexConversationWindow(payload.sessionId, messages);
        if (payload.summary?.trim()) indexCompactSummary(payload.sessionId, payload.summary);
        report.indexed.archiveFiles++;
      }
    } catch (error) {
      report.failures.push({ source: `archive:${basename(path)}`, error: (error as Error).message });
    }
  }

  if (!options.dryRun) {
    for (const [name, operation] of [
      ["PEOPLE.md", () => reindexPeople()],
      ["MEMORY.md", () => reindexMemory()],
      ["OWNER.md", () => reindexOwner()],
    ] as const) {
      try { operation(); report.indexed.workspaceSources++; }
      catch (error) { report.failures.push({ source: name, error: (error as Error).message }); }
    }
    for (const path of diaries) {
      try { reindexDiary(path); report.indexed.workspaceSources++; }
      catch (error) { report.failures.push({ source: `diary:${basename(path)}`, error: (error as Error).message }); }
    }
    if (options.processAttachments) await drainAttachmentJobs();
    if (options.drainEmbeddings) await drainJobs();
    report.integrity = repairSearchIndexProjections();
    report.database = databaseCounts();
    report.sourceDistribution = groupedCounts("search_documents", "source_type");
    report.jobStatus = groupedCounts("embedding_jobs", "status");
  }

  report.completedAt = new Date().toISOString();
  mkdirSync(resolve(options.reportPath, ".."), { recursive: true });
  writeFileSync(options.reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length > 0) process.exitCode = 1;
}

void main();
