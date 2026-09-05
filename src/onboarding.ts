/**
 * Onboarding detection, one-time context injection, and completion cleanup.
 *
 * Setup remains active until both OWNER.md and SOUL.md are configured. Once they
 * are complete, the bootstrap section is removed from AGENT.md and synthetic
 * onboarding messages are removed from the active session.
 */

import { readFileSync } from "node:fs";
import { AGENT_FILE, OWNER_FILE, SOUL_FILE } from "./paths.js";
import { atomicWriteFileSync } from "./session-store.js";
import { logger } from "./logger.js";
import { stripTag } from "./utils/tagged-file.js";
import type { Message } from "./types.js";

const OWNER_PLACEHOLDERS = [
  "<how you should address them>",
  "<their Discord username>",
  "<their Discord user ID>",
  "<Any other names that refer",
] as const;

export const ONBOARDING_HEADING = "## Onboarding Protocol";
export const ONBOARDING_MARKER = "[System] ONBOARDING";

export function isOwnerUnconfigured(ownerContent: string): boolean {
  return !stripTag(ownerContent, "owner").trim()
    || OWNER_PLACEHOLDERS.some(placeholder => ownerContent.includes(placeholder));
}

export function isPersonaUnconfigured(personaContent: string): boolean {
  return stripTag(personaContent, "persona").trim().length === 0;
}

export function isOnboardingIncomplete(ownerContent: string, personaContent: string): boolean {
  return isOwnerUnconfigured(ownerContent) || isPersonaUnconfigured(personaContent);
}

export function isWorkspaceUnconfigured(): boolean {
  try {
    return isOnboardingIncomplete(
      readFileSync(OWNER_FILE, "utf-8"),
      readFileSync(SOUL_FILE, "utf-8"),
    );
  } catch {
    return true;
  }
}

export function isOnboardingMessage(msg: Message): boolean {
  return msg.isOnboarding === true;
}

export function shouldOnboard(messages: Message[]): boolean {
  return isWorkspaceUnconfigured() && !messages.some(isOnboardingMessage);
}

export function stripOnboardingProtocol(instructions: string): string {
  const lines = instructions.split("\n");
  const start = lines.findIndex(line => line.trim() === ONBOARDING_HEADING);
  if (start === -1) return instructions;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  const stripped = [...lines.slice(0, start), ...lines.slice(end)].join("\n");
  return stripped.replace(/\n{3,}/g, "\n\n");
}

/** Remove the bootstrap instructions from the editable workspace file after setup. */
export function removeOnboardingProtocolFromAgent(): boolean {
  if (isWorkspaceUnconfigured()) return false;
  try {
    const current = readFileSync(AGENT_FILE, "utf-8");
    const updated = stripOnboardingProtocol(current);
    if (updated === current) return false;
    atomicWriteFileSync(AGENT_FILE, updated);
    return true;
  } catch (err) {
    logger.error({ err, path: AGENT_FILE }, "onboarding protocol cleanup failed");
    return false;
  }
}

/**
 * Safety filter for legacy sessions or a cleanup write that could not be persisted.
 * The durable Session cleanup is preferred; this prevents stale bootstrap context
 * from reaching the model in the meantime.
 */
export function filterStaleOnboarding(
  messages: Message[],
  workspaceUnconfigured = isWorkspaceUnconfigured(),
): Message[] {
  if (workspaceUnconfigured) return messages;
  return messages.filter(message => !isOnboardingMessage(message));
}

export function buildOnboardingContext(userId: string, username: string, displayName?: string): string {
  const nameInfo = displayName && displayName !== username
    ? `Discord username: ${username}, display name: ${displayName}`
    : `Discord username: ${username}`;

  return `${ONBOARDING_MARKER} — This is a brand-new workspace. OWNER.md still contains template placeholders or SOUL.md is still empty. The local onboarding command configured this Discord user ID as the workspace owner. Their Discord identity is: ID ${userId}, ${nameInfo}.

Follow the Onboarding Protocol in your instructions:
1. Introduce yourself briefly and naturally, without assuming a name, personality, or preferred language.
2. Ask how the user wants to be addressed, confirm their Discord username/ID, and ask what name, personality, tone, and language they want their assistant to use.
3. Optionally ask about memory preferences or boundaries.
4. Once you have answers, use write_file to update workspace/OWNER.md and workspace/SOUL.md with real values, preserving the <owner> and <persona> wrapper tags. Remove all OWNER.md angle-bracket placeholders and record the chosen assistant language explicitly in SOUL.md.
5. Then proceed to handle whatever the user's actual message was about.

Do NOT skip this process. Do NOT auto-fill preferences from the Discord profile without asking. The runtime removes this onboarding context and the Onboarding Protocol section from AGENT.md only after both OWNER.md and SOUL.md are configured.`;
}
