import type { TriggerSource } from "../types.js";

let currentTrigger: TriggerSource = "unknown";

export function setTrigger(trigger: TriggerSource): void { currentTrigger = trigger; }
export function getTrigger(): TriggerSource { return currentTrigger; }

// ── Pending attachments (queued by tools, consumed by bot.ts) ──

let pendingFiles: string[] = [];

export function queueAttachment(filePath: string): void { pendingFiles.push(filePath); }
export function drainAttachments(): string[] { const files = pendingFiles; pendingFiles = []; return files; }
export function clearAttachments(): void { pendingFiles = []; }
