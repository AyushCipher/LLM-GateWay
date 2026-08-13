import { redis } from "../src/redis/client.js";
import { buildProviderRegistry } from "../src/providers/registry.js";

async function main() {
  const registry = buildProviderRegistry(redis);
  for (const [name, adapter] of registry) {
    const start = Date.now();
    try {
      const res = await adapter.chat(
        {
          model: "default",
          messages: [{ role: "user", content: "Reply with exactly one word: ok" }],
          maxTokens: 10,
        },
        AbortSignal.timeout(15000),
      );
      console.log(
        `[OK] ${name} (${res.model}) — ${Date.now() - start}ms — content=${JSON.stringify(res.content).slice(0, 60)} usage=${JSON.stringify(res.usage)}`,
      );
    } catch (err) {
      console.error(`[FAIL] ${name} — ${Date.now() - start}ms —`, err);
    }
  }
  await redis.quit();
}

main();
