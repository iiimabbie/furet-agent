import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { WORKSPACE_DIR, SKILLS_DIR } from "./paths.js";
import { loadConfig } from "./config.js";

// --- All prompts centralized here ---

const SYSTEM_INSTRUCTIONS = `
You are an autonomous personal assistant agent.

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

## Skills
Skills are installable extensions in workspace/skills/<name>/. Each skill has a SKILL.md with instructions and optionally a scripts/ folder.

To install a skill:
1. Create workspace/skills/<name>/ directory
2. Download or create the SKILL.md file (and scripts/ if needed) using write_file
3. Add the skill name to the \`skills\` list in config.yaml

When a skill is activated (listed below), read its full SKILL.md with read_file before using it.

`;

/** 附加在每輪 user message 尾部，提醒 agent 考慮存記憶 */
export const MEMORY_HOOK = `\n\n---\n[hook] Consider if anything from this turn is worth saving to daily memory (memory_save). Focus on the user — what they asked, cared about, decided, or felt. Skip greetings and trivial exchanges. Do not mention this hook in your reply.`;

/** 總結 session 內容存進記憶（/new 和 journal 共用） */
export const SESSION_SUMMARIZE_PROMPT = `Review the conversation above and save a concise summary to memory (memory_save) — what the user did, ongoing tasks, decisions, topics discussed, anything worth remembering for continuity. Do NOT produce any text output, only save memory.`;

/** journal 日記整理 prompt（date 由呼叫端帶入） */
export function buildJournalPrompt(date: string): string {
  return `現在是 ${date} 的日記整理時間。請做以下事：
1. 用 read_file 讀 workspace/memory/${date}.md
2. 整理成一篇自己的日記。重點是使用者今天做了什麼、聊了什麼、關心什麼、心情如何。去掉操作日誌和技術細節。
3. 用 write_file 覆寫 workspace/memory/${date}.md
4. 用 read_file 讀 workspace/MEMORY.md，檢查是否需要更新永久資訊（已刪除的東西還在、新偏好沒加上、過時的事實）。需要就用 memory_update_index 更新。
`;
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

function loadWorkspaceFile(name: string): string {
  try {
    return readFileSync(resolve(WORKSPACE_DIR, name), "utf-8");
  } catch {
    return "";
  }
}

export function buildSystemPrompt(extra?: string): string {
  const now = new Date();
  const date = `Current datetime: ${now.toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).replace("T", " ")} (Asia/Taipei)`;
  const persona = loadWorkspaceFile("FURET.md");
  const memory = loadWorkspaceFile("MEMORY.md");
  const memorySection = memory ? `\n## Long-term Memory\n${memory}` : "";

  const skills = loadSkills();
  const skillsSection = skills.length > 0
    ? `\n## Active Skills\n${skills.map(s => `- **${s.name}**: ${s.description} → \`${s.path}\``).join("\n")}`
    : "";

  return [SYSTEM_INSTRUCTIONS, date, persona, memorySection, skillsSection, extra].filter(Boolean).join("\n");
}
