import { describe, expect, it } from "vitest";
import { StreamEvent } from "../../src/routing/router.js";
import { StreamChunk } from "../../src/providers/streamTypes.js";
import { UnifiedChatRequest } from "../../src/providers/types.js";
import { FakeAdapter, buildRouter, sleep, waitForever } from "../helpers/fakes.js";

const request: UnifiedChatRequest = { model: "default", messages: [{ role: "user", content: "tell me a story" }], maxTokens: 50 };

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("Router.routeStream (fake provider streams)", () => {
  it("returns a partial result with ESTIMATED usage when the upstream dies mid-stream, and does not fall back", async () => {
    const dying = new FakeAdapter("groq", "llama-3.1-8b-instant", async function* () {
      yield { delta: "hel" };
      yield { delta: "lo!!" };
      throw new Error("socket hang up");
    });
    const backup = new FakeAdapter("gemini", "gemini-flash-lite-latest", async function* () {
      yield { delta: "never used" };
    });
    const router = buildRouter([dying, backup]);

    const events = await collect(router.routeStream(request, "static_priority"));

    expect(events.map((e) => e.type)).toEqual(["chunk", "chunk", "error"]);
    const err = events[2] as Extract<StreamEvent, { type: "error" }>;
    expect(err.partial).toBeDefined();
    expect(err.partial!.response.content).toBe("hello!!");
    expect(err.partial!.usageEstimated).toBe(true);
    expect(err.partial!.response.usage.completionTokens).toBe(2); // ceil(7 / 4)
    expect(err.partial!.response.usage.totalTokens).toBeGreaterThan(0);
    expect(err.attempts.map((a) => a.provider)).toEqual(["groq"]); // no silent fallback after output was sent
  });

  it("uses provider-reported usage when present and flags it as not estimated", async () => {
    const adapter = new FakeAdapter("groq", "llama-3.1-8b-instant", async function* () {
      yield { delta: "hi" };
      yield { delta: "", usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } };
    });
    const events = await collect(buildRouter([adapter]).routeStream(request, "static_priority"));
    const done = events.at(-1) as Extract<StreamEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    expect(done.usageEstimated).toBe(false);
    expect(done.response.usage.totalTokens).toBe(10);
  });

  it("estimates tokens instead of recording 0 when a completed stream carries no usage", async () => {
    const adapter = new FakeAdapter("groq", "llama-3.1-8b-instant", async function* () {
      yield { delta: "twelve chars" };
    });
    const events = await collect(buildRouter([adapter]).routeStream(request, "static_priority"));
    const done = events.at(-1) as Extract<StreamEvent, { type: "done" }>;
    expect(done.usageEstimated).toBe(true);
    expect(done.response.usage.completionTokens).toBe(3);
    expect(done.response.usage.totalTokens).toBeGreaterThan(3);
  });

  it("times out on a per-chunk idle gap, not on total stream duration", async () => {
    // 6 chunks, 40ms apart => ~240ms total, longer than the 100ms idle limit, but never idle that long.
    const slowButAlive = new FakeAdapter("groq", "llama-3.1-8b-instant", async function* () {
      for (let i = 0; i < 6; i++) {
        await sleep(40);
        yield { delta: `c${i}` };
      }
    });
    const events = await collect(buildRouter([slowButAlive], { streamIdleTimeoutMs: 100 }).routeStream(request, "static_priority"));
    expect(events.at(-1)!.type).toBe("done");
    expect((events.at(-1) as Extract<StreamEvent, { type: "done" }>).response.content).toBe("c0c1c2c3c4c5");
  });

  it("aborts a silent upstream after the idle timeout and reports the partial output", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const stalls = new FakeAdapter("groq", "llama-3.1-8b-instant", async function* (signal) {
      upstreamSignal = signal;
      yield { delta: "start" };
      await new Promise<never>(() => {}); // ignores the signal entirely: the router must not depend on adapter cooperation
    });
    const started = Date.now();
    const events = await collect(buildRouter([stalls], { streamIdleTimeoutMs: 80 }).routeStream(request, "static_priority"));

    expect(Date.now() - started).toBeLessThan(2000);
    const err = events.at(-1) as Extract<StreamEvent, { type: "error" }>;
    expect(err.type).toBe("error");
    expect(err.message).toMatch(/idle/);
    expect(err.partial!.response.content).toBe("start");
    expect(upstreamSignal!.aborted).toBe(true);
  });

  it("falls back when the first chunk never arrives within the idle window", async () => {
    // eslint-disable-next-line require-yield
    const hung = new FakeAdapter("groq", "llama-3.1-8b-instant", async function* (signal) {
      await waitForever(signal);
    });
    const ok = new FakeAdapter("gemini", "gemini-flash-lite-latest", async function* () {
      yield { delta: "fine" };
    });
    const events = await collect(buildRouter([hung, ok], { streamIdleTimeoutMs: 60 }).routeStream(request, "static_priority"));
    const done = events.at(-1) as Extract<StreamEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    expect(done.response.provider).toBe("gemini");
    expect(done.attempts[0]).toMatchObject({ provider: "groq", outcome: "error", errorKind: "timeout" });
  });

  it("on client disconnect aborts the upstream and emits an `aborted` event carrying the partial output", async () => {
    const adapter = new FakeAdapter("groq", "llama-3.1-8b-instant", async function* (signal) {
      yield { delta: "part" };
      await waitForever(signal);
    });
    const client = new AbortController();
    const gen = buildRouter([adapter]).routeStream(request, "static_priority", client.signal);

    const events: StreamEvent[] = [];
    for await (const e of gen) {
      events.push(e);
      if (e.type === "chunk") setTimeout(() => client.abort(), 10);
    }

    const aborted = events.at(-1) as Extract<StreamEvent, { type: "aborted" }>;
    expect(aborted.type).toBe("aborted");
    expect(aborted.partial.response.content).toBe("part");
    expect(aborted.partial.usageEstimated).toBe(true);
    expect(adapter.lastSignal!.aborted).toBe(true);
  });

  it("aborts the upstream when the consumer simply stops iterating", async () => {
    const adapter = new FakeAdapter("groq", "llama-3.1-8b-instant", async function* () {
      for (let i = 0; i < 100; i++) {
        await sleep(5);
        yield { delta: "x" } satisfies StreamChunk;
      }
    });
    const gen = buildRouter([adapter]).routeStream(request, "static_priority");
    await gen.next();
    await gen.return(undefined);
    expect(adapter.lastSignal!.aborted).toBe(true);
  });
});
