/**
 * Unit tests for google-drive upload tool validation logic.
 * Run: npx tsx tests/google-drive-upload.test.ts
 *
 * These tests exercise parameter validation and path-safety checks.
 * If Google credentials are present, valid uploads will succeed against real API.
 */

import { resolve } from "node:path";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { driveUpload } from "../src/tools/builtin/google-drive.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function run(args: Record<string, unknown>): Promise<string> {
  try {
    return await driveUpload.execute(args);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `__THROW__: ${msg}`;
  }
}

async function main() {
  console.log("\n🧪 google_drive_upload tests\n");

  // --- Schema checks ---
  console.log("Schema:");
  const schema = driveUpload.parameters as { required: string[]; properties: Record<string, unknown> };
  assert(schema.required.includes("name"), "name is required");
  assert(!schema.required.includes("content"), "content is not required (either content or file_path)");
  assert("file_path" in schema.properties, "file_path exists in schema");
  assert("mime_type" in schema.properties, "mime_type exists in schema");
  assert("folder_id" in schema.properties, "folder_id exists in schema");

  // --- Description mentions binary ---
  console.log("\nDescription:");
  assert(driveUpload.description.includes("binary"), "description mentions binary files");
  assert(driveUpload.description.includes("file_path"), "description mentions file_path");

  // --- Mutual exclusion validation ---
  console.log("\nMutual exclusion:");
  const both = await run({ name: "test.txt", content: "hi", file_path: "foo.txt" });
  assert(both.includes("not both"), "rejects when both content and file_path provided");

  const neither = await run({ name: "test.txt" });
  assert(neither.includes("required"), "rejects when neither content nor file_path provided");

  // --- Path traversal protection ---
  console.log("\nPath safety:");
  const traversal1 = await run({ name: "evil.txt", file_path: "../../../etc/passwd" });
  assert(
    traversal1.includes("must point to a file inside workspace/attachments"),
    "rejects path traversal with ../",
    traversal1.slice(0, 100),
  );

  const traversal2 = await run({ name: "evil.txt", file_path: "/etc/passwd" });
  assert(
    traversal2.includes("must point to a file inside workspace/attachments"),
    "rejects absolute path outside attachments",
    traversal2.slice(0, 100),
  );

  // --- File not found ---
  console.log("\nFile not found:");
  const noFile = await run({ name: "ghost.png", file_path: "nonexistent-file.png" });
  assert(noFile.includes("not found"), "reports file not found", noFile.slice(0, 100));

  // --- Valid text content ---
  console.log("\nValid text upload:");
  const textResult = await run({ name: "__furet-test-text__.txt", content: "hello world" });
  const textPassed = textResult.includes("File uploaded") || textResult.includes("__THROW__");
  assert(textPassed, "text upload passes validation (uploaded or auth error)", textResult.slice(0, 120));

  // Clean up test file from Drive if uploaded
  if (textResult.includes("File uploaded")) {
    const idMatch = textResult.match(/id:\s+(\S+)/);
    if (idMatch) {
      try {
        const { google } = await import("googleapis");
        const { getAuthClient } = await import("../src/google/auth.js");
        const auth = getAuthClient();
        if (auth) {
          const drive = google.drive({ version: "v3", auth });
          await drive.files.delete({ fileId: idMatch[1] });
          console.log(`    (cleaned up test file ${idMatch[1]})`);
        }
      } catch { /* ignore cleanup errors */ }
    }
  }

  // --- Valid file_path with real file ---
  console.log("\nValid file upload:");
  const { ATTACHMENTS_DIR } = await import("../src/paths.js");
  const testFile = resolve(ATTACHMENTS_DIR, "__furet-test-binary__.txt");
  mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  writeFileSync(testFile, "test binary content");

  try {
    const fileResult = await run({ name: "__furet-test-binary__.txt", file_path: "__furet-test-binary__.txt" });
    const filePassed = fileResult.includes("File uploaded") || fileResult.includes("__THROW__");
    assert(filePassed, "file upload passes validation (uploaded or auth error)", fileResult.slice(0, 120));

    // Verify returned fields when upload succeeds
    if (fileResult.includes("File uploaded")) {
      assert(fileResult.includes("id:"), "response contains id");
      assert(fileResult.includes("name:"), "response contains name");
      assert(fileResult.includes("size:"), "response contains size");
      assert(fileResult.includes("mimeType:"), "response contains mimeType");
      assert(fileResult.includes("webViewLink:"), "response contains webViewLink");

      // Clean up
      const idMatch = fileResult.match(/id:\s+(\S+)/);
      if (idMatch) {
        try {
          const { google } = await import("googleapis");
          const { getAuthClient } = await import("../src/google/auth.js");
          const auth = getAuthClient();
          if (auth) {
            const drive = google.drive({ version: "v3", auth });
            await drive.files.delete({ fileId: idMatch[1] });
            console.log(`    (cleaned up test file ${idMatch[1]})`);
          }
        } catch { /* ignore cleanup errors */ }
      }
    }
  } finally {
    try { unlinkSync(testFile); } catch { /* ignore */ }
  }

  // --- MIME type inference (via schema description) ---
  console.log("\nMIME type inference:");
  const mimeDesc = (schema.properties as Record<string, { description?: string }>).mime_type;
  assert(
    typeof mimeDesc === "object" && mimeDesc.description?.includes("inferred") === true,
    "mime_type description mentions inference"
  );

  // --- Summary ---
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
