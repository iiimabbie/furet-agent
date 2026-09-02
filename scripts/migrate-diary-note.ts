import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";

interface Options {
  workspace: string;
  scanRoots: string[];
  apply: boolean;
  backupDir?: string;
}

interface FileChange {
  path: string;
  changed: boolean;
  replacements: number;
}

interface LegacyReference {
  path: string;
  line: number;
  text: string;
}

const LEGACY_NAME = "memory_save";
const CANONICAL_NAME = "diary_note";
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ts", ".js", ".mjs", ".cjs",
]);
const SKIP_DIRS = new Set([
  ".git", ".trash", "attachments", "logs", "memory", "node_modules", "sessions",
]);

const AGENT_OLD = `- daily file (\`memory_save\`) — **what happened**: conversations, events, decisions, corrections, and
  social chatter used as diary source material. It may record that a durable fact was learned, but
  it never substitutes for updating the fact's canonical file.`;
const AGENT_NEW = `- daily file (\`diary_note\`) — **diary annotations**: explicit background, evidence-based
  in-the-moment reflections, cross-day links, and attachment/tool context the transcript cannot
  preserve. The transcript is the primary record; \`diary_note\` only supplements it.`;
const AGENT_FOLLOWUP_OLD = `When new information touches multiple categories, update the canonical destination first, then save
only the event/context to the daily file if it is diary-worthy. Never copy an owner profile fact into
MEMORY.md merely because it matters long-term.`;
const AGENT_FOLLOWUP_NEW = `When new information touches multiple categories, update the canonical destination first. Add a
daily annotation only when it contributes explicit or evidence-based context the transcript cannot
preserve. Never copy an owner profile fact into MEMORY.md merely because it matters long-term.`;

const JOURNAL_MEMORY_HOOK = `## Memory Hook

Check if anything from this turn is worth saving. If yes, save it — do not skip.

First classify the information by its canonical destination. A daily note may record the exchange,
but it does not replace updating the canonical file.

**OWNER.md — who the owner is** — update directly if:
- You learned or corrected a durable personal fact about the owner: identity, form of address,
  permissions, account identifiers, residences, work, relationships, or comparable profile data.
- Update the existing field in place and remove stale values. Do not preserve a correction history
  unless the history itself is meaningful. Preserve the \`<owner>\` wrapper and unrelated fields.
- Do not duplicate owner profile facts in MEMORY.md.

**people_add / people_update** (PEOPLE.md — everyone except the owner) — use if:
- Someone you have no entry for spoke in the channel → \`people_add\` with their Discord ID,
  display name, and how they talk. Do this on first encounter, without being asked.
- You learned something durable about someone already listed → \`people_update\`
  (how they want to be addressed, a preference, a correction, a relationship)

PEOPLE.md stores other people's profiles. Daily memory may still describe conversations or events
involving them; it must not be used as the authoritative copy of their profile.

**diary_note** (append annotation to daily file) — the session transcript already captures what
happened. Use \`diary_note\` only for what the transcript cannot preserve:
- Explicit background that was not captured in the text transcript
- Your own evidence-based in-the-moment reflections or second thoughts
- Cross-day context links ("this connects to what happened on YYYY-MM-DD")
- Attachment or tool-result context needed to understand the diary later

Do NOT use \`diary_note\` to log events, record conversations, or list what someone said — the
transcript has all of that. Do not save an inferred emotional state as fact unless the user made it
explicit or the evidence is recorded in the note.

**memory_add / memory_replace / memory_remove** (update MEMORY.md) — use only for long-lived
operating context that is not an owner or other-person profile:
- A new rule, preference, recurring workflow, ongoing plan, or durable world fact → add or expand
  the relevant section
- An existing fact became stale or wrong → update it
- A fact is no longer relevant → remove it
- MEMORY.md is near capacity → consolidate before adding; do not create overlapping sections

Atomic fact constraint: every saved fact must be self-contained.
- Replace all pronouns with specific names.
- Use absolute dates (YYYY-MM-DD), not relative ones.
- Include enough context to be meaningful in isolation.
  Bad: "He went to the doctor." → Good: "John visited Dr. Smith on 2026-04-21."

**Do NOT save to MEMORY.md**: owner profile facts, other people's profiles, issue/PR numbers, news
events, one-time links, or anything that will not matter in 30 days.

Skip bare greetings and things already recorded today. The transcript already preserves ordinary
conversation and community interaction; create a diary annotation only when it adds information the
transcript cannot preserve. Proceed without acknowledging this check in your reply.`;

