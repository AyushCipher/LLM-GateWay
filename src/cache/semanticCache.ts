import type pg from "pg";
import { UnifiedChatResponse } from "../providers/types.js";

export interface SemanticCacheHit {
  response: UnifiedChatResponse;
  similarity: number;
}

/** Everything that must match exactly before a vector similarity comparison is even considered. */
export interface SemanticScope {
  tenantId: string; // api_keys.id
  model: string; // provider-qualified when the caller asked for "default"
  temperature: number;
  maxTokens: number;
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export class SemanticCacheStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly ttlSeconds: number,
    private readonly threshold: number,
  ) {}

  async findSimilar(scope: SemanticScope, embedding: number[]): Promise<SemanticCacheHit | null> {
    const vectorLiteral = toVectorLiteral(embedding);
    const result = await this.pool.query<{ response_json: UnifiedChatResponse; similarity: string }>(
      `SELECT response_json, 1 - (embedding <=> $1::vector) AS similarity
       FROM semantic_cache
       WHERE api_key_id = $2 AND model = $3 AND temperature = $4::real AND max_tokens = $5 AND expires_at > now()
       ORDER BY embedding <=> $1::vector
       LIMIT 1`,
      [vectorLiteral, scope.tenantId, scope.model, scope.temperature, scope.maxTokens],
    );

    const row = result.rows[0];
    if (!row) return null;

    const similarity = Number(row.similarity);
    if (similarity < this.threshold) return null;

    return { response: row.response_json, similarity };
  }

  async store(scope: SemanticScope, promptText: string, embedding: number[], response: UnifiedChatResponse): Promise<void> {
    const vectorLiteral = toVectorLiteral(embedding);
    await this.pool.query(
      `INSERT INTO semantic_cache (api_key_id, model, temperature, max_tokens, prompt_text, embedding, response_json, expires_at)
       VALUES ($1, $2, $3::real, $4, $5, $6::vector, $7, now() + ($8 || ' seconds')::interval)`,
      [scope.tenantId, scope.model, scope.temperature, scope.maxTokens, promptText, vectorLiteral, JSON.stringify(response), this.ttlSeconds],
    );
  }

  /** Physically deletes expired rows (reads already ignore them, but they would otherwise grow the table/HNSW index forever). */
  async sweepExpired(): Promise<number> {
    const result = await this.pool.query("DELETE FROM semantic_cache WHERE expires_at <= now()");
    return result.rowCount ?? 0;
  }

  /** Starts a periodic sweep; returns a stop function. The timer is unref'd so it never keeps the process alive. */
  startSweeper(intervalMs = 60_000, onError: (err: unknown) => void = () => {}): () => void {
    const timer = setInterval(() => {
      this.sweepExpired().catch(onError);
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
