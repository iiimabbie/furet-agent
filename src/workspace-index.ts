import { readFileSync } from "node:fs";
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

function markdownSections(text: string): string[] {
  const body = normalize(text);
  if (!body) return [];
  const lines = body.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{1,3}\s+/.test(line) && current.some(value => value.trim())) {
      sections.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.some(value => value.trim())) sections.push(current.join("\n").trim());
  return sections.flatMap(splitOversized).filter(chunk => chunk.length > 0);
}

function diarySections(text: string): string[] {
  const body = normalize(text);
  if (!body) return [];
  return body.split(/\n{2,}/).flatMap(splitOversized).map(chunk => chunk.trim()).filter(Boolean);
}

function replaceSource(
  sourceType: SearchSourceType,
  sourceId: string,
  chunks: string[],
  visibilityScope = "owner_private",
): void {
  if (chunks.length === 0) {
    removeSearchDocumentsForSource(sourceType, sourceId);
    return;
  }
  const docs: SearchDocumentInput[] = chunks.map((text, ordinal) => ({
    id: createSearchDocumentId("workspace", sourceType, sourceId, ordinal),
    sourceType,
    sourceId,
    visibilityScope,
    ordinal,
    text,
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
