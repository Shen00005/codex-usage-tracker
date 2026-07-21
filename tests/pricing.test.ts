import { describe, expect, it } from "vitest";
import { poolForModel, priceUsage } from "../src/shared/pricing.js";

describe("priceUsage", () => {
  it("prices a short Sol request with disjoint input categories", () => {
    const result = priceUsage("gpt-5.6-sol", {
      inputTokens: 250_000,
      cachedInputTokens: 200_000,
      cacheWriteInputTokens: 25_000,
      outputTokens: 10_000,
      reasoningOutputTokens: 4_000
    });

    expect(result).toEqual({
      priced: true,
      longContext: false,
      uncachedInputTokens: 25_000,
      costNanoUsd: 681_250_000
    });
  });

  it("keeps exactly 272,000 input tokens on short-context prices", () => {
    const result = priceUsage("gpt-5.6-sol", {
      inputTokens: 272_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1_000,
      reasoningOutputTokens: 0
    });

    expect(result.longContext).toBe(false);
    expect(result.costNanoUsd).toBe(1_390_000_000);
  });

  it("prices the full 272,001-token Luna request at long-context rates", () => {
    const result = priceUsage("gpt-5.6-luna", {
      inputTokens: 272_001,
      cachedInputTokens: 200_000,
      cacheWriteInputTokens: 20_000,
      outputTokens: 2_000,
      reasoningOutputTokens: 900
    });

    expect(result).toEqual({
      priced: true,
      longContext: true,
      uncachedInputTokens: 52_001,
      costNanoUsd: 212_002_000
    });
  });

  it("returns an explicit unpriced result for an unknown model", () => {
    expect(priceUsage("future-model", {
      inputTokens: 1,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0
    })).toEqual({ priced: false, longContext: false, uncachedInputTokens: 1, costNanoUsd: null });
  });

  it("assigns Spark to a separate pool", () => {
    expect(poolForModel("gpt-5.3-codex-spark")).toBe("spark");
    expect(poolForModel("gpt-5.6-sol")).toBe("standard");
  });
});
