import { AsyncLocalStorage } from "node:async_hooks";
import type { TriggerSource } from "../types.js";

/**
 * 每次 ask() 的請求範圍狀態。
 *
 * 以前 trigger 和 pendingFiles 是模組級的全域變數，但 cron / reminder / journal
 * 跟使用者對話是並行跑的：cron 觸發時把 trigger 覆蓋成 "cron"，
 * 正在跑 tool call 的非 owner 請求就繞過了 registry.ts 的 owner-only 檢查。
 * 附件也一樣會串到別人的回覆去。改用 AsyncLocalStorage 做請求隔離。
 */
interface RequestContext {
  trigger: TriggerSource;
  pendingFiles: string[];
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * 在 ALS 範圍外呼叫時的退路（例如 CLI 直接叫工具）。
 * 權限預設保守：unknown 不等於 discord-other，維持原本的放行行為。
 */
const fallback: RequestContext = { trigger: "unknown", pendingFiles: [] };

function ctx(): RequestContext {
  return storage.getStore() ?? fallback;
}

/** 在獨立的 context 中執行一次 agent 請求 */
export function runWithContext<T>(trigger: TriggerSource, fn: () => Promise<T>): Promise<T> {
  return storage.run({ trigger, pendingFiles: [] }, fn);
}

export function setTrigger(trigger: TriggerSource): void { ctx().trigger = trigger; }
export function getTrigger(): TriggerSource { return ctx().trigger; }

// ── Pending attachments (queued by tools, consumed at the end of ask()) ──

export function queueAttachment(filePath: string): void { ctx().pendingFiles.push(filePath); }

export function drainAttachments(): string[] {
  const c = ctx();
  const files = c.pendingFiles;
  c.pendingFiles = [];
  return files;
}

export function clearAttachments(): void { ctx().pendingFiles = []; }