const JOURNAL_SESSION_SUMMARIZE = `## Session Summarize

This session is about to be archived. Save any important context before it's gone.

Execute silently — output nothing. No confirmation, no summary, no acknowledgment. Only tool calls.

You already have the full session in context — do not read files.

Use the appropriate destination:
- update \`OWNER.md\` directly — new or corrected durable facts about the owner; preserve its wrapper
  and replace stale values instead of appending correction history
- \`diary_note\` — explicit context or evidence-based reflection the transcript cannot capture
- \`memory_add\` / \`memory_replace\` / \`memory_remove\` — long-lived operating context in MEMORY.md,
  excluding owner and other-person profiles
- \`people_add\` — anyone except the owner who appeared with no PEOPLE.md entry
- \`people_update\` — durable profile information learned about someone except the owner

Check the participants of this session against PEOPLE.md before finishing.

Two different bars — do not use the long-term bar to judge the daily file:
- \`diary_note\` (today's daily file): only annotations the transcript cannot capture — explicit
  background, evidence-based reflections, cross-day links, and attachment/tool context. Do not
  duplicate ordinary conversation or infer an unconfirmed emotional state.
- \`OWNER.md\`: durable owner profile facts go here regardless of whether they were learned today.
- \`memory_add\` / \`memory_replace\` / \`memory_remove\` (MEMORY.md = long-term): only non-profile
  context still relevant in 30+ days.

Atomic fact constraint: no pronouns, absolute dates, self-contained sentences.

Do NOT write owner profile facts, other-person profiles, issue/PR numbers, version-specific notes,
one-time links, or news events to MEMORY.md. Only non-profile context still relevant in 30+ days belongs there.

Skip if the transcript already preserves everything that matters. A chat about games, news, or
community activity remains available in the transcript and does not need a \`diary_note\` unless
there is meaningful context outside the transcript.`;

const JOURNAL_STEP_OLD = `   - Treat \`memory_save\` notes only as a **fact index and omission checklist**. They are raw
     capture, not an outline: do not preserve their wording, order, one-event-per-item shape,
     timestamps, or level of detail.`;
const JOURNAL_STEP_NEW = `   - Treat \`diary_note\` annotations as **supplementary colour**: explicit background,
     evidence-based reflections, cross-day links, and attachment/tool context that the transcript
     alone would not convey. They are not an outline or event log — do not let them shape the
     diary's structure or sequence.`;

function parseArgs(argv: string[]): Options {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const workspace = resolve(value("--workspace") || "workspace");
  const scanRoots = (value("--scan-roots") || `${workspace},config,skills,plugins`)
    .split(",")
    .map(item => resolve(item.trim()))
    .filter(Boolean);
  return {
    workspace,
    scanRoots,
    apply: argv.includes("--apply"),
    backupDir: value("--backup-dir") ? resolve(value("--backup-dir")!) : undefined,
  };
}

