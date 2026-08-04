import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { ROOT, WORKSPACE_DIR, SKILLS_DIR } from "./paths.js";
import { loadConfig } from "./config.js";
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

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  try {
    const meta = parse(match[1]) as Record<string, unknown>;
    const desc = typeof meta.description === "string" ? meta.description.trim().split("\n")[0] : undefined;
    return { name: meta.name as string | undefined, description: desc };
  } catch { return {}; }
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

export function buildSystemPrompt(extra?: string): string {
  const date = `Current datetime: ${nowWithZone()}`;
  const persona = loadWorkspaceFile("SOUL.md");
  const memory = loadWorkspaceFile("MEMORY.md");
  const people = loadWorkspaceFile("PEOPLE.md");

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
    people,         // AGENT.md 明確引用 PEOPLE.md（稱謂、權限），沒載入的話那些指令沒有依據
    skillsSection,
    persona ? PERSONA_ANCHOR : "",
  ];

  return parts.filter(Boolean).join("\n\n");
}
