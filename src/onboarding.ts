/**
 * Onboarding detection & one-time context injection.
 *
 * Determines whether the workspace is still in its fresh-install template state
 * by checking for placeholder tokens in OWNER.md. After the local CLI has
 * configured the Discord owner ID, a synthetic system context is injected into any
 * session that does not already have active onboarding instructions.
 *
 * The onboarding message is marked with `isOnboarding: true`. It remains available
 * while setup is unfinished, then is filtered once OWNER.md is configured so stale
 * bootstrap instructions cannot mislead later exchanges.
 */

import { readFileSync } from "node:fs";
import { OWNER_FILE } from "./paths.js";
import type { Message } from "./types.js";

// --- Placeholder tokens copied verbatim from templates/OWNER.md ---

const OWNER_PLACEHOLDERS = [
  "<how you should address them>",
  "<their Discord username>",
  "<their Discord user ID>",
] as const;

/** Prefix for the synthetic onboarding instruction stored in a session. */
export const ONBOARDING_MARKER = "[System] ONBOARDING";

/**
 * Returns true when OWNER.md still contains any template placeholder.
 * Pure function — reads the file content passed to it, does NOT touch disk.
 */
export function isOwnerUnconfigured(ownerContent: string): boolean {
  return OWNER_PLACEHOLDERS.some(ph => ownerContent.includes(ph));
}

/**
 * Convenience wrapper that reads OWNER.md from disk.
 * A missing file is treated as unconfigured so a partial fresh install cannot
 * silently bypass setup.
 */
export function isWorkspaceUnconfigured(): boolean {
  try {
    const content = readFileSync(OWNER_FILE, "utf-8");
    return isOwnerUnconfigured(content);
  } catch {
    return true;
  }
}

/** Returns true only for the structured synthetic onboarding message. */
export function isOnboardingMessage(msg: Message): boolean {
  return msg.isOnboarding === true;
}

/**
 * Inject onboarding whenever setup is incomplete and this session does not
 * already contain the structured instruction. This deliberately does not use
 * session length: `/new` and an interrupted first exchange must both resume.
 */
export function shouldOnboard(messages: Message[]): boolean {
  return isWorkspaceUnconfigured() && !messages.some(isOnboardingMessage);
}

/**
 * Filter onboarding context after setup is complete.
 *
 * The context must stay available while the user is still answering the setup
 * questions; removing it merely because the assistant has sent its first greeting
 * would make the next turn forget to write OWNER.md and SOUL.md. Once OWNER.md no
 * longer has template placeholders, the normal system prompt has the configured
 * owner data and the bootstrap context is stale, so remove it before sending the
 * session history to the model.
 *
 * `workspaceUnconfigured` is injectable for unit tests. In production it reads
 * OWNER.md from disk at request time.
 */
export function filterStaleOnboarding(messages: Message[], workspaceUnconfigured = isWorkspaceUnconfigured()): Message[] {
  if (workspaceUnconfigured) return messages;
  return messages.filter(m => !isOnboardingMessage(m));
}

/**
 * Build the one-time onboarding system context to prepend to the session.
 * This is a [System] message appended as the first user message, BEFORE the
 * real user message, so the agent sees it as setup instructions.
 */
export function buildOnboardingContext(userId: string, username: string, displayName?: string): string {
  const nameInfo = displayName && displayName !== username
    ? `Discord username: ${username}, display name: ${displayName}`
    : `Discord username: ${username}`;

  return `${ONBOARDING_MARKER} — This is a brand-new workspace with template placeholders still in OWNER.md. The local onboarding command configured this Discord user ID as the workspace owner. Their Discord identity is: ID ${userId}, ${nameInfo}.

Follow the Onboarding Protocol in your instructions:
1. Introduce yourself briefly and naturally (in the user's language).
2. Ask the user for their setup preferences — at minimum: how they'd like to be addressed (do NOT assume their Discord nickname is their preferred name), their Discord username/ID confirmation, and what personality/tone/language they want their assistant to have.
3. Optionally ask about memory preferences or boundaries.
4. Once you have answers, use write_file to update workspace/OWNER.md and workspace/SOUL.md with real values, preserving the <owner> and <persona> wrapper tags. Remove all angle-bracket placeholders.
5. Then proceed to handle whatever the user's actual message was about.

Do NOT skip this process. Do NOT auto-fill values from the Discord profile without asking.`;
}
