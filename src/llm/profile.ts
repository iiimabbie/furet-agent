import type { FuretConfig } from "../config.js";
import type { LlmCapability, LlmProfile } from "./types.js";

export function activeLlmProfile(config: FuretConfig, modelOverride?: string): LlmProfile {
  const name = config.llm.active_profile;
  const configured = config.llm.profiles[name];
  if (!configured) throw new Error(`Active LLM profile is not configured: ${name}`);
  return Object.freeze({
    ...configured,
    name,
    model: modelOverride ?? configured.model,
    capabilities: Object.freeze({ ...configured.capabilities }),
  });
}

export function supportsCapability(profile: LlmProfile, capability: LlmCapability): boolean {
  return profile.capabilities[capability] === true;
}
