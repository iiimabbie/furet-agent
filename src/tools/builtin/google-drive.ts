import { google } from "googleapis";
import { getAuthClient } from "../../google/auth.js";
import type { Tool } from "../../types.js";

function getDrive() {
  const auth = getAuthClient();
  if (!auth) throw new Error("Google API 未授權，請先用 /google-auth 授權");
  return google.drive({ version: "v3", auth });
}

export const driveSearch: Tool = {
  name: "google_drive_search",
  description: "Search files in Google Drive.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (file name or content keyword)" },
      max_results: { type: "number", description: "Max files to return (default: 10)" },
    },
    required: ["query"],
  },
  execute: async (args) => {
    const { query, max_results } = args as { query: string; max_results?: number };
    const drive = getDrive();
    const res = await drive.files.list({
      q: `name contains '${query.replace(/'/g, "\\'")}'`,
      pageSize: max_results || 10,
      fields: "files(id, name, mimeType, modifiedTime, size)",
      orderBy: "modifiedTime desc",
    });
    const files = res.data.files || [];
    if (files.length === 0) return "No files found.";
    return files.map(f =>
      `[${f.id}] ${f.name} (${f.mimeType}) modified: ${f.modifiedTime}`
    ).join("\n");
  },
};

export const driveRead: Tool = {
  name: "google_drive_read",
  description: "Read the text content of a Google Drive file (Google Docs, Sheets, or plain text files).",
  parameters: {
    type: "object",
    properties: {
      file_id: { type: "string", description: "File ID" },
    },
    required: ["file_id"],
  },
  execute: async (args) => {
    const { file_id } = args as { file_id: string };
    const drive = getDrive();
    // get file metadata first
    const meta = await drive.files.get({ fileId: file_id, fields: "mimeType, name" });
    const mime = meta.data.mimeType || "";

    if (mime.startsWith("application/vnd.google-apps.")) {
      // export Google Docs/Sheets/Slides as plain text
      const res = await drive.files.export({ fileId: file_id, mimeType: "text/plain" }, { responseType: "text" });
      return `[${meta.data.name}]\n${res.data as string}`;
    }
    // download regular file content
    const res = await drive.files.get({ fileId: file_id, alt: "media" }, { responseType: "text" });
    const content = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    return `[${meta.data.name}]\n${content.slice(0, 10000)}`;
  },
};

export const driveUpload: Tool = {
  name: "google_drive_upload",
  description: "Upload a text file to Google Drive.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "File name" },
      content: { type: "string", description: "File content (plain text)" },
      mime_type: { type: "string", description: "MIME type (default: text/plain)" },
      folder_id: { type: "string", description: "Parent folder ID (optional)" },
    },
    required: ["name", "content"],
  },
  execute: async (args) => {
    const { name, content, mime_type, folder_id } = args as {
      name: string; content: string; mime_type?: string; folder_id?: string;
    };
    const drive = getDrive();
    const { Readable } = await import("node:stream");
    const res = await drive.files.create({
      requestBody: {
        name,
        ...(folder_id ? { parents: [folder_id] } : {}),
      },
      media: {
        mimeType: mime_type || "text/plain",
        body: Readable.from(content),
      },
      fields: "id, name",
    });
    return `File uploaded: "${res.data.name}" (${res.data.id})`;
  },
};
