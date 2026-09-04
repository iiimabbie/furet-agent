import type { UmiroConfig, ReasoningEffort } from "../config.js";
import type { SessionModelSettings } from "../types.js";
import type { LlmCapability, LlmProfile } from "./types.js";

export interface LlmProfileOverrides {
  profile?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export function resolveLlmProfile(config: UmiroConfig, overrides: LlmProfileOverrides = {}): LlmProfile {
  const name = overrides.profile ?? config.llm.active_profile;
  const configured = config.llm.profiles[name];
  if (!configured) throw new Error(`LLM profile is not configured: ${name}`);
  return Object.freeze({
    ...configured,
    name,
    model: overrides.model ?? configured.model,
    reasoningEffort: overrides.reasoningEffort ?? configured.reasoningEffort,
    capabilities: Object.freeze({ ...configured.capabilities }),
  });
}

export function activeLlmProfile(config: UmiroConfig, modelOverride?: string): LlmProfile {
  return resolveLlmProfile(config, { model: modelOverride });
}

export function sessionLlmProfile(
  config: UmiroConfig,
  settings: SessionModelSettings,
  modelOverride?: string,
): LlmProfile {
  return resolveLlmProfile(config, {
    profile: settings.profile,
    model: modelOverride ?? settings.model,
    reasoningEffort: settings.reasoningEffort,
  });
}

export function defaultSessionModelSettings(config: UmiroConfig): SessionModelSettings {
  const profile = activeLlmProfile(config);
  return {
    profile: profile.name,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    revision: 0,
  };
}

export function supportsCapability(profile: LlmProfile, capability: LlmCapability): boolean {
  return profile.capabilities[capability] === true;
}

/** Resolve the dedicated model used by all journal work. Journal never inherits a
 * conversation session's model selection. */
export function journalLlmProfile(config: UmiroConfig): LlmProfile {
  return activeLlmProfile(config, config.journal.model || undefined);
}
