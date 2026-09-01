import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { addSkill, removeSkill, loadConfig } from "../../config.js";
import { logger } from "../../logger.js";
import { SKILLS_DIR, TRASH_DIR } from "../../paths.js";
import { listSkillDirs, parseSkillFrontmatter, readSkillMeta } from "../../skills.js";
import type { Tool } from "../../types.js";

const SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function defaultSkillName(source: string): string {
  const normalized = source.replace(/[\/]+$/, "");
  const tail = basename(normalized).replace(/\.git$/i, "");
  if (!tail) throw new Error("Cannot derive a skill name from the source; provide name explicitly");
  return tail;
}

function validateSkillName(name: string): string {
  const trimmed = name.trim();
  if (!SKILL_NAME_PATTERN.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new Error(`Invalid skill name ${JSON.stringify(name)}; use one safe directory segment`);
  }
  return trimmed;
}

function validateInstalledSkill(path: string): string {
  const skillFile = resolve(path, "SKILL.md");
  if (!existsSync(skillFile) || !statSync(skillFile).isFile()) {
    throw new Error("Installed source does not contain a SKILL.md file");
  }
  const meta = parseSkillFrontmatter(readFileSync(skillFile, "utf8"));
  return meta.description ?? "(no description)";
}

function moveSkillToTrash(path: string, name: string): string {
  mkdirSync(TRASH_DIR, { recursive: true });
  const destination = resolve(TRASH_DIR, `skill-${name}-${Date.now()}-${randomUUID().slice(0, 8)}`);
  renameSync(path, destination);
  return destination;
}

export const skillInstall: Tool = {
  name: "skill_install",
  description: "Install a skill from a git URL or local path. Copies it into workspace/skills/ and registers it in config.yaml as one rollback-safe operation.",
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
    const dirName = validateSkillName(name ?? defaultSkillName(source));
    const dest = resolve(SKILLS_DIR, dirName);
    const staged = resolve(SKILLS_DIR, `.install-${dirName}-${randomUUID()}`);
    const isLocal = existsSync(source) && statSync(source).isDirectory();
    logger.info({ source, dirName, isLocal }, "skill_install");

    mkdirSync(SKILLS_DIR, { recursive: true });
    if (existsSync(dest)) return `Error: ${dirName} already exists in workspace/skills/`;

    try {
      if (isLocal) {
        const localSource = realpathSync(resolve(source));
        const realSkillsDir = realpathSync(SKILLS_DIR);
        if (isInside(localSource, realSkillsDir)) {
          throw new Error("Local skill source cannot contain workspace/skills/ (recursive copy would occur)");
        }
        cpSync(localSource, staged, { recursive: true, errorOnExist: true });
      } else {
        if (source.startsWith("-")) throw new Error("Git source cannot begin with '-'");
        execFileSync("git", ["clone", "--depth", "1", "--", source, staged], {
          timeout: 30_000,
          stdio: "pipe",
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
      }

      const desc = validateInstalledSkill(staged);
      renameSync(staged, dest);
      try {
        addSkill(dirName);
      } catch (error) {
        moveSkillToTrash(dest, `${dirName}-install-rollback`);
        throw error;
      }
      return `Installed ${dirName}: ${desc}`;
    } catch (error) {
      if (existsSync(staged)) moveSkillToTrash(staged, `${dirName}-install-failed`);
      return `Error: install failed — ${(error as Error).message}`;
    }
  },
};

export const skillUninstall: Tool = {
  name: "skill_uninstall",
  description: "Uninstall a skill completely. Unregisters it from config.yaml and moves its whole workspace/skills/ directory to workspace/.trash/ with rollback on config failure.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill directory name to uninstall" },
    },
    required: ["name"],
  },
  execute: async (args) => {
    const dirName = validateSkillName((args as { name: string }).name);
    const dest = resolve(SKILLS_DIR, dirName);
    const registered = loadConfig().skills.includes(dirName);
    logger.info({ name: dirName, registered, directoryExists: existsSync(dest) }, "skill_uninstall");

    if (!registered && !existsSync(dest)) return `Error: skill ${dirName} is not installed`;

    let trashed: string | undefined;
    try {
      if (existsSync(dest)) trashed = moveSkillToTrash(dest, dirName);
      removeSkill(dirName);
    } catch (error) {
      if (trashed && existsSync(trashed) && !existsSync(dest)) renameSync(trashed, dest);
      return `Error: uninstall failed — ${(error as Error).message}`;
    }

    const details = [
      registered ? "removed config registration" : "config registration was already absent",
      trashed ? "moved the complete skill directory to workspace/.trash/" : "skill directory was already absent",
    ];
    return `Uninstalled ${dirName}: ${details.join("; ")}.`;
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

    const dirs = listSkillDirs();
    if (!dirs.length) return "No skills installed.";

    const lines = dirs.map(dir => {
      const active = enabled.has(dir) ? "active" : "inactive";
      const meta = readSkillMeta(dir);
      const desc = meta ? (meta.description ?? "(no description)") : "(no SKILL.md)";
      return `${dir} [${active}]: ${desc}`;
    });
    return lines.join("\n");
  },
};
