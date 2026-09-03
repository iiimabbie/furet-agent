import { collectAttachmentGarbage } from "../src/attachment-index.js";
import { closeDb } from "../src/db.js";

const apply = process.argv.includes("--apply");
const daysArg = process.argv.find(arg => arg.startsWith("--retention-days="));
const retentionDays = daysArg ? Number(daysArg.split("=", 2)[1]) : 30;
if (!Number.isFinite(retentionDays) || retentionDays < 1) throw new Error("--retention-days must be >= 1");
try {
  const report = collectAttachmentGarbage({ retentionDays, dryRun: !apply });
  console.log(JSON.stringify(report, null, 2));
  if (!apply) console.log("Dry run only. Re-run with --apply to delete listed orphan-class files.");
} finally { closeDb(); }
