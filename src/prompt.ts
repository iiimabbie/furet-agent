import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, WORKSPACE_DIR, SKILLS_DIR } from "./paths.js";
import { loadConfig } from "./config.js";

// --- External prompt loading ---

/** Load core agent instructions from AGENT.md */
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

/** Core system prompt builder - combines identity, memory, and skills */
export function buildSystemPrompt(extra?: string): string {
  const now = new Date();
  const dateStr = `Current datetime: ${now.toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).replace("T", " ")} (Asia/Taipei)`;
  
  const persona = loadWorkspaceFile("SOUL.md");
  const memory = loadWorkspaceFile("MEMORY.md");
  const people = loadWorkspaceFile("PEOPLE.md");
  const instructions = loadAgentInstructions();

  const sections: string[] = [
    instructions,
    dateStr,
    persona ? `## Persona\n${persona}` : "",
    memory ? `## Long-term Memory\n${memory}` : "",
    people ? `## People Memory\n${people}` : "",
  ].filter(Boolean);

  const skills = loadSkills();
  if (skills.length > 0) {
    sections.push(`## Active Skills\n${skills.map(s => `- **${s.name}**: ${s.description} → \`${s.path}\``).join("\n")}`);
  }

  if (extra) {
    sections.push(extra);
  }

  return sections.join("\n\n");
}
