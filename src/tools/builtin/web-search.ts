import { logger } from "../../logger.js";

export const webSearchDefinition = {
  type: "function" as const,
  function: {
    name: "web_search",
    description: "Search the web using Google Search. Returns search results with titles, URLs, and snippets.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
      },
      required: ["query"],
    },
  },
};

interface GeminiCandidate {
  content: { parts: Array<{ text?: string }> };
  groundingMetadata?: {
    searchEntryPoint?: { renderedContent: string };
    groundingChunks?: Array<{ web?: { uri: string; title: string } }>;
    webSearchQueries?: string[];
  };
}

export async function executeWebSearch(args: { query: string }): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return "Error: GOOGLE_API_KEY not set";

  logger.info({ query: args.query }, "web_search");

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: args.query }] }],
          tools: [{ google_search: {} }],
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      logger.error({ status: response.status, err }, "web_search failed");
      return `Search failed: HTTP ${response.status}`;
    }

    const data = await response.json() as { candidates: GeminiCandidate[] };
    const candidate = data.candidates?.[0];
    if (!candidate) return "No search results found.";

    const text = candidate.content.parts.map(p => p.text).filter(Boolean).join("\n");
    const sources = candidate.groundingMetadata?.groundingChunks
      ?.map(c => c.web ? `- [${c.web.title}](${c.web.uri})` : null)
      .filter(Boolean)
      .join("\n");

    return [text, sources ? `\nSources:\n${sources}` : ""].join("\n");
  } catch (err) {
    logger.error({ err }, "web_search error");
    return `Search error: ${(err as Error).message}`;
  }
}
