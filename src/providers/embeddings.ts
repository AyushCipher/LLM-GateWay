import { ProviderError } from "./types.js";

interface EmbedContentResponse {
  embedding: { values: number[] };
}

export async function embedText(apiKey: string, model: string, text: string): Promise<number[]> {
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: { parts: [{ text }] }, outputDimensionality: 768 }),
    });
  } catch (err) {
    throw new ProviderError("gemini-embeddings", "network", `embedding network error: ${(err as Error).message}`, err);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new ProviderError(
      "gemini-embeddings",
      res.status >= 500 ? "server_error" : "client_error",
      `embedding request failed ${res.status}: ${bodyText}`,
    );
  }

  const data = (await res.json()) as EmbedContentResponse;
  return data.embedding.values;
}
