import type pg from "pg";
import { UnifiedChatResponse } from "../providers/types.js";

export interface SemanticCacheHit {
  response: UnifiedChatResponse;
  similarity: number;
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

  async findSimilar(model: string, embedding: number[]): Promise<SemanticCacheHit | null> {
    const vectorLiteral = toVectorLiteral(embedding);
    const result = await this.pool.query<{ response_json: UnifiedChatResponse; similarity: string }>(
      `SELECT response_json, 1 - (embedding <=> $1::vector) AS similarity
       FROM semantic_cache
       WHERE model = $2 AND expires_at > now()
       ORDER BY embedding <=> $1::vector
       LIMIT 1`,
      [vectorLiteral, model],
    );

    const row = result.rows[0];
    if (!row) return null;

    const similarity = Number(row.similarity);
    if (similarity < this.threshold) return null;

    return { response: row.response_json, similarity };
  }

  async store(model: string, promptText: string, embedding: number[], response: UnifiedChatResponse): Promise<void> {
    const vectorLiteral = toVectorLiteral(embedding);
    await this.pool.query(
      `INSERT INTO semantic_cache (model, prompt_text, embedding, response_json, expires_at)
       VALUES ($1, $2, $3::vector, $4, now() + ($5 || ' seconds')::interval)`,
      [model, promptText, vectorLiteral, JSON.stringify(response), this.ttlSeconds],
    );
  }
}
