import type { PricedUsage, TokenUsage, UsagePool } from "./domain.js";

const NANO_USD_PER_USD = 1_000_000_000;
const TOKENS_PER_MILLION = 1_000_000;
export const LONG_CONTEXT_THRESHOLD = 272_000;

interface RateBand {
  uncachedInputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  cacheWriteUsdPerMillion: number;
  outputUsdPerMillion: number;
}

interface ModelRates {
  short: RateBand;
  long: RateBand;
}

function rateBand(input: number, cached: number, write: number, output: number): RateBand {
  return {
    uncachedInputUsdPerMillion: input,
    cachedInputUsdPerMillion: cached,
    cacheWriteUsdPerMillion: write,
    outputUsdPerMillion: output
  };
}

export const MODEL_PRICES: Readonly<Record<string, ModelRates>> = Object.freeze({
  "gpt-5.6-sol": {
    short: rateBand(5, 0.5, 6.25, 30),
    long: rateBand(10, 1, 12.5, 45)
  },
  "gpt-5.6-terra": {
    short: rateBand(2.5, 0.25, 3.125, 15),
    long: rateBand(5, 0.5, 6.25, 22.5)
  },
  "gpt-5.6-luna": {
    short: rateBand(1, 0.1, 1.25, 6),
    long: rateBand(2, 0.2, 2.5, 9)
  }
});

function tokenCostNanoUsd(tokens: number, usdPerMillion: number): number {
  return Math.round(tokens * usdPerMillion * NANO_USD_PER_USD / TOKENS_PER_MILLION);
}

export function poolForModel(model: string): UsagePool {
  if (model === "gpt-5.3-codex-spark" || model.includes("spark")) return "spark";
  if (model.startsWith("gpt-5.6-")) return "standard";
  return "other";
}

export function priceUsage(model: string, usage: TokenUsage): PricedUsage {
  const uncachedInputTokens = Math.max(
    0,
    usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens
  );
  const longContext = usage.inputTokens > LONG_CONTEXT_THRESHOLD;
  const modelRates = MODEL_PRICES[model];

  if (!modelRates) {
    return { priced: false, longContext, uncachedInputTokens, costNanoUsd: null };
  }

  const rates = longContext ? modelRates.long : modelRates.short;
  const costNanoUsd =
    tokenCostNanoUsd(uncachedInputTokens, rates.uncachedInputUsdPerMillion) +
    tokenCostNanoUsd(usage.cachedInputTokens, rates.cachedInputUsdPerMillion) +
    tokenCostNanoUsd(usage.cacheWriteInputTokens, rates.cacheWriteUsdPerMillion) +
    tokenCostNanoUsd(usage.outputTokens, rates.outputUsdPerMillion);

  return { priced: true, longContext, uncachedInputTokens, costNanoUsd };
}

export function nanoUsdToUsd(nanoUsd: number): number {
  return nanoUsd / NANO_USD_PER_USD;
}
