import { appendFileSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageDatabase } from "../src/server/database.js";
import { SessionFollower } from "../src/server/session-follower.js";

const roots: string[] = [];
const databases: UsageDatabase[] = [];
const fixture = fileURLToPath(new URL("./fixtures/codex-session.jsonl", import.meta.url));

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "codex-usage-follower-"));
  roots.push(path);
  return path;
}

function database(path = ":memory:"): UsageDatabase {
  const db = new UsageDatabase(path);
  databases.push(db);
  return db;
}

function eventLine(timestamp: string, input = 100): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: 50,
          cache_write_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 2
        },
        model_context_window: 1_050_000
      },
      rate_limits: {
        limit_id: "codex",
        primary: { used_percent: 2.1, window_minutes: 10_080, resets_at: 1_800_000_000 },
        plan_type: "pro"
      }
    }
  });
}

afterEach(() => {
  vi.useRealTimers();
  databases.splice(0).forEach((db) => db.close());
  roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe("SessionFollower", () => {
  it("seeds file cursors and current quota baselines without historical usage", () => {
    const sessionRoot = root();
    const nested = join(sessionRoot, "2026", "07", "21");
    mkdirSync(nested, { recursive: true });
    const source = join(nested, basename(fixture));
    copyFileSync(fixture, source);
    const db = database();

    const follower = new SessionFollower(sessionRoot, db, { now: () => 2_000_000 });
    follower.scanNow();

    expect(db.countUsageEvents()).toBe(0);
    expect(db.countQuotaSnapshots()).toBe(2);
    expect(db.listQuotaSnapshots(Number.MAX_SAFE_INTEGER, "all").every((item) => item.baseline)).toBe(true);
    expect(db.getCursor(source)?.model).toBe("gpt-5.3-codex-spark");
    expect(db.getMeta("initialized_at")).toBe("2000000");
  });

  it("imports appended events and retains partial lines until complete", () => {
    const sessionRoot = root();
    const source = join(sessionRoot, "live.jsonl");
    writeFileSync(source, `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } })}\n`);
    const db = database();
    const follower = new SessionFollower(sessionRoot, db);
    follower.scanNow();
    const line = eventLine("2026-07-21T20:00:00.000Z");

    appendFileSync(source, line.slice(0, 80));
    follower.scanNow();
    expect(db.countUsageEvents()).toBe(0);

    appendFileSync(source, `${line.slice(80)}\n`);
    follower.scanNow();
    follower.scanNow();
    expect(db.countUsageEvents()).toBe(1);
  });

  it("reads a newly created session from byte zero after initialization", () => {
    const sessionRoot = root();
    const db = database();
    const follower = new SessionFollower(sessionRoot, db);
    follower.scanNow();
    const source = join(sessionRoot, "new.jsonl");
    writeFileSync(source, [
      JSON.stringify({ type: "session_meta", payload: { id: "new", source: "cli" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-luna" } }),
      eventLine("2026-07-21T20:01:00.000Z")
    ].join("\n") + "\n");

    follower.scanNow();
    expect(db.listUsageEvents(0, Number.MAX_SAFE_INTEGER, "all")[0]).toMatchObject({
      model: "gpt-5.6-luna",
      sessionId: "new",
      sourceSurface: "cli"
    });
  });

  it("catches up from persisted offsets after a restart", () => {
    const sessionRoot = root();
    const source = join(sessionRoot, "restart.jsonl");
    writeFileSync(source, `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } })}\n`);
    const sqlitePath = join(sessionRoot, "usage.sqlite");
    let db = database(sqlitePath);
    new SessionFollower(sessionRoot, db).scanNow();
    appendFileSync(source, `${eventLine("2026-07-21T20:02:00.000Z")}\n`);
    db.close();
    databases.splice(databases.indexOf(db), 1);

    db = database(sqlitePath);
    new SessionFollower(sessionRoot, db).scanNow();
    expect(db.countUsageEvents()).toBe(1);
  });

  it("scans on the configured two-second interval", () => {
    vi.useFakeTimers();
    const sessionRoot = root();
    const source = join(sessionRoot, "timer.jsonl");
    writeFileSync(source, `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } })}\n`);
    const db = database();
    const follower = new SessionFollower(sessionRoot, db, { intervalMs: 2_000 });
    follower.start();
    appendFileSync(source, `${eventLine("2026-07-21T20:03:00.000Z")}\n`);

    vi.advanceTimersByTime(1_999);
    expect(db.countUsageEvents()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(db.countUsageEvents()).toBe(1);
    follower.stop();
  });
});
