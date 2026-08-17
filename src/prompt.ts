import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, WORKSPACE_DIR } from "./paths.js";
import { loadConfig } from "./config.js";
import { listSkillDirs, readSkillMeta } from "./skills.js";
import { nowWithZone } from "./utils/time.js";
import { wrapTag } from "./utils/tagged-file.js";

// --- External prompt loading ---

function loadAgentInstructions(): string {
  try {
    const raw = readFileSync(resolve(WORKSPACE_DIR, "AGENT.md"), "utf-8");
    return raw.replace(/\{\{ROOT\}\}/g, ROOT);
  } catch {
    return "You are an autonomous personal assistant agent.";
  }
}

/**
 * 取出 JOURNAL.md 裡某個 `## 標題` 到下一個 `## ` 之間的內容。
 *
 * 逐行掃描而非 regex：`m` flag 下的 `$` 會匹配每一行的結尾，
 * `(?=^## |$)` 這類邊界配上非貪婪量詞會在第一行就停住。
 */
function loadJournalSection(section: string): string {
  try {
    const content = readFileSync(resolve(WORKSPACE_DIR, "JOURNAL.md"), "utf-8");
    const lines = content.split("\n");
    const start = lines.findIndex(l => l.trim() === `## ${section}`);
    if (start === -1) return "";
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ")) { end = i; break; }
    }
    return lines.slice(start + 1, end).join("\n").trim();
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
 * 套上區塊標籤。標籤一律由這裡決定，不倚賴檔案內容自帶——
 * `wrapTag` 是冪等的，檔案已經有就不重複包，掉了就補上，
 * 不會發生「檔案裡的標籤被改掉，prompt 就靜默少一層區塊邊界」。
 */
function section(body: string, tag: string): string {
  return body.trim() ? wrapTag(body, tag) : "";
}

/**
 * 結尾的人格提醒。
 *
 * persona 只有一兩百字，而 AGENT.md 的操作規範動輒好幾千字——光靠開頭那一段，
 * 語氣會被中間大量的「高效助理」指令蓋過去。結尾是注意力另一個高點，
 * 在這裡把語氣的最終依據指回 <persona>。
 */
const PERSONA_ANCHOR = `<persona-reminder>
Stay in character as defined in <persona> above. Your voice — tone, register, how much you say — comes from there. What to call people does not: use exactly what <owner> and PEOPLE.md specify, even when the persona reads as if it implies another form of address. The operational rules govern what you do and how you structure it, never how you sound.
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
  if (limit > 0 && people.length <= limit) return section(people, "people");

  return `<people-index>
PEOPLE.md (${people.length} chars) is not inlined in this prompt.
Read \`workspace/PEOPLE.md\` with read_file when you need someone's identity, title, or permissions — do this before addressing an unfamiliar user or performing a permission-sensitive action.
</people-index>`;
}

/**
 * 組 system prompt。順序照語意分組：
 * 你是誰 → 怎麼做事 → 知道什麼 → 會什麼 → 現在在哪 → （接著就是對話）。
 *
 * 三塊記憶（長期、人物、召回）相鄰，runtime context（時間、頻道）緊貼 messages，
 * persona 的錨定留在最後一段。
 *
 * `<owner>` 刻意不套 PEOPLE.md 那種大小門檻：稱呼與權限判定每一輪都要用得到，
 * 退化成「需要時自己 read_file」等於允許它在某些輪次缺席。它只放不會過期的身分資訊，
 * 本來就不該長到需要設限——會長大的是 PEOPLE.md 和 MEMORY.md。
 */
export function buildSystemPrompt(extra?: string, recalled?: string): string {
  const persona = loadWorkspaceFile("SOUL.md");

  const skills = loadSkills();
  const skillsSection = section(
    skills.map(s => `- **${s.name}**: ${s.description} → \`${s.path}\``).join("\n"),
    "skills",
  );

  const parts = [
    section(persona, "persona"),                       // 你是誰——放在操作規範後面會被淹沒
    section(loadAgentInstructions(), "agent-instructions"),  // 你怎麼做事
    section(loadWorkspaceFile("OWNER.md"), "owner"),   // 你為誰服務——永遠內嵌，見下
    section(loadWorkspaceFile("MEMORY.md"), "memory"), // ┐
    buildPeopleSection(),                              // ├ 你知道什麼（太大時 people 退化成指標）
    section(recalled ?? "", "recalled-memories"),      // ┘
    skillsSection,                                     // 你會什麼
    `Current datetime: ${nowWithZone()}`,              // ┐ 你現在在哪、什麼時候
    extra,                                             // ┘ channel / session 的 runtime context
    persona ? PERSONA_ANCHOR : "",                     // 錨定，最後一段
  ];

  // 先 trim 再濾：workspace 的 md 檔尾端自帶換行，不修掉的話區塊之間會出現三連換行
  return parts.map(p => p?.trim()).filter(Boolean).join("\n\n");
}
