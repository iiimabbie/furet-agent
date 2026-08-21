/**
 * Onboarding detection & one-time context injection.
 *
 * Determines whether the workspace is still in its fresh-install template state
 * by checking for placeholder tokens in OWNER.md. When OWNER.md contains
 * placeholders and a session has no prior messages, a one-time system onboarding
 * context is injected before the user's first message so the agent can guide setup.
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

/** Marker prefix used to identify onboarding context messages by content. */
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
 * Returns false (configured) if the file cannot be read.
 */
export function isWorkspaceUnconfigured(): boolean {
  try {
    const content = readFileSync(OWNER_FILE, "utf-8");
    return isOwnerUnconfigured(content);
  } catch {
    return false;
  }
}

/**
 * Whether to inject onboarding context for this session.
 *
 * Conditions — ALL must be true:
 * 1. Session is empty (length === 0) — first message ever in this channel
 * 2. OWNER.md still has template placeholders
 *
 * Once the owner fills in OWNER.md (via the agent during onboarding), subsequent
 * sessions / channels will never see this context again.
 */
export function shouldOnboard(sessionLength: number): boolean {
  if (sessionLength > 0) return false;
  return isWorkspaceUnconfigured();
}

/**
 * Returns true if a message is the synthetic onboarding context injection.
 * Checks the `isOnboarding` flag first, then falls back to content-based
 * detection for backward compatibility with sessions created before the flag
 * was introduced.
 */
export function isOnboardingMessage(msg: Message): boolean {
  if (msg.isOnboarding) return true;
  return (
    msg.role === "user" &&
    typeof msg.content === "string" &&
    msg.content.startsWith(ONBOARDING_MARKER)
  );
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

  return `${ONBOARDING_MARKER} — This is a brand-new workspace with template placeholders still in OWNER.md. This user (Discord ID: ${userId}, ${nameInfo}) is very likely the owner setting things up for the first time.

Follow the Onboarding Protocol in your instructions:
1. Introduce yourself briefly and naturally (in the user's language).
2. Ask the user for their setup preferences — at minimum: how they'd like to be addressed (do NOT assume their Discord nickname is their preferred name), their Discord username/ID confirmation, and what personality/tone/language they want their assistant to have.
3. Optionally ask about memory preferences or boundaries.
4. Once you have answers, use write_file to update workspace/OWNER.md and workspace/SOUL.md with real values, preserving the <owner> and <persona> wrapper tags. Remove all angle-bracket placeholders.
5. Then proceed to handle whatever the user's actual message was about.

Do NOT skip this process. Do NOT auto-fill values from the Discord profile without asking.`;
}
