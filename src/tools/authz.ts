import type { TriggerSource } from "../types.js";

/**
 * Central, fail-closed authorization model for trigger-based trust.
 *
 * Historically every gate was written as a NEGATIVE check (`trigger !== "discord-other"`).
 * That is fail-OPEN: `unknown` — and any trigger added to TriggerSource in the future —
 * silently inherited full owner/system authority just by not being the one denied value.
 * A single new enum member, or an ALS-scope miss that falls back to `unknown`, would grant
 * owner-only tools, owner_private recall visibility and unrestricted file reads.
 *
 * These sets are POSITIVE allowlists. Anything not explicitly enumerated — including
 * `unknown` and every future trigger — is untrusted by default. Adding a new TriggerSource
 * therefore fails closed until a maintainer consciously opts it into the right tier.
 */

/**
 * Triggers that represent the human owner acting directly. Only these may pass the strict
 * owner-identity gates (e.g. soul_guardian approve/restore) that must never be reachable by
 * automation or external users.
 */
const OWNER_IDENTITY_TRIGGERS: ReadonlySet<TriggerSource> = new Set<TriggerSource>([
  "cli",
  "discord-owner",
]);

/**
 * Triggers that run trusted, owner-configured in-process code on the owner's behalf:
 * scheduled tasks, reminders, the daily journal and loaded plugins. They are not a live
 * external user, so they are trusted for owner-only tool execution and for full search
 * recall visibility. They deliberately do NOT count as owner IDENTITY.
 */
const TRUSTED_SYSTEM_TRIGGERS: ReadonlySet<TriggerSource> = new Set<TriggerSource>([
  "cron",
  "reminder",
  "journal",
  "plugin",
]);

/**
 * The single explicitly-untrusted trigger: a live non-owner Discord user. Listed for
 * documentation/symmetry only — the gates below never rely on membership here, they rely
 * on ABSENCE from the trusted sets, so `unknown` and future triggers stay denied.
 */
export const UNTRUSTED_EXTERNAL_TRIGGERS: ReadonlySet<TriggerSource> = new Set<TriggerSource>([
  "discord-other",
]);

/** True only for triggers where the human owner is acting directly. Fail-closed. */
export function isOwnerIdentity(trigger: TriggerSource): boolean {
  return OWNER_IDENTITY_TRIGGERS.has(trigger);
}

/**
 * True for owner identity OR trusted owner-configured system execution. This is the gate
 * for owner-only TOOLS and for full (owner) search visibility: automation acts for the
 * owner, but a live external user or an unknown/future trigger does not. Fail-closed.
 */
export function isTrustedForOwnerActions(trigger: TriggerSource): boolean {
  return OWNER_IDENTITY_TRIGGERS.has(trigger) || TRUSTED_SYSTEM_TRIGGERS.has(trigger);
}

/**
 * Whether the non-owner file-read path guard (tools/guard.ts) must apply. It applies to
 * every trigger that is NOT trusted for owner actions — i.e. `discord-other`, `unknown`,
 * and any future trigger — instead of only singling out `discord-other`. Fail-closed.
 */
export function requiresFileAccessGuard(trigger: TriggerSource): boolean {
  return !isTrustedForOwnerActions(trigger);
}

/** Search recall visibility flag. Owner scope is granted only to trusted triggers. */
export function hasOwnerSearchVisibility(trigger: TriggerSource): boolean {
  return isTrustedForOwnerActions(trigger);
}
