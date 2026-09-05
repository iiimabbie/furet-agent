import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { MEMORY_DIR, MEMORY_INDEX, OWNER_FILE, PEOPLE_FILE } from "./paths.js";
import {
  createSearchDocumentId,
  ingestSearchDocuments,
  removeSearchDocumentsForSource,
  type SearchDocumentInput,
  type SearchSourceType,
} from "./search-index.js";

const MAX_CHUNK_CHARS = 4_000;

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function stripWrapper(text: string, tag: string): string {
  return normalize(text)
    .replace(new RegExp(`^<${tag}>\\s*`, "i"), "")
    .replace(new RegExp(`\\s*</${tag}>$`, "i"), "")
    .trim();
}

function splitOversized(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= MAX_CHUNK_CHARS) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (paragraph.length <= MAX_CHUNK_CHARS) current = paragraph;
    else {
      for (let offset = 0; offset < paragraph.length; offset += MAX_CHUNK_CHARS) {
        chunks.push(paragraph.slice(offset, offset + MAX_CHUNK_CHARS));
      }
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

interface WorkspaceChunk { text: string; identity: string }

function contentDigest(text: string): string {
  return createHash("sha256").update(normalize(text)).digest("hex").slice(0, 20);
}

function markdownSections(text: string): WorkspaceChunk[] {
  const body = normalize(text);
  if (!body) return [];
  const headingPath: string[] = [];
  const raw: Array<{ text: string; path: string }> = [];
  let current: string[] = [];
  let currentPath = "preamble";
  const flush = (): void => {
    const value = current.join("\n").trim();
    if (value) raw.push({ text: value, path: currentPath });
    current = [];
  };
  for (const line of body.split("\n")) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      headingPath.length = level - 1;
      headingPath[level - 1] = heading[2].trim().toLowerCase();
      currentPath = headingPath.filter(Boolean).join(" > ") || "preamble";
    }
    current.push(line);
  }
  flush();

  const duplicateCounts = new Map<string, number>();
  return raw.flatMap(section => splitOversized(section.text).map((chunk, chunkIndex) => {
    const base = `${section.path}:${contentDigest(chunk)}:${chunkIndex}`;
    const occurrence = duplicateCounts.get(base) ?? 0;
    duplicateCounts.set(base, occurrence + 1);
    return { text: chunk, identity: `${base}:${occurrence}` };
  }));
}

function diarySections(text: string): WorkspaceChunk[] {
  const body = normalize(text);
  if (!body) return [];
  const duplicateCounts = new Map<string, number>();
  return body.split(/\n{2,}/).flatMap(splitOversized).map(chunk => chunk.trim()).filter(Boolean).map(chunk => {
    const digest = contentDigest(chunk);
    const occurrence = duplicateCounts.get(digest) ?? 0;
    duplicateCounts.set(digest, occurrence + 1);
    return { text: chunk, identity: `${digest}:${occurrence}` };
  });
}

const DAILY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * Durable workspace files (OWNER/PEOPLE/MEMORY) carry no event time, so their documents
 * stay untimed. A daily file is different: its name *is* the date, so recall results can
 * report when the entry happened instead of returning an undefined timestamp.
 */
function sourceOccurredAt(sourceId: string): string | undefined {
  const date = DAILY_FILE.exec(sourceId)?.[1];
  return date ? `${date}T00:00:00` : undefined;
}

function replaceSource(
  sourceType: SearchSourceType,
  sourceId: string,
  chunks: WorkspaceChunk[],
  visibilityScope = "owner_private",
): void {
  if (chunks.length === 0) {
    removeSearchDocumentsForSource(sourceType, sourceId);
    return;
  }
  const occurredAt = sourceOccurredAt(sourceId);
  const docs: SearchDocumentInput[] = chunks.map((chunk, ordinal) => ({
    id: createSearchDocumentId("workspace", sourceType, sourceId, chunk.identity),
    sourceType,
    sourceId,
    visibilityScope,
    ordinal,
    occurredAt,
    text: chunk.text,
  }));
  ingestSearchDocuments(docs, { removeMissingForSource: true });
}

export function reindexPeople(content?: string): void {
  const text = content ?? readFileSync(PEOPLE_FILE, "utf-8");
  replaceSource("people", "PEOPLE.md", markdownSections(stripWrapper(text, "people")));
}

export function reindexMemory(content?: string): void {
  const text = content ?? readFileSync(MEMORY_INDEX, "utf-8");
  replaceSource("memory", "MEMORY.md", markdownSections(stripWrapper(text, "memory")));
}

export function reindexOwner(content?: string): void {
  const text = content ?? readFileSync(OWNER_FILE, "utf-8");
  replaceSource("owner", "OWNER.md", markdownSections(stripWrapper(text, "owner")));
}

export function reindexDiary(filePath: string, content?: string): void {
  const sourceId = basename(filePath);
  const text = content ?? readFileSync(filePath, "utf-8");
  // Once the finished diary replaces the working note file, its prose is canonical;
  // remove transient annotations for that date so they cannot be recalled twice.
  removeSearchDocumentsForSource("diary_note", sourceId);
  replaceSource("diary", sourceId, diarySections(text));
}

export function indexDiaryNote(date: string, timestamp: string, content: string): void {
  const sourceId = `${date}.md`;
  const text = normalize(content);
  if (!text) return;
  ingestSearchDocuments([{
    id: createSearchDocumentId("workspace", "diary_note", sourceId, timestamp, text),
    sourceType: "diary_note",
    sourceId,
    visibilityScope: "owner_private",
    occurredAt: `${date}T${timestamp}:00`,
    text,
  }]);
}

/**
 * Bring the search index back in line with the workspace profile files on disk.
 *
 * Reindexing is otherwise driven by the tools that write these files, so edits made outside
 * the agent — a hand edit, a `git restore` — leave the index describing content that no longer
 * exists. Ingestion is hash-gated per section, so a file that has not moved costs nothing and
 * a changed file re-embeds only the sections that changed.
 */
export function reconcileWorkspaceProfiles(): void {
  const sources: Array<[string, () => void]> = [
    [PEOPLE_FILE, () => reindexPeople()],
    [MEMORY_INDEX, () => reindexMemory()],
    [OWNER_FILE, () => reindexOwner()],
  ];
  for (const [file, reindex] of sources) {
    if (!existsSync(file)) continue;
    reindex();
  }
}

export function reindexWorkspacePath(filePath: string, content?: string): boolean {
  const absolute = resolve(filePath);
  if (absolute === resolve(PEOPLE_FILE)) { reindexPeople(content); return true; }
  if (absolute === resolve(MEMORY_INDEX)) { reindexMemory(content); return true; }
  if (absolute === resolve(OWNER_FILE)) { reindexOwner(content); return true; }
  if (resolve(absolute).startsWith(`${resolve(MEMORY_DIR)}/`) && /^\d{4}-\d{2}-\d{2}\.md$/.test(basename(absolute))) {
    reindexDiary(absolute, content);
    return true;
  }
  return false;
}
