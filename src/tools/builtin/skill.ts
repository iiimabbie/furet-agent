import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, readdirSync, statSync, cpSync } from "node:fs";
import { resolve, basename } from "node:path";
import { parse } from "yaml";
import { addSkill, removeSkill, loadConfig } from "../../config.js";
import { logger } from "../../logger.js";
import { SKILLS_DIR } from "../../paths.js";
import type { Tool } from "../../types.js";

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  try {
    const meta = parse(match[1]) as Record<string, unknown>;
    const desc = typeof meta.description === "string" ? meta.description.trim().split("\n")[0] : undefined;
    return { name: meta.name as string | undefined, description: desc };
  } catch { return {}; }
}

export const skillInstall: Tool = {
  name: "skill_install",
  description: "Install a skill from a git URL or local path. Copies into workspace/skills/ and registers it in config.yaml.",
  parameters: {
    type: "object",
    properties: {
      source: { type: "string", description: "Git URL (e.g. https://github.com/user/skill.git) or local directory path" },
      name: { type: "string", description: "Directory name for the skill (optional, defaults to repo/folder name)" },
    },
    required: ["source"],
  },
  execute: async (args) => {
    const { source, name } = args as { source: string; name?: string };
    const isLocal = existsSync(source) && statSync(source).isDirectory();
    const dirName = name ?? basename(source).replace(/\.git$/, "");
    const dest = resolve(SKILLS_DIR, dirName);
    logger.info({ source, dirName, isLocal }, "skill_install");

    if (existsSync(dest)) return `Error: ${dirName} already exists in workspace/skills/`;

    try {
      if (isLocal) {
        cpSync(source, dest, { recursive: true });
      } else {
        execSync(`git clone --depth 1 ${source} ${dest}`, { timeout: 30_000, stdio: "pipe" });
      }
    } catch (e) {
      return `Error: install failed — ${(e as Error).message}`;
    }

    // Read SKILL.md for confirmation
    const skillMd = resolve(dest, "SKILL.md");
    let desc = "(no SKILL.md found)";
    if (existsSync(skillMd)) {
      const content = readFileSync(skillMd, "utf-8");
      const meta = parseSkillFrontmatter(content);
      desc = meta.description ?? "(no description)";
    }

    addSkill(dirName);
    return `Installed ${dirName}: ${desc}`;
  },
};

export const skillUninstall: Tool = {
  name: "skill_uninstall",
  description: "Uninstall a skill. Removes it from config.yaml and deletes the skill directory.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill directory name to uninstall" },
    },
    required: ["name"],
  },
  execute: async (args) => {
    const { name } = args as { name: string };
    const dest = resolve(SKILLS_DIR, name);
    logger.info({ name }, "skill_uninstall");

    if (!existsSync(dest)) return `Error: skill ${name} not found`;

    removeSkill(name);
    rmSync(dest, { recursive: true, force: true });
    return `Uninstalled ${name}`;
  },
};

export const skillList: Tool = {
  name: "skill_list",
  description: "List all installed skills with their descriptions.",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    logger.info("skill_list");
    const config = loadConfig();
    const enabled = new Set(config.skills);

    try {
      const dirs = readdirSync(SKILLS_DIR).filter(d => {
        try { return statSync(resolve(SKILLS_DIR, d)).isDirectory(); } catch { return false; }
      });

      if (!dirs.length) return "No skills installed.";

      const lines: string[] = [];
      for (const dir of dirs) {
        const active = enabled.has(dir) ? "active" : "inactive";
        const skillMd = resolve(SKILLS_DIR, dir, "SKILL.md");
        let desc = "(no SKILL.md)";
        if (existsSync(skillMd)) {
          const content = readFileSync(skillMd, "utf-8");
          const meta = parseSkillFrontmatter(content);
          desc = meta.description ?? "(no description)";
        }
        lines.push(`${dir} [${active}]: ${desc}`);
      }
      return lines.join("\n");
    } catch {
      return "No skills directory found.";
    }
  },
};
