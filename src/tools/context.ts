import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { logger } from "../logger.js";
import type { TriggerSource } from "../types.js";
import type { LlmProfile } from "../llm/types.js";

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
  /** Current durable session/channel identity, used by search visibility filters. */
  sessionId?: string;
  channelId?: string;
  /**
   * Immutable connection profile for this request. Model, protocol, endpoint, authentication and capabilities must remain consistent across the whole request. ALS callers outside ask() may leave it undefined; consumers resolve the configured active profile.
   */
  profile?: LlmProfile;
  pendingFiles: string[];
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * 在 ALS 範圍外呼叫時的退路（例如 CLI 直接叫工具、或 ALS scope 遺失）。
 * trigger 一律為 "unknown"，而授權模型（tools/authz.ts）把 "unknown" 視為不受信任：
 * 不通過 owner-only 工具閘、套用檔案讀取邊界、且不給 owner 搜尋可見度。fail-closed。
 */
const fallback: RequestContext = { trigger: "unknown", pendingFiles: [] };

function ctx(): RequestContext {
  return storage.getStore() ?? fallback;
}

/** 在獨立的 context 中執行一次 agent 請求 */
export function runWithContext<T>(
  trigger: TriggerSource,
  userId: string | undefined,
  profile: LlmProfile | undefined,
  fn: () => Promise<T>,
  request?: { sessionId?: string; channelId?: string },
): Promise<T> {
  return storage.run({ trigger, userId, profile, sessionId: request?.sessionId, channelId: request?.channelId, pendingFiles: [] }, fn);
}

export function setTrigger(trigger: TriggerSource): void { ctx().trigger = trigger; }
export function getTrigger(): TriggerSource { return ctx().trigger; }
export function getUserId(): string | undefined { return ctx().userId; }
export function getSessionId(): string | undefined { return ctx().sessionId; }
export function getChannelId(): string | undefined { return ctx().channelId; }

/** Immutable LLM connection profile bound to this request. */
export function getRequestProfile(): LlmProfile | undefined { return ctx().profile; }
export function getRequestModel(): string | undefined { return ctx().profile?.model; }

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
