import { createHash, randomUUID } from "node:crypto";
import type { ContentBlock, Message, ToolHistoryEvent } from "./types.js";
import {
  createSearchDocumentId,
  ingestSearchDocuments,
  type SearchDocumentInput,
} from "./search-index.js";
import { logger } from "./logger.js";
import { reconcileAttachmentReferences } from "./attachment-index.js";

const MAX_CHUNK_CHARS = 6_000;
const CHUNK_OVERLAP_CHARS = 400;

const IGNORED_SYSTEM_PREFIXES = [
  "[System] Session ending — flush memory now.",
  "[System] Previous conversation summary:\n",
  "[System] Tools actually executed in the preceding assistant turn",
  "[System] Session is being archived",
  "[System] The following messages were proactively pushed to this channel",
];

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stringifyContent(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content.flatMap(block => {
    if (block.type === "text") return [block.text];
    return [];
  }).join("\n");
}

function stripTransportMetadata(text: string): string {
  return text
    .replace(/^\[msg:\S+\s[^\]]*\]\s*/, "")
    .replace(/^<@!?\d+>(?:\([^)]*\))?:\s*/, "")
    .replace(/^\(reply to msg:\d+\)\s*/, "")
    .trim();
}

export function searchableMessageText(message: Message): string | null {
  if (message.isOnboarding || message.isCompactSummary) return null;
  const raw = stringifyContent(message.content).trim();
  if (!raw || IGNORED_SYSTEM_PREFIXES.some(prefix => raw.startsWith(prefix))) return null;
  const text = stripTransportMetadata(raw);
  return text || null;
}

export function ensureMessageSearchId(sessionId: string, message: Message, ordinal: number): string {
  if (message.searchId) return message.searchId;
  // New messages receive a UUID before persistence. This deterministic fallback is for
  // legacy active/archive messages that predate searchId and must remain stable on rebuild.
  const legacyIdentity = JSON.stringify({
    sessionId,
    ordinal,
    role: message.role,
    content: message.content,
    time: message.time ?? null,
    msgId: message.msgId ?? null,
    replyTo: message.replyTo ?? null,
  });
  message.searchId = `legacy-${stableHash(legacyIdentity)}`;
  return message.searchId;
}

export function assignNewMessageSearchId(message: Message): void {
  if (!message.searchId) message.searchId = randomUUID();
}

function sessionChannelId(sessionId: string): string | undefined {
  if (sessionId.startsWith("discord-channel-")) return sessionId.slice("discord-channel-".length);
  return undefined;
}

function sessionVisibility(_sessionId: string): string {
  // Default-deny until Discord channel membership metadata is available to the indexer.
  // Owner-only recall is safer than accidentally exposing a DM/private thread.
  return "owner_private";
}

function splitText(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + MAX_CHUNK_CHARS);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP_CHARS);
  }
  return chunks;
}

function messageDocument(sessionId: string, message: Message, ordinal: number): SearchDocumentInput | null {
  const text = searchableMessageText(message);
  if (!text) return null;
  const messageId = ensureMessageSearchId(sessionId, message, ordinal);
  return {
    id: createSearchDocumentId("session-message", sessionId, messageId),
    sourceType: "session_message",
    sourceId: sessionId,
    parentId: messageId,
    sessionId,
    channelId: sessionChannelId(sessionId),
    visibilityScope: sessionVisibility(sessionId),
    ordinal,
    role: message.role,
    text,
    occurredAt: message.time,
  };
}

