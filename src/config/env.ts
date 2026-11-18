import "dotenv/config";
import { z } from "zod";

export const DEFAULT_ADMIN_SECRET = "dev-admin-secret-change-in-prod";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),

  GROQ_API_KEY: z.string().optional().default(""),
  GEMINI_API_KEY: z.string().optional().default(""),
  OPENROUTER_API_KEY: z.string().optional().default(""),

  REDIS_URL: z.string().default("redis://localhost:6389"),
  DATABASE_URL: z.string().default("postgres://gateway:gateway@localhost:5488/llm_gateway"),

  PORT: z.coerce.number().default(8787),
  LOG_LEVEL: z.string().default("info"),

  CACHE_TTL_SECONDS: z.coerce.number().default(300),
  SEMANTIC_CACHE_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  EMBEDDING_MODEL: z.string().default("gemini-embedding-001"),
  SEMANTIC_CACHE_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  SEMANTIC_CACHE_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),

  DEFAULT_REQUESTS_PER_MINUTE: z.coerce.number().default(60),
  DEFAULT_TOKENS_PER_MINUTE: z.coerce.number().default(40000),

  DEFAULT_BUDGET_USD_MONTHLY: z.coerce.number().default(5),
  BUDGET_MODE: z.enum(["hard_stop", "soft_warn"]).default("hard_stop"),

  ADMIN_SECRET: z.string().default(DEFAULT_ADMIN_SECRET),
  AUTH_CACHE_TTL_MS: z.coerce.number().int().min(0).default(15_000),

  ROUTING_STRATEGY: z.enum(["static_priority", "latency_based"]).default("static_priority"),
  PROVIDER_PRIORITY: z.string().default("groq,gemini,openrouter"),
});

/** Refuse to boot a production process that still uses the well-known default (or an obviously weak) admin secret. */
export function assertSafeConfig(cfg: { NODE_ENV: string; ADMIN_SECRET: string }): void {
  if (cfg.NODE_ENV !== "production") return;
  if (cfg.ADMIN_SECRET === DEFAULT_ADMIN_SECRET) {
    throw new Error("Refusing to start: ADMIN_SECRET is the default value in production. Set a strong ADMIN_SECRET.");
  }
  if (cfg.ADMIN_SECRET.length < 16) {
    throw new Error("Refusing to start: ADMIN_SECRET must be at least 16 characters in production.");
  }
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;

assertSafeConfig(env);

export const providerPriority = env.PROVIDER_PRIORITY.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
