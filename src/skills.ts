import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { SKILLS_DIR } from "./paths.js";

export interface SkillMeta {
  name?: string;
  description?: string;
}

/** 讀 SKILL.md 開頭的 YAML frontmatter。description 只取第一行。 */
export function parseSkillFrontmatter(content: string): SkillMeta {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  try {
    const meta = parse(match[1]) as Record<string, unknown>;
    const desc = typeof meta.description === "string" ? meta.description.trim().split("\n")[0] : undefined;
    return { name: meta.name as string | undefined, description: desc };
  } catch { return {}; }
}

/** workspace/skills/ 底下的目錄名。目錄不存在時回空陣列。 */
export function listSkillDirs(): string[] {
  try {
    return readdirSync(SKILLS_DIR).filter(d => {
      try { return statSync(resolve(SKILLS_DIR, d)).isDirectory(); } catch { return false; }
    });
  } catch {
    return [];
  }
}

/** 讀某個 skill 目錄的 SKILL.md metadata。讀不到回 null。 */
export function readSkillMeta(dir: string): SkillMeta | null {
  try {
    return parseSkillFrontmatter(readFileSync(resolve(SKILLS_DIR, dir, "SKILL.md"), "utf-8"));
  } catch {
    return null;
  }
}
