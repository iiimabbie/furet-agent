import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, WORKSPACE_DIR } from "./paths.js";
import { loadConfig } from "./config.js";
import { listSkillDirs, readSkillMeta } from "./skills.js";
import { nowWithZone } from "./utils/time.js";
import { wrapTag } from "./utils/tagged-file.js";
import { NO_REPLY_TOKEN } from "./utils/no-reply.js";
import { buildEmojiPromptSection } from "./emoji.js";
import { isOwnerUnconfigured } from "./onboarding.js";
import type { Message, TriggerSource } from "./types.js";
import { buildPeoplePromptSection, type PeopleVisibilityPolicy } from "./people-context.js";
import type { LlmProfile } from "./llm/types.js";

// --- External prompt loading ---

const ONBOARDING_HEADING = "## Onboarding Protocol";

/**
 * Drop the onboarding protocol once the workspace is configured.
 *
 * AGENT.md is loaded whole into every prompt, while the protocol can only ever fire when
 * OWNER.md still holds template placeholders. Left in, it would spend tokens on every turn
 * for the rest of the workspace's life on instructions that can never apply again. Removing
 * it here rather than from the file keeps workspace AGENT.md in sync with the template.
 */
function stripOnboardingProtocol(instructions: string): string {
  const lines = instructions.split("\n");
  const start = lines.findIndex(line => line.trim() === ONBOARDING_HEADING);
  if (start === -1) return instructions;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) { end = i; break; }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

