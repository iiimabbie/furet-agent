import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse } from "yaml";

export type ToolActivityPools = Record<string, string[]>;
export type RandomSource = () => number;

/**
 * Built-in defaults are short English status lines selected by tool or category.
 * Workspace configuration may replace or extend any pool.
 */
export const DEFAULT_TOOL_ACTIVITY_POOLS: ToolActivityPools = {
  common: [
    "Doing a little bit of magic...",
    "Following a very suspicious sparkle...",
    "Consulting the nearby butterflies...",
    "Poking the problem with a tiny wand...",
    "One curious step at a time...",
    "Making the invisible gears wiggle...",
    "Asking the mushrooms for directions...",
    "Something whimsical is happening...",
  ],
  read: [
    "Reading the tiny runes...",
    "Peeking between the lines...",
    "Turning pages with invisible hands...",
    "Teaching my eyes a new trick...",
    "Listening to what the file is not saying...",
    "Looking for secrets in the margins...",
  ],
  write: [
    "Rearranging the runes...",
    "Giving the words a tiny makeover...",
    "Stitching the pieces back together...",
    "Painting carefully between the brackets...",
    "Tucking a new thought into place...",
    "Weaving a fresh line into the tapestry...",
  ],
  shell: [
    "Whispering commands to the machine...",
    "Poking the terminal with a tiny wand...",
    "Making the little gears dance...",
    "Convincing the machine to cooperate...",
    "Pressing buttons that look important...",
    "Asking the black box to do a somersault...",
  ],
  search: [
    "Chasing clues through the sparkles...",
    "Asking the internet nicely...",
    "Looking under every mushroom...",
    "Following a very suspicious trail...",
    "Searching where the secrets hide...",
    "Following footprints made of question marks...",
  ],
  discord: [
    "Carrying a note through the message forest...",
    "Tapping gently on Discord's window...",
    "Sorting the little message birds...",
    "Delivering a whisper to the right channel...",
    "Straightening the conversation ribbons...",
    "Fluttering through the channel list...",
  ],
  github: [
    "Inspecting the timeline for mischief...",
    "Looking for footprints in the commits...",
    "Untangling a branchy little problem...",
    "Asking the pull request what happened...",
    "Counting commits like shiny pebbles...",
    "Dusting fingerprints off the diff...",
  ],
  image: [
    "Mixing colors in a moonlit thimble...",
    "Teaching the pixels how to pose...",
    "Gathering light into a tiny picture...",
    "Painting with an invisible feather...",
    "Convincing the colors to hold still...",
    "Waking up the sleepy pixels...",
  ],
  schedule: [
    "Negotiating with the clock sprites...",
    "Tying a tiny bell to the right moment...",
    "Marking the calendar with enchanted ink...",
    "Teaching the clock when to chirp...",
    "Folding a reminder into the future...",
    "Pinning a note to tomorrow...",
  ],
  memory: [
    "Dusting off a little memory...",
    "Searching the attic of remembered things...",
    "Following an old thought by candlelight...",
    "Opening a carefully labeled memory jar...",
    "Asking yesterday where it put the answer...",
    "Peeking inside the story cupboard...",
  ],
  google: [
    "Sending a paper airplane into the cloud...",
    "Knocking politely on a Google door...",
    "Looking through the cloud drawers...",
    "Following a document into the sky...",
    "Fetching a note from the cloud library...",
    "Checking the sky for useful paperwork...",
  ],
  integrity: [
    "Checking the protective runes...",
    "Looking for tiny cracks in the wards...",
    "Patrolling the edges of the spell circle...",
    "Making sure every charm is still awake...",
    "Listening for suspicious creaks...",
    "Straightening the protective threads...",
  ],
  read_file: [
    "This file smells interesting...",
    "Opening the file with very clean paws...",
    "Letting my eyes nibble through the text...",
    "Reading every line, even the shy ones...",
    "Holding the file up to the moonlight...",
    "Seeing what this little file has been hiding...",
  ],
  bash: [
    "Waking up the terminal goblins...",
    "Rolling a command down the tiny staircase...",
    "Letting the terminal chew on this for a moment...",
    "Putting on my command-line mittens...",
    "Sending a spell through the blinking cursor...",
    "Asking the shell to make itself useful...",
  ],
  web_search: [
    "Asking the whole web one tiny question...",
    "Scooping clues out of the internet river...",
    "Following a link-shaped firefly...",
    "Checking whether the web remembers this...",
    "Hunting for a source that does not look haunted...",
    "Gathering facts from faraway pages...",
  ],
  memory_search: [
    "Rummaging through the memory mushrooms...",
    "Looking for an old thought with fresh eyes...",
    "Following a familiar echo...",
    "Checking which memory jar is humming...",
    "Searching the past without waking it up...",
    "Finding the thread that remembers...",
  ],
  image_gen: [
    "Brewing a picture out of light...",
    "Giving the pixels a tiny adventure...",
    "Painting something that was not there a moment ago...",
    "Coaxing a picture out of the sparkles...",
    "Arranging colors until they start behaving...",
    "Growing an image from a handful of ideas...",
  ],
};

