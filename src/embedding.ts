/**
 * Embedding transport for the unified search index.
 *
 * Callers own their model choice: vectors from different models are not comparable, so
 * whichever index stores a vector must query it with the same model it was built with.
 */

/**
 * Embedding keys in priority order, read from `GOOGLE_API_KEY` then `GOOGLE_API_KEYS`.
 * Both accept a comma-separated list, so either variable alone can hold the whole pool.
 * Each key carries its own upstream quota, so the outbox worker runs one concurrent lane
 * per key and keeps draining while individual keys sit out a cooldown.
 */
export function getEmbedKeys(): string[] {
  const raw = [process.env.GOOGLE_API_KEY ?? "", process.env.GOOGLE_API_KEYS ?? ""]
    .flatMap(value => value.split(","));
  return [...new Set(raw.map(key => key.trim()).filter(Boolean))];
}

function getEmbedUrl(model: string, apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;
}

/** Call the Gemini embedding API with an explicit key and model. */
export async function embed(text: string, apiKey: string, model: string): Promise<number[]> {
  const res = await fetch(getEmbedUrl(model, apiKey), {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${model}`,
      content: { parts: [{ text }] },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embedding API ${res.status}: ${err}`);
  }
  const data = await res.json() as { embedding: { values: number[] } };
  return data.embedding.values;
}
