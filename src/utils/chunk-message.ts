interface FenceState {
  marker: string;
  opener: string;
}

function updateFenceState(text: string, initial: FenceState | null): FenceState | null {
  let state = initial;
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (!match) continue;

    const marker = match[1];
    const rest = match[2];
    if (!state) {
      state = { marker, opener: line.trimStart() };
    } else if (
      marker[0] === state.marker[0]
      && marker.length >= state.marker.length
      && rest.trim() === ""
    ) {
      state = null;
    }
  }
  return state;
}

function findCut(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  const newline = text.lastIndexOf("\n", limit - 1);
  return newline >= Math.floor(limit / 2) ? newline + 1 : limit;
}

/**
 * Split Discord messages without leaving fenced code blocks open across chunks.
 * When a split occurs inside a fence, the current chunk is closed and the next
 * chunk reopens the same fence (including its language tag).
 */
export function chunkMessage(text: string, maxLength = 2000): string[] {
  if (maxLength < 8) throw new Error("maxLength is too small for fenced chunking");
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let carriedFence: FenceState | null = null;

  while (remaining.length > 0) {
    const prefix = carriedFence ? `${carriedFence.opener}\n` : "";
    let cut = findCut(remaining, maxLength - prefix.length);
    let body = remaining.slice(0, cut);
    let endFence = updateFenceState(body, carriedFence);
    let suffix = endFence ? `\n${endFence.marker}` : "";

    while (prefix.length + body.length + suffix.length > maxLength) {
      const bodyLimit = maxLength - prefix.length - suffix.length;
      cut = findCut(remaining, bodyLimit);
      body = remaining.slice(0, cut);
      endFence = updateFenceState(body, carriedFence);
      suffix = endFence ? `\n${endFence.marker}` : "";
    }

    chunks.push(prefix + body + suffix);
    remaining = remaining.slice(cut);
    carriedFence = endFence;
  }

  return chunks;
}
