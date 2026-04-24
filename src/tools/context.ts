import type { TriggerSource } from "../types.js";

let currentTrigger: TriggerSource = "unknown";

export function setTrigger(trigger: TriggerSource): void { currentTrigger = trigger; }
export function getTrigger(): TriggerSource { return currentTrigger; }
