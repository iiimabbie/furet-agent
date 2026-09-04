import { logger } from "../logger.js";
import { llmHeaders } from "./http.js";
import type { LlmProfile } from "./types.js";

const MODEL_CACHE_TTL_MS = 5 * 60_000;
const modelCache = new Map<string, { expiresAt: number; models: string[] }>();
const inFlight = new Map<string, Promise<string[]>>();

function cacheKey(profile: LlmProfile): string {
  return `${profile.name}\u0000${profile.protocol}\u0000${profile.baseUrl}\u0000${profile.auth}\u0000${profile.apiKey}`;
}

function parseModelIds(payload: unknown): string[] {
  if (payload === null || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return [...new Set(data.flatMap(entry => {
    if (entry === null || typeof entry !== "object") return [];
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  }))].sort((a, b) => a.localeCompare(b));
}

async function fetchGatewayModels(profile: LlmProfile): Promise<string[]> {
  const endpoint = `${profile.baseUrl.replace(/\/+$/, "")}/models`;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: llmHeaders(profile),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Model discovery ${response.status}: ${detail.slice(0, 1000)}`);
  }
  const models = parseModelIds(await response.json());
  if (models.length === 0) throw new Error("Model discovery returned no valid model IDs");
  return models;
}

/** Discover model IDs from the active OpenAI-compatible gateway. Discovery is advisory:
 * `/model` still accepts manually entered IDs because some gateways omit aliases from `/models`. */
export async function listGatewayModels(profile: LlmProfile): Promise<string[]> {
  const key = cacheKey(profile);
  const cached = modelCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.models;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = fetchGatewayModels(profile)
    .then(models => {
      modelCache.set(key, { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models });
      return models;
    })
    .catch(err => {
      logger.warn({ err, profile: profile.name, protocol: profile.protocol, endpoint: profile.baseUrl }, "LLM model discovery failed");
      return cached?.models ?? [profile.model];
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

/**
 * Model-ID segments that mark a gateway entry as a media generator rather than a
 * conversation model. Matched per segment, so `gpt-image-2` and `grok-imagine-video`
 * are excluded while `grok-imagine-*` alone and ordinary IDs are not.
 */
const MEDIA_MODEL_SEGMENTS = new Set(["img", "image", "images", "video", "videos"]);

/** Whether a gateway model ID names an image or video generator. */
export function isMediaModel(id: string): boolean {
  return id.toLowerCase().split(/[^a-z0-9]+/).some(part => MEDIA_MODEL_SEGMENTS.has(part));
}

/**
 * Discovered models that can serve a conversation.
 *
 * A gateway lists every model it can route, including image and video generators that
 * only answer on their own endpoints — picking one for `/model` would break the session
 * with a 400 or 503. They are filtered here rather than upstream so plugins that do call
 * those endpoints still see them through `listGatewayModels`.
 */
export async function listConversationModels(profile: LlmProfile): Promise<string[]> {
  const models = await listGatewayModels(profile);
  const conversational = models.filter(id => !isMediaModel(id));
  // Never hand back an empty picker: a gateway that only exposes media models is better
  // reported as-is than as "no models available".
  return conversational.length > 0 ? conversational : models;
}
