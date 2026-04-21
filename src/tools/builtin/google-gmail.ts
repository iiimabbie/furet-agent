import { google } from "googleapis";
import { getAuthClient } from "../../google/auth.js";
import type { Tool } from "../../types.js";

function getGmail() {
  const auth = getAuthClient();
  if (!auth) throw new Error("Google API 未授權，請先用 /google-auth 授權");
  return google.gmail({ version: "v1", auth });
}

function decodeBody(body: { data?: string | null }): string {
  if (!body.data) return "";
  return Buffer.from(body.data, "base64url").toString("utf-8");
}

function extractBody(payload: { mimeType?: string | null; body?: { data?: string | null }; parts?: Array<{ mimeType?: string | null; body?: { data?: string | null }; parts?: unknown[] }> }): string {
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBody(payload.body);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBody(part.body);
      }
    }
    for (const part of payload.parts) {
      const result = extractBody(part as typeof payload);
      if (result) return result;
    }
  }
  if (payload.body?.data) return decodeBody(payload.body);
  return "";
}

export const gmailSearch: Tool = {
  name: "google_gmail_search",
  description: "Search Gmail messages. Returns a list of matching messages with subject, from, date.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Gmail search query (same syntax as Gmail search bar)" },
      max_results: { type: "number", description: "Max messages to return (default: 10)" },
    },
    required: ["query"],
  },
  execute: async (args) => {
    const { query, max_results } = args as { query: string; max_results?: number };
    const gmail = getGmail();
    const list = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: max_results || 10,
    });
    const messages = list.data.messages || [];
    if (messages.length === 0) return "No messages found.";

    const results: string[] = [];
    for (const msg of messages) {
      const detail = await gmail.users.messages.get({ userId: "me", id: msg.id!, format: "metadata", metadataHeaders: ["Subject", "From", "Date"] });
      const headers = detail.data.payload?.headers || [];
      const subject = headers.find(h => h.name === "Subject")?.value || "(no subject)";
      const from = headers.find(h => h.name === "From")?.value || "?";
      const date = headers.find(h => h.name === "Date")?.value || "?";
      results.push(`[${msg.id}] ${date} | ${from} | ${subject}`);
    }
    return results.join("\n");
  },
};

export const gmailRead: Tool = {
  name: "google_gmail_read",
  description: "Read a specific Gmail message by ID. Returns the full text body.",
  parameters: {
    type: "object",
    properties: {
      message_id: { type: "string", description: "Message ID" },
    },
    required: ["message_id"],
  },
  execute: async (args) => {
    const { message_id } = args as { message_id: string };
    const gmail = getGmail();
    const res = await gmail.users.messages.get({ userId: "me", id: message_id, format: "full" });
    const headers = res.data.payload?.headers || [];
    const subject = headers.find(h => h.name === "Subject")?.value || "(no subject)";
    const from = headers.find(h => h.name === "From")?.value || "?";
    const date = headers.find(h => h.name === "Date")?.value || "?";
    const body = extractBody(res.data.payload as Parameters<typeof extractBody>[0]);
    return `From: ${from}\nDate: ${date}\nSubject: ${subject}\n\n${body}`;
  },
};

export const gmailSend: Tool = {
  name: "google_gmail_send",
  description: "Send an email.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient email address" },
      subject: { type: "string", description: "Email subject" },
      body: { type: "string", description: "Email body (plain text)" },
    },
    required: ["to", "subject", "body"],
  },
  execute: async (args) => {
    const { to, subject, body } = args as { to: string; subject: string; body: string };
    const gmail = getGmail();
    const raw = Buffer.from(
      `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
    ).toString("base64url");
    const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    return `Email sent (${res.data.id})`;
  },
};

export const gmailCreateDraft: Tool = {
  name: "google_gmail_create_draft",
  description: "Create an email draft.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient email address" },
      subject: { type: "string", description: "Email subject" },
      body: { type: "string", description: "Email body (plain text)" },
    },
    required: ["to", "subject", "body"],
  },
  execute: async (args) => {
    const { to, subject, body } = args as { to: string; subject: string; body: string };
    const gmail = getGmail();
    const raw = Buffer.from(
      `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
    ).toString("base64url");
    const res = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
    return `Draft created (${res.data.id})`;
  },
};
