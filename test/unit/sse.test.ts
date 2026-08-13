import { describe, it, expect } from "vitest";
import { parseSSE } from "../../src/providers/sse.js";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const payload of parseSSE(stream)) out.push(payload);
  return out;
}

describe("parseSSE", () => {
  it("parses OpenAI-style \\n\\n-delimited events and stops at [DONE]", async () => {
    const stream = streamFromChunks(['data: {"a":1}\n\ndata: {"a":2}\n\ndata: [DONE]\n\ndata: {"a":3}\n\n']);
    expect(await collect(stream)).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("parses events split arbitrarily across multiple network chunks", async () => {
    const stream = streamFromChunks(['da', 'ta: {"a":1', '}\n\ndat', 'a: {"a":2}\n\ndata', ': [DONE]\n\n']);
    expect(await collect(stream)).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("parses Gemini-style \\r\\n\\r\\n-delimited events with no [DONE] sentinel", async () => {
    const stream = streamFromChunks(['data: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n']);
    expect(await collect(stream)).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("handles a \\r\\n\\r\\n boundary split exactly across chunk boundaries", async () => {
    const stream = streamFromChunks(['data: {"a":1}\r\n', '\r\ndata: {"a":2}\r\n\r\n']);
    expect(await collect(stream)).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("flushes a final event that arrives without a trailing blank line", async () => {
    const stream = streamFromChunks(['data: {"a":1}\n\ndata: {"a":2}']);
    expect(await collect(stream)).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("ignores non-data lines (comments, event: fields)", async () => {
    const stream = streamFromChunks([': keep-alive\nevent: message\ndata: {"a":1}\n\n']);
    expect(await collect(stream)).toEqual(['{"a":1}']);
  });

  it("returns nothing for an empty stream", async () => {
    const stream = streamFromChunks([]);
    expect(await collect(stream)).toEqual([]);
  });
});
