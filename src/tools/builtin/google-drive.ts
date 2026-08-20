import { google } from "googleapis";
import { getAuthClient } from "../../google/auth.js";
import { ATTACHMENTS_DIR } from "../../paths.js";
import type { Tool } from "../../types.js";
import { createReadStream, statSync } from "node:fs";
import { resolve, extname, relative, isAbsolute } from "node:path";

function getDrive() {
  const auth = getAuthClient();
  if (!auth) throw new Error("Google API 未授權，請先用 /google-auth 授權");
  return google.drive({ version: "v3", auth });
}

/** Best-effort MIME type guess from file extension. */
const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".json": "application/json",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
};

function guessMime(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return EXT_MIME[ext] || "application/octet-stream";
}

/**
 * Validate that a file_path resolves inside workspace/attachments/.
 * Returns the resolved absolute path, or throws.
 */
function resolveAttachmentPath(filePath: string): string {
  const absPath = isAbsolute(filePath) ? resolve(filePath) : resolve(ATTACHMENTS_DIR, filePath);
  const relativePath = relative(ATTACHMENTS_DIR, absPath);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(
      `file_path must point to a file inside workspace/attachments/. Got: ${filePath}`
    );
  }
  return absPath;
}

const UPLOAD_FIELDS = "id, name, size, mimeType, webViewLink";

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
  description:
    "Upload a file to Google Drive. Supports both plain-text content and binary files (images, PDFs, videos, etc.). " +
    "Provide either `content` (text string) or `file_path` (path to a local binary file under workspace/attachments/), but not both.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "File name on Google Drive (e.g. 'report.pdf')",
      },
      content: {
        type: "string",
        description: "File content as plain text. Mutually exclusive with file_path.",
      },
      file_path: {
        type: "string",
        description:
          "Path to a local binary file to upload (relative to workspace/attachments/ or absolute). " +
          "Only files inside workspace/attachments/ are allowed. Mutually exclusive with content.",
      },
      mime_type: {
        type: "string",
        description:
          "MIME type of the file (e.g. 'image/png', 'application/pdf'). " +
          "If omitted, inferred from the file extension; defaults to application/octet-stream.",
      },
      folder_id: {
        type: "string",
        description: "Google Drive parent folder ID (optional).",
      },
    },
    required: ["name"],
  },
  execute: async (args) => {
    const { name, content, file_path, mime_type, folder_id } = args as {
      name: string;
      content?: string;
      file_path?: string;
      mime_type?: string;
      folder_id?: string;
    };

    // --- validation ---
    if (content != null && file_path != null) {
      return "Error: provide either `content` or `file_path`, not both.";
    }
    if (content == null && file_path == null) {
      return "Error: one of `content` or `file_path` is required.";
    }

    const drive = getDrive();
    const resolvedMime = mime_type || guessMime(name);

    let body: import("stream").Readable;

    if (file_path != null) {
      const absPath = resolveAttachmentPath(file_path);
      // Verify file exists
      try {
        if (!statSync(absPath).isFile()) {
          return `Error: file_path is not a regular file: ${absPath}`;
        }
      } catch {
        return `Error: file not found at ${absPath}`;
      }
      body = createReadStream(absPath);
    } else {
      const { Readable } = await import("node:stream");
      body = Readable.from(content!);
    }

    const res = await drive.files.create({
      requestBody: {
        name,
        ...(folder_id ? { parents: [folder_id] } : {}),
      },
      media: {
        mimeType: resolvedMime,
        body,
      },
      fields: UPLOAD_FIELDS,
    });

    const d = res.data;
    return [
      `File uploaded to Google Drive:`,
      `  id:          ${d.id}`,
      `  name:        ${d.name}`,
      `  size:        ${d.size ?? "unknown"} bytes`,
      `  mimeType:    ${d.mimeType}`,
      `  webViewLink: ${d.webViewLink ?? "N/A"}`,
    ].join("\n");
  },
};