function loadAgentInstructions(ownerConfigured: boolean): string {
  try {
    const raw = readFileSync(resolve(WORKSPACE_DIR, "AGENT.md"), "utf-8")
      .replace(/\{\{ROOT\}\}/g, ROOT);
    return ownerConfigured ? stripOnboardingProtocol(raw) : raw;
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
  // JOURNAL.md is user-owned and only seeded on install, so existing workspaces may
  // still have the old raw-session instruction. This code-owned policy keeps the
  // token-saving transcript projection active without overwriting user customizations.
  const transcriptPolicy = `

### Journal transcript policy (system requirement)
For Step 1, call \`journal_transcript_by_date\` for ${date}, not \`sessions_by_date\`. It is a clean projection that removes tool calls, tool results, harness bookkeeping, and transport metadata. The raw tool is for debugging only.`;
  return template.replace(/\{\{DATE\}\}/g, date) + transcriptPolicy;
}

/**
 * 觸發當下的權威本地日期時間區塊，給 cron / reminder 的 user prompt 開頭用。
 *
 * cron / reminder 這類主動觸發常在接近午夜、或上游脈絡帶著舊日期時執行；
 * 觀察到即使主機、config timezone、工具回傳資料都是正確的當日，模型仍可能忽略
 * system prompt 裡的 `Current datetime`，把「今天」判成前一天，或把工具回傳的
 * 當日資料誤當成未來。這裡在每次觸發當下用 `nowWithZone()` 產生明確、權威的
 * 本地時間放進 user prompt 最前面，並明確要求：忽略任何衝突日期、不要把工具
 * 回傳的當日資料視為未來。放在 user prompt（而非 system prompt）是因為要壓過
 * 上游脈絡帶進來的日期，越靠近 messages 越不會被中間大量指令稀釋。
 */
export function authoritativeNowBlock(now: string = nowWithZone()): string {
  return (
    `[System] AUTHORITATIVE CURRENT LOCAL DATETIME: ${now}. ` +
    `This is the single source of truth for what "today" and "now" are, computed at the moment this task fired. ` +
    `Ignore and override any other date implied by prior context, cached reasoning, or upstream messages if it conflicts with this. ` +
    `Data returned by tools that is dated today (memory files, calendar, tasks, etc.) is CURRENT — do NOT treat today's data as belonging to the future or to a later day.\n\n`
  );
}

/**
 * Non-secret request-scoped model identity exposed to the model itself.
 *
 * The profile is already resolved and frozen by ask() before this is rendered, so this block
 * reports the exact session/request route in use rather than the mutable global default.
 */
export function buildLlmContext(profile: LlmProfile): string {
  return `<llm-context>
Profile: ${JSON.stringify(profile.name)}
Protocol: ${JSON.stringify(profile.protocol)}
Model: ${JSON.stringify(profile.model)}
Reasoning effort: ${JSON.stringify(profile.reasoningEffort)}
</llm-context>`;
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
 * Code-owned response protocol. Unlike workspace/AGENT.md, this cannot disappear when a user
 * trims or replaces their editable agent instructions. Keep only behavior coupled directly to
 * runtime output handling here; personality and general work style still belong in workspace files.
 */
function buildRuntimePolicy(trigger: TriggerSource): string {
  if (trigger !== "discord-owner" && trigger !== "discord-other") return "";

  return `<runtime-policy>
For every Discord-triggered turn, independently choose the lightest appropriate interaction: a text reply; an emoji reaction plus text; an emoji reaction only; or no interaction.

A substantive direct question or request normally requires a text reply. Never use silence to avoid substantive work. A Discord mention is transport/routing metadata, not by itself evidence that text is required: many channel turns reach the agent through mentions, including acknowledgements, bot chatter, and messages where a reaction or silence is sufficient. In DMs, still judge the message by substantive intent rather than replying merely because it is a DM. When a reaction fully communicates acknowledgement, amusement, or agreement, prefer calling discord_react without adding redundant text.

If no text should be sent — whether after reacting or with no interaction — the final response must be exactly ${NO_REPLY_TOKEN} and nothing else. This is an internal control token intercepted by Discord output handling; never append it to user-facing text or explain it to the user.

Messages prefixed with [context] are background chatter. Never send a text reply to them. You may react only when genuinely appropriate, then finish with ${NO_REPLY_TOKEN}; otherwise return ${NO_REPLY_TOKEN} directly.
</runtime-policy>`;
}

/**
 * PEOPLE.md 會隨著認識的人變多而長大，不適合無條件塞進每一次請求。
 *
 * 小的時候直接內嵌——成本幾十個 token，換到稱謂和權限一定正確；
 * 超過門檻就只留一行指標，讓 agent 需要時自己 `read_file`。
 * 門檻由 `config.prompt.peopleInlineLimit` 控制，0 = 永不內嵌。
 */
/**
 * Application Emoji 清單只在會輸出到 Discord 的 turn 注入：一般 Discord 對話，
 * 以及可能推播到 Discord channel 的 cron / reminder。CLI / journal 不注入，避免白付 token。無可用 emoji 時 buildEmojiPromptSection() 回空字串，不加空區塊。
 */
function buildEmojiSection(trigger: TriggerSource): string {
  if (!["discord-owner", "discord-other", "cron", "reminder"].includes(trigger)) return "";
  return buildEmojiPromptSection();
}

export interface PeopleContextRequest {
  currentText: string;
  messages: Message[];
  visibility: PeopleVisibilityPolicy;
  currentUserId?: string;
  ownerId?: string;
}

function buildPeopleSection(trigger: TriggerSource, request?: PeopleContextRequest): string {
  const people = loadWorkspaceFile("PEOPLE.md");
  if (!people) return "";

  const promptConfig = loadConfig().prompt;
  const limit = promptConfig.peopleInlineLimit;
  if (limit > 0 && people.length <= limit) return section(people, "people");

  const relevant = buildPeoplePromptSection(
    people,
    limit,
    promptConfig.relevantPeople.enabled,
    request,
    promptConfig.relevantPeople,
  );
  if (relevant) {
    return `${relevant}

<people-index>
Only people relevant to this turn were included above. The complete PEOPLE.md (${people.length} chars) remains available through read_file when needed.
</people-index>`;
  }

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
 *
 * `toolIndex`（`<tool-index>`）由 registry metadata 動態產生、agent.ts 依 exposure
 * feature flag 決定要不要傳進來。它放在 skills 之後、runtime context（datetime /
 * channel）之前，跟「你會什麼」歸在一起；persona anchor 仍留在最後一段。
 */
export interface BuildSystemPromptOptions {
  extra?: string;
  recalled?: string;
  toolIndex?: string;
  trigger?: TriggerSource;
  peopleContext?: PeopleContextRequest;
}

export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
  const { extra, recalled, toolIndex, trigger = "unknown", peopleContext } = options;
  const persona = loadWorkspaceFile("SOUL.md");

  const skills = loadSkills();
  const skillsSection = section(
    skills.map(s => `- **${s.name}**: ${s.description} → \`${s.path}\``).join("\n"),
    "skills",
  );

  // A missing or placeholder-bearing OWNER.md means setup is unfinished, so the onboarding
  // protocol must stay in the instructions. Read the file once and share it with both slots.
  const owner = loadWorkspaceFile("OWNER.md");
  const ownerConfigured = owner.trim().length > 0 && !isOwnerUnconfigured(owner);

  const parts = [
    section(persona, "persona"),                       // 你是誰——放在操作規範後面會被淹沒
    section(loadAgentInstructions(ownerConfigured), "agent-instructions"),  // 你怎麼做事
    section(owner, "owner"),                           // 你為誰服務——永遠內嵌，見下
    section(loadWorkspaceFile("MEMORY.md"), "memory"), // ┐
    buildPeopleSection(trigger, peopleContext),                              // ├ 你知道什麼（太大時 people 退化成指標）
    section(recalled ?? "", "recalled-memories"),      // ┘
    skillsSection,                                     // 你會什麼（直接暴露的技能）
    (toolIndex ?? "").trim(),                           // 你還會什麼（tool_catalog 可達的能力群）
    buildRuntimePolicy(trigger),                       // 程式耦合的輸出協定（不可由 workspace 精簡掉）
    buildEmojiSection(trigger),                        // 可用的 Application Emoji 清單（無 emoji 時為空）
    `Current datetime: ${nowWithZone()}`,              // ┐ 你現在在哪、什麼時候
    extra,                                             // ┘ channel / session 的 runtime context
    persona ? PERSONA_ANCHOR : "",                     // 錨定，最後一段
  ];

  // 先 trim 再濾：workspace 的 md 檔尾端自帶換行，不修掉的話區塊之間會出現三連換行
  return parts.map(p => p?.trim()).filter(Boolean).join("\n\n");
}
