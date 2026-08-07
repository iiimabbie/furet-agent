import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, WORKSPACE_DIR } from "./paths.js";
import { loadConfig } from "./config.js";
import { listSkillDirs, readSkillMeta } from "./skills.js";
import { nowWithZone } from "./utils/time.js";

// --- External prompt loading ---

function loadAgentInstructions(): string {
  try {
    const raw = readFileSync(resolve(WORKSPACE_DIR, "AGENT.md"), "utf-8");
    return raw.replace(/\{\{ROOT\}\}/g, ROOT);
  } catch {
    return "You are an autonomous personal assistant agent.";
  }
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

export const MEMORY_HOOK = `\n\n<system-hook>\n${loadJournalSection("Memory Hook")}\n</system-hook>`;

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

function loadSkills(): SkillSummary[] {
  const config = loadConfig();
  const enabled = new Set(config.skills);
  if (enabled.size === 0) return [];

  const skills: SkillSummary[] = [];
  for (const dir of listSkillDirs()) {
    if (!enabled.has(dir)) continue;
    const meta = readSkillMeta(dir);
    if (!meta) continue;  // SKILL.md 讀不到就跳過
    skills.push({
      name: meta.name ?? dir,
      description: meta.description ?? "(no description)",
      path: `workspace/skills/${dir}/SKILL.md`,
    });
  }

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

/**
 * 結尾的人格提醒。
 *
 * persona 只有一兩百字，而 AGENT.md 的操作規範動輒好幾千字——光靠開頭那一段，
 * 語氣會被中間大量的「高效助理」指令蓋過去。結尾是注意力另一個高點，
 * 在這裡把語氣的最終依據指回 <persona>。
 */
const PERSONA_ANCHOR = `<persona-reminder>
Stay in character as defined in <persona> above. Your voice — tone, how you address people, how much you say — comes from there. The operational rules govern what you do and how you structure it, never how you sound.
</persona-reminder>`;

/**
 * PEOPLE.md 會隨著認識的人變多而長大，不適合無條件塞進每一次請求。
 *
 * 小的時候直接內嵌——成本幾十個 token，換到稱謂和權限一定正確；
 * 超過門檻就只留一行指標，讓 agent 需要時自己 `read_file`。
 * 門檻由 `config.prompt.peopleInlineLimit` 控制，0 = 永不內嵌。
 */
function buildPeopleSection(): string {
  const people = loadWorkspaceFile("PEOPLE.md");
  if (!people) return "";

  const limit = loadConfig().prompt.peopleInlineLimit;
  if (limit > 0 && people.length <= limit) return people;

  return `<people-index>
PEOPLE.md (${people.length} chars) is not inlined in this prompt.
Read \`workspace/PEOPLE.md\` with read_file when you need someone's identity, title, or permissions — do this before addressing an unfamiliar user or performing a permission-sensitive action.
</people-index>`;
}

export function buildSystemPrompt(extra?: string): string {
  const date = `Current datetime: ${nowWithZone()}`;
  const persona = loadWorkspaceFile("SOUL.md");
  const memory = loadWorkspaceFile("MEMORY.md");
  const people = buildPeopleSection();

  const skills = loadSkills();
  const skillsSection = skills.length > 0
    ? skills.map(s => `- **${s.name}**: ${s.description} → \`${s.path}\``).join("\n")
    : "";

  const parts = [
    persona,        // 先講「你是誰」，再講「怎麼做事」——放在操作規範後面會被淹沒
    loadAgentInstructions(),
    extra,          // channel context / session-specific runtime info — injected early for visibility
    date,
    memory,
    people,         // AGENT.md 明確引用 PEOPLE.md（稱謂、權限）；太大時退化成指標
    skillsSection,
    persona ? PERSONA_ANCHOR : "",
  ];

  return parts.filter(Boolean).join("\n\n");
}
