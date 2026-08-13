export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        const payload = extractDataPayload(event);
        if (payload === null) continue;
        if (payload === "[DONE]") return;
        yield payload;
      }
    }

    const payload = extractDataPayload(buffer);
    if (payload !== null && payload !== "[DONE]") yield payload;
  } finally {
    reader.releaseLock();
  }
}

function extractDataPayload(eventBlock: string): string | null {
  const lines = eventBlock.split("\n").filter((line) => line.startsWith("data:"));
  if (lines.length === 0) return null;
  return lines.map((line) => line.slice("data:".length).trimStart()).join("\n");
}
