import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { logger } from "../logger.js";
import type { TriggerSource } from "../types.js";

/**
 * 每次 ask() 的請求範圍狀態。
 *
 * cron / reminder / journal 跟使用者對話是並行跑的，所以 trigger 和 pendingFiles
 * 必須綁在請求上。放在模組級全域變數會互相覆蓋：cron 觸發時把 trigger 蓋成 "cron"，
 * 正在跑 tool call 的非 owner 請求就繞過了 registry.ts 的 owner-only 檢查；
 * 附件也會串到別人的回覆去。用 AsyncLocalStorage 做請求隔離。
 */
interface RequestContext {
  trigger: TriggerSource;
  /** 這次請求由哪個 Discord 使用者發出（非 Discord 觸發時為 undefined），權限判定用 */
  userId?: string;
  /**
   * 這次請求實際使用的模型（`options.model ?? currentModel`）。
   * 工具的 model-capability gate（如 image_gen 的 GPT-only）要判的是「這個請求跑在哪個模型」，
   * 不是全域 config 的 currentModel——並行請求可能各自帶不同的 options.model（cron / /model 切換），
   * 讀全域變數會有 race。放在 ALS 裡跟 trigger 一樣做請求隔離。
   * ALS 範圍外呼叫（例如 CLI 直接叫工具）時為 undefined，由 registry 端 fallback 回 currentModel。
   */
  model?: string;
  pendingFiles: string[];
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * 在 ALS 範圍外呼叫時的退路（例如 CLI 直接叫工具）。
 * 權限預設保守：unknown 不等於 discord-other，維持放行。
 */
const fallback: RequestContext = { trigger: "unknown", pendingFiles: [] };

function ctx(): RequestContext {
  return storage.getStore() ?? fallback;
}

/** 在獨立的 context 中執行一次 agent 請求 */
export function runWithContext<T>(trigger: TriggerSource, userId: string | undefined, model: string | undefined, fn: () => Promise<T>): Promise<T> {
  return storage.run({ trigger, userId, model, pendingFiles: [] }, fn);
}

export function setTrigger(trigger: TriggerSource): void { ctx().trigger = trigger; }
export function getTrigger(): TriggerSource { return ctx().trigger; }
export function getUserId(): string | undefined { return ctx().userId; }

/** 這次請求的有效模型；ALS 範圍外為 undefined，呼叫端自行 fallback 回 currentModel。 */
export function getRequestModel(): string | undefined { return ctx().model; }

// ── Pending attachments (queued by tools, consumed at the end of ask()) ──

export function queueAttachment(filePath: string): void { ctx().pendingFiles.push(filePath); }

export function peekAttachments(): string[] {
  return [...new Set(ctx().pendingFiles)].filter(filePath => existsSync(filePath));
}

export function drainAttachments(): string[] {
  const c = ctx();
  const queued = c.pendingFiles;
  c.pendingFiles = [];

  // Tools may rename a generated file after image_gen has already queued its
  // original path. One stale path must not make Discord reject the whole reply.
  const unique = [...new Set(queued)];
  const files = unique.filter(filePath => {
    if (existsSync(filePath)) return true;
    logger.warn({ filePath }, "dropping missing queued attachment");
    return false;
  });
  return files;
}

export function clearAttachments(): void { ctx().pendingFiles = []; }
