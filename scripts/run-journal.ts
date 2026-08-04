import { Session } from "../src/session.ts";
import { ask } from "../src/agent.ts";
import { SESSION_SUMMARIZE_PROMPT, buildJournalPrompt } from "../src/prompt.ts";
import { stamp } from "../src/utils/time.ts";

const date = process.argv[2];
if (!date) {
  console.error("Usage: tsx scripts/run-journal.ts <YYYY-MM-DD>");
  process.exit(1);
}

function ts(): string {
  return stamp();
}

async function summarizeAndArchiveAll(): Promise<void> {
  const ids = Session.listActive();
  console.log(`Found ${ids.length} active sessions`);

  for (const id of ids) {
    const session = new Session(id);
    if (session.length === 0) {
      console.log(`  [skip] ${id} (empty)`);
      continue;
    }
    console.log(`  [summarize] ${id} (${session.length} msgs)...`);
    try {
      session.append({ role: "user", content: SESSION_SUMMARIZE_PROMPT, time: ts() });
      await ask(null, { session });
      session.archive();
      console.log(`  [archived] ${id}`);
    } catch (err) {
      console.error(`  [fail] ${id}:`, (err as Error).message);
      session.archive();
    }
  }
}

async function main(): Promise<void> {
  console.log(`=== Manual journal for ${date} ===\n`);
  console.log("Step 1: summarize & archive active sessions");
  await summarizeAndArchiveAll();

  console.log("\nStep 2: journal prompt (整理日記 + 更新 MEMORY.md)");
  const prompt = buildJournalPrompt(date);
  const response = await ask(prompt);
  console.log(`\n=== Result (${response.text.length} chars) ===`);
  console.log(response.text);
  console.log(`\nTools used: ${response.toolsUsed.map(t => t.tool).join(", ")}`);
  console.log(`Duration: ${response.durationMs}ms`);
  console.log(`Tokens: in=${response.usage.inputTokens}, out=${response.usage.outputTokens}`);
}

main().catch(err => {
  console.error("FAILED:", err);
  process.exit(1);
});
