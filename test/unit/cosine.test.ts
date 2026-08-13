import { describe, it, expect } from "vitest";
import { cosineSimilarity } from "../../src/cache/cosine.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("is -1 for exactly opposite vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 10);
  });

  it("is scale-invariant", () => {
    const a = [3, 4];
    const b = [6, 8];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 10);
  });

  it("matches a hand-computed value for a known pair", () => {
    const expected = 32 / Math.sqrt(1078);
    expect(cosineSimilarity([1, 2, 3], [4, 5, 6])).toBeCloseTo(expected, 10);
  });

  it("throws on dimension mismatch", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/dimension mismatch/);
  });
});
