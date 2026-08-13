import { createHash, randomBytes } from "node:crypto";

export function generateApiKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const rawKey = `lg_${randomBytes(24).toString("hex")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 8);
  return { rawKey, keyHash, keyPrefix };
}

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}