const CATEGORY_BY_TOOL: Record<string, string> = {
  bash: "shell",
  read_file: "read",
  write_file: "write",
  web_search: "search",
  web_fetch: "search",
  tool_catalog: "search",
  memory_search: "memory",
  session_search: "memory",
  sessions_by_date: "memory",
  journal_transcript_by_date: "memory",
  memory_list: "memory",
  memory_add: "write",
  memory_replace: "write",
  memory_remove: "write",
  people_add: "write",
  people_update: "write",
  people_remove: "write",
  image_gen: "image",
  get_weather: "search",
  usage_dashboard: "image",
};

export function toolActivityCategory(toolName: string): string | undefined {
  const direct = CATEGORY_BY_TOOL[toolName];
  if (direct) return direct;
  if (toolName.startsWith("discord_")) return "discord";
  if (toolName.startsWith("google_")) return "google";
  if (toolName.startsWith("cron_") || toolName.startsWith("reminder_")) return "schedule";
  if (toolName.startsWith("soul_guardian_")) return "integrity";
  if (toolName.startsWith("skill_")) return "github";
  return undefined;
}

function cleanPool(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((line): line is string => typeof line === "string")
    .map(line => line.replace(/[\r\n]+/g, " ").trim())
    .filter(Boolean))];
}

export function mergeToolActivityPools(
  custom: ToolActivityPools | undefined,
  mode: "append" | "replace",
): ToolActivityPools {
  const normalized = Object.fromEntries(
    Object.entries(custom ?? {}).map(([key, value]) => [key, cleanPool(value)]),
  );
  if (mode === "replace") return normalized;
  const keys = new Set([...Object.keys(DEFAULT_TOOL_ACTIVITY_POOLS), ...Object.keys(normalized)]);
  return Object.fromEntries([...keys].map(key => [
    key,
    [...(DEFAULT_TOOL_ACTIVITY_POOLS[key] ?? []), ...(normalized[key] ?? [])],
  ]));
}


export interface LoadToolActivityPoolsOptions {
  inline?: ToolActivityPools;
  file?: string;
  mode: "append" | "replace";
  root: string;
}

/**
 * Load optional custom pools from a separate YAML/JSON file, then overlay inline pools.
 * Relative paths resolve from the Umiro root. Invalid files fail fast so a configured
 * customization never silently disappears.
 */
export function loadToolActivityPools(options: LoadToolActivityPoolsOptions): ToolActivityPools {
  let filePools: ToolActivityPools = {};
  if (options.file) {
    const path = isAbsolute(options.file) ? options.file : resolve(options.root, options.file);
    let parsed: unknown;
    try {
      parsed = parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`Unable to load tool activity pools file: ${path}`, { cause: error });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Tool activity pools file must contain a mapping: ${path}`);
    }
    filePools = parsed as ToolActivityPools;
  }
  const custom = { ...filePools, ...(options.inline ?? {}) };
  return mergeToolActivityPools(custom, options.mode);
}

/** Stateful shuffle-bag picker: each pool is exhausted before it is reshuffled. */
export class ToolActivityPicker {
  private readonly bags = new Map<string, { sourceKey: string; values: string[] }>();
  private lastLine: string | undefined;

  constructor(
    private readonly pools: ToolActivityPools,
    private readonly random: RandomSource = Math.random,
  ) {}

  pick(toolName: string): string {
    const actualName = toolName.startsWith("tool_catalog → ")
      ? toolName.slice("tool_catalog → ".length)
      : toolName;
    const keys = [actualName, toolActivityCategory(actualName), "common"]
      .filter((key): key is string => Boolean(key));
    for (const key of keys) {
      const line = this.pickFrom(key);
      if (line) return line;
    }
    return "Doing a little bit of magic...";
  }

  private pickFrom(key: string): string | undefined {
    const source = this.pools[key] ?? [];
    if (source.length === 0) return undefined;
    const sourceKey = JSON.stringify(source);
    let state = this.bags.get(key);
    if (!state || state.sourceKey !== sourceKey || state.values.length === 0) {
      const values = [...source];
      for (let i = values.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [values[i], values[j]] = [values[j], values[i]];
      }
      if (values.length > 1 && values[values.length - 1] === this.lastLine) {
        [values[0], values[values.length - 1]] = [values[values.length - 1], values[0]];
      }
      state = { sourceKey, values };
      this.bags.set(key, state);
    }
    const line = state.values.pop();
    if (line) this.lastLine = line;
    return line;
  }
}