function replaceExactly(content: string, oldText: string, newText: string, label: string): { content: string; count: number } {
  const count = content.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one legacy block, found ${count}`);
  return { content: content.replace(oldText, newText), count };
}

function replaceSection(content: string, heading: string, nextHeading: string, replacement: string): { content: string; count: number } {
  const start = content.indexOf(heading);
  const end = content.indexOf(nextHeading, start + heading.length);
  if (start < 0 || end < 0) throw new Error(`${heading}: section boundary not found`);
  const current = content.slice(start, end).trimEnd();
  if (!current.includes(LEGACY_NAME)) throw new Error(`${heading}: legacy tool reference not found`);
  return { content: `${content.slice(0, start)}${replacement}\n\n${content.slice(end)}`, count: 1 };
}

function migrateAgent(content: string): { content: string; replacements: number } {
  if (!content.includes(LEGACY_NAME) && content.includes(CANONICAL_NAME)) return { content, replacements: 0 };
  const result = replaceExactly(content, AGENT_OLD, AGENT_NEW, "AGENT.md knowledge persistence");
  const followup = replaceExactly(result.content, AGENT_FOLLOWUP_OLD, AGENT_FOLLOWUP_NEW, "AGENT.md diary annotation guidance");
  if (followup.content.includes(LEGACY_NAME)) throw new Error("AGENT.md still contains memory_save after migration");
  return { content: followup.content, replacements: result.count + followup.count };
}

function migrateJournal(content: string): { content: string; replacements: number } {
  if (!content.includes(LEGACY_NAME) && content.includes(CANONICAL_NAME)) return { content, replacements: 0 };
  let next = replaceSection(content, "## Memory Hook", "## Session Summarize", JOURNAL_MEMORY_HOOK);
  let replacements = next.count;
  next = replaceSection(next.content, "## Session Summarize", "## Daily Journal", JOURNAL_SESSION_SUMMARIZE);
  replacements += next.count;
  const step = replaceExactly(next.content, JOURNAL_STEP_OLD, JOURNAL_STEP_NEW, "JOURNAL.md daily journal annotation guidance");
  replacements += step.count;
  let migrated = step.content.replaceAll("polished rewrite of `memory_save` entries", "polished rewrite of `diary_note` annotations");
  replacements++;
  if (migrated.includes(LEGACY_NAME)) throw new Error("JOURNAL.md still contains memory_save after migration");
  return { content: migrated, replacements };
}

function backup(path: string, workspace: string, backupDir: string): void {
  const destination = resolve(backupDir, relative(workspace, path));
  mkdirSync(resolve(destination, ".."), { recursive: true });
  copyFileSync(path, destination);
}

function migrateFile(path: string, kind: "agent" | "journal", options: Options): FileChange {
  if (!existsSync(path)) throw new Error(`Required file not found: ${path}`);
  const original = readFileSync(path, "utf8");
  const result = kind === "agent" ? migrateAgent(original) : migrateJournal(original);
  const changed = result.content !== original;
  if (changed && options.apply) {
    if (options.backupDir) backup(path, options.workspace, options.backupDir);
    const temporary = `${path}.diary-note-migration.tmp`;
    writeFileSync(temporary, result.content);
    renameSync(temporary, path);
  }
  return { path, changed, replacements: result.replacements };
}

function walk(path: string, output: string[]): void {
  if (!existsSync(path)) return;
  const stats = statSync(path);
  if (stats.isFile()) {
    if (TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || ["AGENT.md", "JOURNAL.md"].includes(basename(path))) output.push(path);
    return;
  }
  if (SKIP_DIRS.has(basename(path))) return;
  for (const entry of readdirSync(path)) walk(resolve(path, entry), output);
}

function scanLegacyReferences(roots: string[], overrides = new Map<string, string>()): LegacyReference[] {
  const files: string[] = [];
  for (const root of roots) walk(root, files);
  const references: LegacyReference[] = [];
  for (const path of [...new Set(files)].sort()) {
    const content = overrides.get(resolve(path)) ?? readFileSync(path, "utf8");
    content.split(/\r?\n/).forEach((line, index) => {
      if (line.includes(LEGACY_NAME)) references.push({ path, line: index + 1, text: line.trim().slice(0, 240) });
    });
  }
  return references;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const agentPath = resolve(options.workspace, "AGENT.md");
  const journalPath = resolve(options.workspace, "JOURNAL.md");
  const agentPreview = migrateAgent(readFileSync(agentPath, "utf8"));
  const journalPreview = migrateJournal(readFileSync(journalPath, "utf8"));
  const changes = [
    migrateFile(agentPath, "agent", options),
    migrateFile(journalPath, "journal", options),
  ];
  const projected = new Map<string, string>([
    [agentPath, agentPreview.content],
    [journalPath, journalPreview.content],
  ]);
  const references = scanLegacyReferences(options.scanRoots, options.apply ? new Map() : projected);
  const report = {
    mode: options.apply ? "apply" : "dry-run",
    workspace: options.workspace,
    changes,
    backupDir: options.backupDir,
    legacyReferences: references,
    ok: references.length === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  if (options.apply && references.length > 0) process.exitCode = 2;
}

main();
