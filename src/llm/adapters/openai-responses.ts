import { postLlmJson } from "../http.js";
import type { LlmProfile } from "../types.js";
interface Annotation { type?: string; url?: string; title?: string }
interface ContentItem { type?: string; text?: string; annotations?: Annotation[] }
interface OutputItem { type?: string; content?: ContentItem[] }
interface ApiResponse { id?: string; error?: unknown; output?: OutputItem[]; output_text?: string }
export interface ResponsesWebSearchResult { text: string; sources: Array<{ title?: string; url: string }>; responseId?: string }
function outputText(response: ApiResponse): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text.trim();
  return (response.output ?? []).flatMap(item => item.content ?? []).filter(item => item.type === "output_text" && typeof item.text === "string").map(item => item.text!.trim()).filter(Boolean).join("\n");
}
function sources(response: ApiResponse): ResponsesWebSearchResult["sources"] {
  const unique = new Map<string, { title?: string; url: string }>();
  for (const item of response.output ?? []) for (const content of item.content ?? []) for (const annotation of content.annotations ?? []) {
    if (annotation.type === "url_citation" && typeof annotation.url === "string" && annotation.url) unique.set(annotation.url, { ...(annotation.title ? { title: annotation.title } : {}), url: annotation.url });
  }
  return [...unique.values()];
}
export async function callResponsesWebSearch(profile: LlmProfile, query: string, maxOutputTokens = 2048): Promise<ResponsesWebSearchResult> {
  const endpoint = `${profile.baseUrl.replace(/\/+$/, "")}/responses`;
  const response = await postLlmJson<ApiResponse>({ endpoint, profile, label: "OpenAI Responses web search", body: { model: profile.model, input: query, tools: [{ type: "web_search" }], max_output_tokens: maxOutputTokens } });
  if (response.error) throw new Error(`OpenAI Responses web search failed: ${JSON.stringify(response.error).slice(0, 2000)}`);
  const text = outputText(response);
  if (!text) throw new Error("OpenAI Responses web search returned no output text");
  return { text, sources: sources(response), ...(response.id ? { responseId: response.id } : {}) };
}
