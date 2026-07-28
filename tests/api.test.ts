import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server/app.js";
import { UsageDatabase } from "../src/server/database.js";
import type { SessionFollower } from "../src/server/session-follower.js";
import type { UsageEvent } from "../src/shared/domain.js";

const databases: UsageDatabase[] = [];
const apps: Array<ReturnType<typeof buildServer>> = [];

function database(): UsageDatabase {
  const db = new UsageDatabase(":memory:");
  databases.push(db);
  return db;
}

function follower(lastEventAt = Date.parse("2026-07-21T20:00:00Z")): SessionFollower {
  return {
    getStatus: () => ({ state: "watching", lastScanAt: lastEventAt + 500, lastEventAt, lastError: null, watchedFiles: 4 })
  } as SessionFollower;
}

function event(key: string, at: number, pool: UsageEvent["pool"] = "standard"): UsageEvent {
  const spark = pool === "spark";
  return {
    eventKey: key,
    occurredAt: at,
    sessionId: "s",
    model: spark ? "gpt-5.3-codex-spark" : "gpt-5.6-sol",
    sourceSurface: "vscode",
    serviceTier: "default",
    inputTokens: 100,
    cachedInputTokens: 60,
    cacheWriteInputTokens: 0,
    outputTokens: 10,
    reasoningOutputTokens: 2,
    contextWindow: 1_050_000,
    longContext: false,
    pool,
    costNanoUsd: spark ? null : 750_000
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  databases.splice(0).forEach((db) => db.close());
});

function app(db = database()) {
  const server = buildServer({ database: db, follower: follower(), now: () => Date.parse("2026-07-21T20:00:02Z") });
  apps.push(server);
  return server;
}

describe("local API", () => {
  it("reports collector health and processing lag", async () => {
    const response = await app().inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      collector: { state: "watching", watchedFiles: 4 },
      lagMs: 2_000
    });
  });

  it("returns exact range totals with standard as the default pool", async () => {
    const db = database();
    const from = Date.parse("2026-07-21T19:00:00Z");
    db.insertUsageEvent(event("sol", from + 1_000));
    db.insertUsageEvent(event("spark", from + 2_000, "spark"));
    const server = app(db);
    const response = await server.inject({
      method: "GET",
      url: "/api/summary?from=2026-07-21T19:00:00.000Z&to=2026-07-21T20:00:00.000Z"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().totals).toMatchObject({ requestCount: 1, totalTokens: 110, costNanoUsd: 750_000 });
  });

  it("supports Spark and all-pool filters", async () => {
    const db = database();
    db.insertUsageEvent(event("sol", 1_100));
    db.insertUsageEvent(event("spark", 1_200, "spark"));
    const server = app(db);
    const spark = await server.inject({ method: "GET", url: "/api/summary?from=1000&to=2000&pool=spark" });
    const all = await server.inject({ method: "GET", url: "/api/summary?from=1000&to=2000&pool=all" });
    expect(spark.json().totals.requestCount).toBe(1);
    expect(all.json().totals.requestCount).toBe(2);
  });

  it("rejects invalid ranges and pool names", async () => {
    const server = app();
    const reversed = await server.inject({ method: "GET", url: "/api/summary?from=2000&to=1000" });
    const pool = await server.inject({ method: "GET", url: "/api/summary?from=1000&to=2000&pool=nope" });
    expect(reversed.statusCode).toBe(400);
    expect(reversed.json().error).toContain("before");
    expect(pool.statusCode).toBe(400);
  });

  it("returns configuration and time-series data", async () => {
    const db = database();
    db.setMeta("initialized_at", "1000");
    db.insertUsageEvent(event("sol", 1_100));
    const server = app(db);
    const config = await server.inject({ method: "GET", url: "/api/config" });
    const series = await server.inject({ method: "GET", url: "/api/timeseries?from=1000&to=2000&bucketMs=500" });
    expect(config.json()).toMatchObject({ refreshIntervalMs: 2_000, installedAt: 1_000 });
    expect(config.json().pricing["gpt-5.6-sol"]).toBeTruthy();
    expect(series.json().usage[0]).toMatchObject({ at: 1_000, tokens: 110 });
  });
});
