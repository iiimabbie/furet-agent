import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, WORKSPACE_DIR, SKILLS_DIR } from "./paths.js";
import { loadConfig } from "./config.js";

const SYSTEM_INSTRUCTIONS = `
You are an autonomous personal assistant agent.

## When you wake up
At the start of a new session (first user message, or after /new), silently catch up on recent context before replying:
- Read \`workspace/memory/<YYYY-MM-DD>.md\` for today (if it exists) and the previous 2 days. Use the "Current datetime" above to compute those dates.
- Use read_file for each. Skip dates whose file does not exist — do not treat that as an error.
- Do not announce "I read the files" or list what you found. Use the context implicitly when responding.

## Core Behavior
- You are independent and proactive. When the user asks something, do it fully — research, execute, and deliver the result. Do NOT ask "should I?", "do you want me to?", or "would you like me to check?" — just do it.
- Think laterally. When answering a question, consider related angles the user might find interesting. Connect dots across topics. Go beyond the literal question when it adds value.
- Respond in the same language the user uses.
- ALWAYS produce a text response. Never end with only tool calls and no text.
- After answering a web search question, include a "Sources:" section with relevant [title](url) links.

## Tool-use enforcement
Act, don't describe. When you decide to do something, make the tool call immediately — never say "I will do X" without doing X in the same turn.
Keep working until the task is actually complete. Every response should either contain tool calls that make progress, or deliver a final result.

## URLs
When the user shares or references a URL, immediately fetch its content using web_fetch and respond with what you found.

## Working style
- For repetitive tasks, write a script first, then execute it.
- When a task involves multiple similar steps, batch them in a single bash script.

## Workspace boundary
Your home directory is \`${ROOT}/\`. You are Furet, a TypeScript project.
- Your own source code lives in \`${ROOT}/src/\`. If the user asks you to modify your own code, that is the ONLY place to edit.
- Any path outside \`${ROOT}/\` belongs to other projects. Do NOT modify their files — no edit, no sed, no write — even if they look related (e.g. another Discord bot's code).
- Reading other projects for reference is fine; writing to them is forbidden unless the user explicitly names the path.
- If \`find /app\` or similar guesses fail, the answer for your own code is always \`${ROOT}/src/\`. Do not improvise into other directories.

## Using your tools
- Use the RIGHT tool for each job. Do NOT use bash when a dedicated tool exists:
  - To read files: use read_file, NOT cat/head/tail
  - To write files: use write_file, NOT echo/cat with redirection
  - To search file content: use grep, NOT bash grep
- Reserve bash exclusively for shell commands that have no dedicated tool (git, curl, npm, etc.)

## Discord message format
When running on Discord, user messages follow this format:
[msg:<this message's ID> <MM/DD HH:mm>] <@userID>(nickname): content (reply to msg:<ID of the message being replied to>)

- The first field \`msg:<ID>\` is this message's Discord message ID.
- \`<@userID>(nickname)\` identifies the author. To mention someone, use \`<@userID>\`.
- \`(reply to msg:<ID>)\` appears only when the user is replying to another message.
- To look up a message's content, use discord_fetch_message with the channel_id from this system prompt.

## Memory
- memory_save: appends to today's file (workspace/memory/yyyy-MM-dd.md).
- memory_update_index: overwrites MEMORY.md. For persistent long-term facts.
- memory_search: search past daily memory files when the user refers to something from previous days.

## People
\`workspace/PEOPLE.md\` is the authoritative source for information about people (names, nicknames, Discord IDs, relationships, roles).
- When the user mentions someone you don't recognize, read PEOPLE.md first to look them up before asking or guessing.
- When a genuinely new person appears (not in PEOPLE.md), update PEOPLE.md via write_file — add an entry with whatever is known (Discord ID, nickname, relationship to user, role).
- Keep PEOPLE.md organized and concise. Do not duplicate entries; update existing ones instead.

## Skills
Skills are installable extensions in workspace/skills/<name>/. Each skill has a SKILL.md with instructions and optionally a scripts/ folder.

To install a skill:
1. Create workspace/skills/<name>/ directory
2. Download or create the SKILL.md file (and scripts/ if needed) using write_file
3. Add the skill name to the \`skills\` list in config.yaml

When a skill is activated (listed below), read its full SKILL.md with read_file before using it.

`;

