import { logger } from "../logger.js";
import type { LlmProfile } from "./types.js";

const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.min(Math.max(0, retryAt - Date.now()), 30_000);
  }
  return 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

export function llmHeaders(profile: Pick<LlmProfile, "auth" | "apiKey">): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (profile.auth === "bearer") {
    if (!profile.apiKey) throw new Error("LLM profile requires an API key for bearer authentication");
    headers.Authorization = `Bearer ${profile.apiKey}`;
  }
  return headers;
}

export async function postLlmJson<T>(input: {
  endpoint: string;
  profile: Pick<LlmProfile, "auth" | "apiKey" | "name" | "protocol" | "model">;
  body: unknown;
  timeoutMs?: number;
  label?: string;
}): Promise<T> {
  const label = input.label ?? "LLM API";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(input.endpoint, {
        method: "POST",
        headers: llmHeaders(input.profile),
        body: JSON.stringify(input.body),
        ...(input.timeoutMs ? { signal: AbortSignal.timeout(input.timeoutMs) } : {}),
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw new Error(`${label} request failed after ${attempt} attempts (${input.endpoint})`, { cause: err });
      const delayMs = retryDelayMs(attempt, null);
      logger.warn({ err, attempt, maxAttempts: MAX_ATTEMPTS, delayMs, endpoint: input.endpoint, profile: input.profile.name, protocol: input.profile.protocol, model: input.profile.model }, `${label} transport error, retrying`);
      await sleep(delayMs);
      continue;
    }
    if (response.ok) return response.json() as Promise<T>;
    const detail = await response.text();
    const retryable = RETRYABLE_STATUSES.has(response.status);
    if (!retryable || attempt >= MAX_ATTEMPTS) throw new Error(`${label} ${response.status} after ${attempt} attempt(s): ${detail.slice(0, 4000)}`);
    const delayMs = retryDelayMs(attempt, response.headers.get("retry-after"));
    logger.warn({ status: response.status, attempt, maxAttempts: MAX_ATTEMPTS, delayMs, endpoint: input.endpoint, profile: input.profile.name, protocol: input.profile.protocol, model: input.profile.model, response: detail.slice(0, 500) }, `${label} temporary error, retrying`);
    await sleep(delayMs);
  }
  throw new Error(`${label} retry loop exited unexpectedly`);
}
