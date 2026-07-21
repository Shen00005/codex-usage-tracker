import { afterEach, describe, expect, it } from "vitest";
import { UsageDatabase } from "../src/server/database.js";
import type { QuotaSnapshot, UsageEvent } from "../src/shared/domain.js";

const open: UsageDatabase[] = [];

function database(): UsageDatabase {
  const db = new UsageDatabase(":memory:");
  open.push(db);
  return db;
}

function usageEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    eventKey: "session.jsonl:100",
    occurredAt: 1_000,
    sessionId: "session-1",
    model: "gpt-5.6-sol",
    sourceSurface: "Codex Desktop",
    inputTokens: 100,
    cachedInputTokens: 40,
    cacheWriteInputTokens: 10,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    contextWindow: 1_050_000,
    longContext: false,
    pool: "standard",
    costNanoUsd: 950_000,
    ...overrides
  };
}

function quotaSnapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    eventKey: "session.jsonl:100:quota",
    occurredAt: 1_000,
    limitId: "codex",
    usedPercent: 1.2,
    remainingPercent: 98.8,
    windowMinutes: 10_080,
    resetsAt: 700_000,
    planType: "pro",
    model: "gpt-5.6-sol",
    pool: "standard",
    baseline: false,
    ...overrides
  };
}

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

describe("UsageDatabase", () => {
  it("deduplicates usage and quota events by event key", () => {
    const db = database();
    expect(db.insertUsageEvent(usageEvent())).toBe(true);
    expect(db.insertUsageEvent(usageEvent())).toBe(false);
    expect(db.insertQuotaSnapshot(quotaSnapshot())).toBe(true);
    expect(db.insertQuotaSnapshot(quotaSnapshot())).toBe(false);
    expect(db.countUsageEvents()).toBe(1);
    expect(db.countQuotaSnapshots()).toBe(1);
  });

  it("persists parser state in file cursors", () => {
    const db = database();
    db.upsertCursor({
      sourcePath: "C:\\sessions\\a.jsonl",
      byteOffset: 912,
      sessionId: "s1",
      model: "gpt-5.6-luna",
      sourceSurface: "vscode",
      updatedAt: 5_000
    });

    expect(db.getCursor("C:\\sessions\\a.jsonl")).toEqual({
      sourcePath: "C:\\sessions\\a.jsonl",
      byteOffset: 912,
      sessionId: "s1",
      model: "gpt-5.6-luna",
      sourceSurface: "vscode",
      updatedAt: 5_000
    });
  });

  it("stores application metadata", () => {
    const db = database();
    expect(db.getMeta("initialized")).toBeNull();
    db.setMeta("initialized", "1700");
    expect(db.getMeta("initialized")).toBe("1700");
  });
});

export { database, quotaSnapshot, usageEvent };