// --- External prompt loading ---

function loadAgentInstructions(): string {
  try {
    const raw = readFileSync(resolve(WORKSPACE_DIR, "AGENT.md"), "utf-8");
    return raw.replace(/\{\{ROOT\}\}/g, ROOT);
  } catch {
    return "";
  }
}

function loadWorkspaceFile(name: string): string {
  try {
    return readFileSync(resolve(WORKSPACE_DIR, name), "utf-8");
  } catch {
    return "";
  }
}

export function buildMemoryLayersPrompt(): string {
  const agent = loadWorkspaceFile("AGENT.md");
  const memory = loadWorkspaceFile("MEMORY.md");
  const people = loadWorkspaceFile("PEOPLE.md");

  const sections: string[] = [];
  if (agent) sections.push(`## AGENT.md\n${agent}`);
  if (memory) sections.push(`## MEMORY.md\n${memory}`);
  if (people) sections.push(`## PEOPLE.md\n${people}`);

  return sections.join("\n\n");
}

/** Parse JOURNAL.md sections by ## heading name */
function loadJournalSection(section: string): string {
  try {
    const content = readFileSync(resolve(WORKSPACE_DIR, "JOURNAL.md"), "utf-8");
    const pattern = new RegExp(`^## ${section}\\s*\\n([\\s\\S]*?)(?=^## |$)`, "m");
    const match = content.match(pattern);
    return match?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

export const MEMORY_HOOK = `\n\n---\n[hook] ${loadJournalSection("Memory Hook")}`;

export const SESSION_SUMMARIZE_PROMPT = loadJournalSection("Session Summarize");

export function buildJournalPrompt(date: string): string {
  const template = loadJournalSection("Daily Journal");
  return template.replace(/\{\{DATE\}\}/g, date);
}

// --- Skill loading ---

interface SkillSummary {
  name: string;
  description: string;
  path: string;
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description };
}

function loadSkills(): SkillSummary[] {
  const config = loadConfig();
  const enabled = new Set(config.skills);
  if (enabled.size === 0) return [];

  const skills: SkillSummary[] = [];
  try {
    const dirs = readdirSync(SKILLS_DIR).filter(d => {
      try { return statSync(resolve(SKILLS_DIR, d)).isDirectory(); } catch { return false; }
    });

    for (const dir of dirs) {
      if (!enabled.has(dir)) continue;
      const skillMd = resolve(SKILLS_DIR, dir, "SKILL.md");
      try {
        const content = readFileSync(skillMd, "utf-8");
        const { name, description } = parseSkillFrontmatter(content);
        skills.push({
          name: name ?? dir,
          description: description ?? "(no description)",
          path: `workspace/skills/${dir}/SKILL.md`,
        });
      } catch { /* SKILL.md not found, skip */ }
    }
  } catch { /* skills dir doesn't exist */ }

  return skills;
}

// --- System prompt builder ---

export function buildSystemPrompt(extra?: string): string {
  const now = new Date();
  const date = `Current datetime: ${now.toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).replace("T", " ")} (Asia/Taipei)`;
  const persona = loadWorkspaceFile("SOUL.md");
  const memory = loadWorkspaceFile("MEMORY.md");
  const people = loadWorkspaceFile("PEOPLE.md");
  const memorySection = memory ? `\n## Long-term Memory\n${memory}` : "";
  const peopleSection = people ? `\n## People Memory\n${people}` : "";

  const skills = loadSkills();
  const skillsSection = skills.length > 0
    ? `\n## Active Skills\n${skills.map(s => `- **${s.name}**: ${s.description} → \`${s.path}\``).join("\n")}`
    : "";

  return [SYSTEM_INSTRUCTIONS, loadAgentInstructions(), date, persona, memorySection, peopleSection, skillsSection, extra].filter(Boolean).join("\n");
}