function toolDocuments(sessionId: string, event: ToolHistoryEvent, ordinal: number): SearchDocumentInput[] {
  const common = {
    sourceId: sessionId,
    parentId: event.id,
    sessionId,
    channelId: sessionChannelId(sessionId),
    visibilityScope: sessionVisibility(sessionId),
    occurredAt: event.time,
  };
  const inputText = `Tool: ${event.tool}\nStatus: ${event.isError ? "failed" : "succeeded"}\nArguments:\n${JSON.stringify(event.input, null, 2)}`;
  const documents: SearchDocumentInput[] = [{
    ...common,
    id: createSearchDocumentId("tool-call", sessionId, event.id),
    sourceType: "tool_call",
    ordinal,
    role: "assistant",
    text: inputText,
  }];
  const resultChunks = splitText(event.result || "(no textual output)");
  for (let index = 0; index < resultChunks.length; index++) {
    documents.push({
      ...common,
      id: createSearchDocumentId("tool-result", sessionId, event.id, index),
      sourceType: "tool_result",
      ordinal: index,
      role: "tool",
      text: `Tool: ${event.tool}\nStatus: ${event.isError ? "failed" : "succeeded"}\nResult chunk ${index + 1}/${resultChunks.length}:\n${resultChunks[index]}`,
    });
  }
  const bounded = event.result.replace(/\s+/g, " ").trim();
  documents.push({
    ...common,
    id: createSearchDocumentId("tool-summary", sessionId, event.id),
    sourceType: "tool_evidence_summary",
    ordinal,
    role: "tool",
    text: `Tool ${event.tool} ${event.isError ? "failed" : "succeeded"} at ${event.time}. ${bounded.slice(0, 1_500) || "No textual output."}`,
  });
  return documents;
}

export function indexSessionMessage(sessionId: string, message: Message, ordinal: number): void {
  const document = messageDocument(sessionId, message, ordinal);
  if (!document) return;
  ingestSearchDocuments([document]);
}

export function indexToolHistoryEvent(sessionId: string, event: ToolHistoryEvent, ordinal: number): void {
  ingestSearchDocuments(toolDocuments(sessionId, event, ordinal));
}

export function indexConversationWindow(sessionId: string, messages: Message[]): void {
  const parts = messages.flatMap((message, index) => {
    const text = searchableMessageText(message);
    if (!text) return [];
    ensureMessageSearchId(sessionId, message, index);
    return [`${message.role}: ${text}`];
  });
  if (parts.length === 0) return;
  const firstId = messages.find(message => searchableMessageText(message))?.searchId;
  const lastId = [...messages].reverse().find(message => searchableMessageText(message))?.searchId;
  const chunks = splitText(parts.join("\n\n"));
  ingestSearchDocuments(chunks.map((text, ordinal) => ({
    id: createSearchDocumentId("conversation-window", sessionId, firstId, lastId, ordinal),
    sourceType: "conversation_window",
    sourceId: sessionId,
    parentId: `${firstId ?? "unknown"}:${lastId ?? "unknown"}`,
    sessionId,
    channelId: sessionChannelId(sessionId),
    visibilityScope: sessionVisibility(sessionId),
    ordinal,
    text,
    occurredAt: messages[0]?.time,
  })));
}

export function indexCompactSummary(sessionId: string, summary: string): void {
  const text = summary.trim();
  if (!text) return;
  ingestSearchDocuments([{
    id: createSearchDocumentId("compact-summary", sessionId, stableHash(text)),
    sourceType: "compact_summary",
    sourceId: sessionId,
    sessionId,
    channelId: sessionChannelId(sessionId),
    visibilityScope: sessionVisibility(sessionId),
    text,
  }]);
}

export function reconcileSessionIndex(
  sessionId: string,
  messages: Message[],
  toolHistory: ToolHistoryEvent[],
): void {
  try {
    const messageDocs = messages.flatMap((message, ordinal) => {
      const doc = messageDocument(sessionId, message, ordinal);
      return doc ? [doc] : [];
    });
    // Session history is append-only across active/compact/archive segments. Never use
    // removeMissingForSource here: after compaction the active JSON contains only the tail,
    // but the indexed archived messages must remain searchable.
    if (messageDocs.length > 0) ingestSearchDocuments(messageDocs);

    for (let ordinal = 0; ordinal < messages.length; ordinal++) {
      const message = messages[ordinal];
      if (!message.attachments?.length) continue;
      const parentId = ensureMessageSearchId(sessionId, message, ordinal);
      reconcileAttachmentReferences(sessionId, parentId, message.attachments);
    }

    const toolDocs = toolHistory.flatMap((event, ordinal) => toolDocuments(sessionId, event, ordinal));
    for (const sourceType of ["tool_call", "tool_result", "tool_evidence_summary"] as const) {
      const docs = toolDocs.filter(doc => doc.sourceType === sourceType);
      if (docs.length > 0) ingestSearchDocuments(docs);
    }
  } catch (error) {
    logger.error({ sessionId, err: (error as Error).message }, "session search reconciliation failed");
  }
}
