import { afterEach, describe, expect, it } from "vitest";
import { UsageDatabase } from "../src/server/database.js";
import { getSummary, getTimeseries } from "../src/server/queries.js";
import type { QuotaSnapshot, UsageEvent } from "../src/shared/domain.js";

const open: UsageDatabase[] = [];
const db = () => {
  const instance = new UsageDatabase(":memory:");
  open.push(instance);
  return instance;
};

afterEach(() => open.splice(0).forEach((item) => item.close()));

function event(key: string, at: number, model = "gpt-5.6-sol", pool: UsageEvent["pool"] = "standard"): UsageEvent {
  return {
    eventKey: key,
    occurredAt: at,
    sessionId: "s",
    model,
    sourceSurface: "vscode",
    inputTokens: 100,
    cachedInputTokens: 60,
    cacheWriteInputTokens: 10,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    contextWindow: 1_050_000,
    longContext: false,
    pool,
    costNanoUsd: model.includes("spark") ? null : 1_000_000_000
  };
}

function quota(key: string, at: number, used: number, reset: number): QuotaSnapshot {
  return {
    eventKey: key,
    occurredAt: at,
    limitId: "codex",
    usedPercent: used,
    remainingPercent: 100 - used,
    windowMinutes: 10_080,
    resetsAt: reset,
    planType: "pro",
    model: "gpt-5.6-sol",
    pool: "standard",
    baseline: false
  };
}

describe("getSummary", () => {
  it("uses inclusive-from and exclusive-to range boundaries", () => {
    const store = db();
    store.insertUsageEvent(event("before", 999));
    store.insertUsageEvent(event("start", 1_000));
    store.insertUsageEvent(event("inside", 1_999));
    store.insertUsageEvent(event("end", 2_000));

    const result = getSummary(store, 1_000, 2_000, "standard");
    expect(result.totals.requestCount).toBe(2);
    expect(result.totals.totalTokens).toBe(240);
    expect(result.totals.costNanoUsd).toBe(2_000_000_000);
  });

  it("excludes Spark from standard totals and exposes it in all totals", () => {
    const store = db();
    store.insertUsageEvent(event("sol", 1_100));
    store.insertUsageEvent(event("spark", 1_200, "gpt-5.3-codex-spark", "spark"));

    expect(getSummary(store, 1_000, 2_000, "standard").totals.requestCount).toBe(1);
    expect(getSummary(store, 1_000, 2_000, "all").totals.requestCount).toBe(2);
  });

  it("never moves quota backward when parallel observations are stale", () => {
    const store = db();
    store.insertQuotaSnapshot(quota("base", 900, 1.0, 8_000));
    store.insertQuotaSnapshot(quota("rise", 1_100, 1.4, 8_000));
    store.insertQuotaSnapshot(quota("stale", 1_200, 1.2, 8_000));
    store.insertQuotaSnapshot(quota("rise2", 1_300, 1.7, 8_000));

    const result = getSummary(store, 1_000, 2_000, "standard");
    expect(result.quota.startRemainingPercent).toBe(99);
    expect(result.quota.endRemainingPercent).toBe(98.3);
    expect(result.quota.percentagePointsConsumed).toBeCloseTo(0.7);
  });

  it("segments resets instead of subtracting across windows", () => {
    const store = db();
    store.insertQuotaSnapshot(quota("a", 900, 4, 2_000));
    store.insertQuotaSnapshot(quota("b", 1_100, 5, 2_000));
    store.insertQuotaSnapshot(quota("c", 1_500, 0.2, 9_000));
    store.insertQuotaSnapshot(quota("d", 1_800, 0.6, 9_000));

    const result = getSummary(store, 1_000, 2_000, "standard");
    expect(result.quota.percentagePointsConsumed).toBeCloseTo(1.4);
    expect(result.quota.resets).toHaveLength(1);
  });
});

describe("getTimeseries", () => {
  it("returns cumulative token and cost buckets", () => {
    const store = db();
    store.insertUsageEvent(event("a", 1_010));
    store.insertUsageEvent(event("b", 1_510));
    const result = getTimeseries(store, 1_000, 2_000, "standard", 500);
    expect(result.usage).toEqual([
      { at: 1_000, tokens: 120, costNanoUsd: 1_000_000_000 },
      { at: 1_500, tokens: 240, costNanoUsd: 2_000_000_000 }
    ]);
  });
});
