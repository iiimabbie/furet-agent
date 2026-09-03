export function truncateSearchText(value: string, maxChars: number): string {
  const normalized = value.trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function renderSearchOutput(header: string, entries: string[], suffix = "", maxChars = 30_000): string {
  let output = header;
  let included = 0;
  for (const entry of entries) {
    const candidate = `${output}\n${entry}`;
    if (candidate.length + suffix.length > maxChars) break;
    output = candidate;
    included++;
  }
  if (included < entries.length) {
    const notice = `\n- … ${entries.length - included} additional result(s) omitted by output budget; narrow the query or lower the limit.`;
    output = `${output.slice(0, Math.max(0, maxChars - notice.length))}${notice}`;
  }
  if (suffix && output.length + suffix.length <= maxChars) output += suffix;
  return output.slice(0, maxChars);
}
