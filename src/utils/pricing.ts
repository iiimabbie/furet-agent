import type { TokenUsage } from "../types.js";

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5-20251101": { input: 5, output: 25 },
  "claude-opus-4-1-20250805": { input: 15, output: 75 },
  "claude-opus-4-20250514": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5-20250929": { input: 3, output: 15 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-sonnet-3-7-20250219": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4 },
};

export function estimateCost(usage: TokenUsage, model: string): string {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return "?";
  const cost = (usage.inputTokens * pricing.input + usage.outputTokens * pricing.output) / 1_000_000;
  return `$${cost.toFixed(2)}`;
}
