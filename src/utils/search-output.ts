/**
 * Code-point-safe text budgeting for search output.
 *
 * JavaScript string length and `slice()` count UTF-16 code units, not Unicode code
 * points. Slicing at an arbitrary index can cut a surrogate pair in half (emoji, many
 * CJK-extension and historic characters), producing a lone surrogate that renders as
 * `�` and can corrupt downstream JSON/Discord payloads. These helpers measure and cut
 * on code-point boundaries via the string iterator, so a multi-unit character is either
 * fully kept or fully dropped — never split.
 */

/** Cut a string to at most `maxCodePoints` code points without splitting a character. */
function sliceCodePoints(value: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) return "";
  let out = "";
  let count = 0;
  for (const ch of value) {
    if (count >= maxCodePoints) break;
    out += ch;
    count++;
  }
  return out;
}

/** Number of Unicode code points (not UTF-16 code units) in a string. */
function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
}

export function truncateSearchText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (codePointLength(normalized) <= maxChars) return normalized;
  // Reserve one code point for the ellipsis so the visible length stays within budget.
  return `${sliceCodePoints(normalized, Math.max(0, maxChars - 1))}…`;
}

export function renderSearchOutput(header: string, entries: string[], suffix = "", maxChars = 30_000): string {
  let output = header;
  let included = 0;
  for (const entry of entries) {
    const candidate = `${output}\n${entry}`;
    // Budget on code points so a multi-unit character near the limit is not half-counted.
    if (codePointLength(candidate) + codePointLength(suffix) > maxChars) break;
    output = candidate;
    included++;
  }
  if (included < entries.length) {
    const notice = `\n- … ${entries.length - included} additional result(s) omitted by output budget; narrow the query or lower the limit.`;
    output = `${sliceCodePoints(output, Math.max(0, maxChars - codePointLength(notice)))}${notice}`;
  }
  if (suffix && codePointLength(output) + codePointLength(suffix) <= maxChars) output += suffix;
  return sliceCodePoints(output, maxChars);
}
