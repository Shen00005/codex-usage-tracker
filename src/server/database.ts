import { DatabaseSync } from "node:sqlite";
import type { FileCursor, QuotaSnapshot, UsageEvent, UsagePool } from "../shared/domain.js";

type DatabaseValue = string | number | bigint | null;

function asNumber(value: DatabaseValue | undefined): number {
  return Number(value ?? 0);
}

function asNullableString(value: DatabaseValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

export class UsageDatabase {
  readonly connection: DatabaseSync;

  constructor(path: string) {
    this.connection = new DatabaseSync(path);
    this.connection.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_cursors (
        source_path TEXT PRIMARY KEY,
        byte_offset INTEGER NOT NULL,
        session_id TEXT,
        model TEXT,
        source_surface TEXT,
        service_tier TEXT NOT NULL DEFAULT 'unknown',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_events (
        event_key TEXT PRIMARY KEY,
        occurred_at INTEGER NOT NULL,
        session_id TEXT,
        model TEXT NOT NULL,
        source_surface TEXT,
        service_tier TEXT NOT NULL DEFAULT 'unknown',
        input_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL,
        cache_write_input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        reasoning_output_tokens INTEGER NOT NULL,
        context_window INTEGER,
        long_context INTEGER NOT NULL,
        pool TEXT NOT NULL,
        cost_nano_usd INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_usage_range ON usage_events(occurred_at, pool);
      CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_events(model, occurred_at);

      CREATE TABLE IF NOT EXISTS quota_snapshots (
        event_key TEXT PRIMARY KEY,
        occurred_at INTEGER NOT NULL,
        limit_id TEXT NOT NULL,
        used_percent REAL NOT NULL,
        remaining_percent REAL NOT NULL,
        window_minutes INTEGER NOT NULL,
        resets_at INTEGER NOT NULL,
        plan_type TEXT,
        model TEXT NOT NULL,
        pool TEXT NOT NULL,
        baseline INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_quota_range ON quota_snapshots(occurred_at, pool);
    `);

    const cursorColumns = this.connection.prepare("PRAGMA table_info(file_cursors)").all() as Array<{ name: string }>;
    if (!cursorColumns.some((column) => column.name === "service_tier")) {
      this.connection.exec("ALTER TABLE file_cursors ADD COLUMN service_tier TEXT NOT NULL DEFAULT 'unknown'");
    }
    const usageColumns = this.connection.prepare("PRAGMA table_info(usage_events)").all() as Array<{ name: string }>;
    if (!usageColumns.some((column) => column.name === "service_tier")) {
      this.connection.exec("ALTER TABLE usage_events ADD COLUMN service_tier TEXT NOT NULL DEFAULT 'unknown'");
    }

    if (this.getMeta("speed_replay_v1") === null) {
      this.connection.exec(`
        UPDATE file_cursors
        SET byte_offset = 0, session_id = NULL, model = NULL,
            source_surface = NULL, service_tier = 'unknown'
      `);
      this.setMeta("speed_replay_v1", String(Date.now()));
    }
  }

  close(): void {
    this.connection.close();
  }

  setMeta(key: string, value: string): void {
    this.connection.prepare(`
      INSERT INTO app_meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.connection.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  upsertCursor(cursor: FileCursor): void {
    this.connection.prepare(`
      INSERT INTO file_cursors(source_path, byte_offset, session_id, model, source_surface, service_tier, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_path) DO UPDATE SET
        byte_offset = excluded.byte_offset,
        session_id = excluded.session_id,
        model = excluded.model,
        source_surface = excluded.source_surface,
        service_tier = excluded.service_tier,
        updated_at = excluded.updated_at
    `).run(
      cursor.sourcePath,
      cursor.byteOffset,
      cursor.sessionId,
      cursor.model,
      cursor.sourceSurface,
      cursor.serviceTier,
      cursor.updatedAt
    );
  }

  getCursor(sourcePath: string): FileCursor | null {
    const row = this.connection.prepare("SELECT * FROM file_cursors WHERE source_path = ?").get(sourcePath) as
      | Record<string, DatabaseValue>
      | undefined;
    if (!row) return null;
    return {
      sourcePath: String(row.source_path),
      byteOffset: asNumber(row.byte_offset),
      sessionId: asNullableString(row.session_id),
      model: asNullableString(row.model),
      sourceSurface: asNullableString(row.source_surface),
      serviceTier: String(row.service_tier ?? "unknown") as FileCursor["serviceTier"],
      updatedAt: asNumber(row.updated_at)
    };
  }

  listCursors(): FileCursor[] {
    const rows = this.connection.prepare("SELECT source_path FROM file_cursors").all() as Array<{ source_path: string }>;
    return rows.map((row) => this.getCursor(row.source_path)).filter((row): row is FileCursor => row !== null);
  }

  insertUsageEvent(event: UsageEvent): boolean {
    const result = this.connection.prepare(`
      INSERT OR IGNORE INTO usage_events(
        event_key, occurred_at, session_id, model, source_surface, service_tier,
        input_tokens, cached_input_tokens, cache_write_input_tokens,
        output_tokens, reasoning_output_tokens, context_window,
        long_context, pool, cost_nano_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_key) DO UPDATE SET service_tier = excluded.service_tier
      WHERE usage_events.service_tier <> excluded.service_tier
    `).run(
      event.eventKey,
      event.occurredAt,
      event.sessionId,
      event.model,
      event.sourceSurface,
      event.serviceTier,
      event.inputTokens,
      event.cachedInputTokens,
      event.cacheWriteInputTokens,
      event.outputTokens,
      event.reasoningOutputTokens,
      event.contextWindow,
      event.longContext ? 1 : 0,
      event.pool,
      event.costNanoUsd
    );
    return Number(result.changes) === 1;
  }

  insertQuotaSnapshot(snapshot: QuotaSnapshot): boolean {
    const result = this.connection.prepare(`
      INSERT OR IGNORE INTO quota_snapshots(
        event_key, occurred_at, limit_id, used_percent, remaining_percent,
        window_minutes, resets_at, plan_type, model, pool, baseline
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.eventKey,
      snapshot.occurredAt,
      snapshot.limitId,
      snapshot.usedPercent,
      snapshot.remainingPercent,
      snapshot.windowMinutes,
      snapshot.resetsAt,
      snapshot.planType,
      snapshot.model,
      snapshot.pool,
      snapshot.baseline ? 1 : 0
    );
    return Number(result.changes) === 1;
  }

  countUsageEvents(): number {
    const row = this.connection.prepare("SELECT COUNT(*) AS count FROM usage_events").get() as { count: number };
    return Number(row.count);
  }

  countQuotaSnapshots(): number {
    const row = this.connection.prepare("SELECT COUNT(*) AS count FROM quota_snapshots").get() as { count: number };
    return Number(row.count);
  }

  listUsageEvents(from: number, to: number, pool: UsagePool | "all"): UsageEvent[] {
    const sql = pool === "all"
      ? "SELECT * FROM usage_events WHERE occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at, event_key"
      : "SELECT * FROM usage_events WHERE occurred_at >= ? AND occurred_at < ? AND pool = ? ORDER BY occurred_at, event_key";
    const rows = (pool === "all"
      ? this.connection.prepare(sql).all(from, to)
      : this.connection.prepare(sql).all(from, to, pool)) as Array<Record<string, DatabaseValue>>;
    return rows.map(mapUsageEvent);
  }

  listQuotaSnapshots(to: number, pool: UsagePool | "all"): QuotaSnapshot[] {
    const sql = pool === "all"
      ? "SELECT * FROM quota_snapshots WHERE occurred_at < ? ORDER BY occurred_at, event_key"
      : "SELECT * FROM quota_snapshots WHERE occurred_at < ? AND pool = ? ORDER BY occurred_at, event_key";
    const rows = (pool === "all"
      ? this.connection.prepare(sql).all(to)
      : this.connection.prepare(sql).all(to, pool)) as Array<Record<string, DatabaseValue>>;
    return rows.map(mapQuotaSnapshot);
  }

  getLatestEventAt(): number | null {
    const row = this.connection.prepare(`
      SELECT MAX(occurred_at) AS occurred_at FROM (
        SELECT occurred_at FROM usage_events UNION ALL SELECT occurred_at FROM quota_snapshots
      )
    `).get() as { occurred_at: number | null };
    return row.occurred_at === null ? null : Number(row.occurred_at);
  }
}

function mapUsageEvent(row: Record<string, DatabaseValue>): UsageEvent {
  return {
    eventKey: String(row.event_key),
    occurredAt: asNumber(row.occurred_at),
    sessionId: asNullableString(row.session_id),
    model: String(row.model),
    sourceSurface: asNullableString(row.source_surface),
    serviceTier: String(row.service_tier ?? "unknown") as UsageEvent["serviceTier"],
    inputTokens: asNumber(row.input_tokens),
    cachedInputTokens: asNumber(row.cached_input_tokens),
    cacheWriteInputTokens: asNumber(row.cache_write_input_tokens),
    outputTokens: asNumber(row.output_tokens),
    reasoningOutputTokens: asNumber(row.reasoning_output_tokens),
    contextWindow: row.context_window === null ? null : asNumber(row.context_window),
    longContext: asNumber(row.long_context) === 1,
    pool: String(row.pool) as UsagePool,
    costNanoUsd: row.cost_nano_usd === null ? null : asNumber(row.cost_nano_usd)
  };
}

function mapQuotaSnapshot(row: Record<string, DatabaseValue>): QuotaSnapshot {
  return {
    eventKey: String(row.event_key),
    occurredAt: asNumber(row.occurred_at),
    limitId: String(row.limit_id),
    usedPercent: asNumber(row.used_percent),
    remainingPercent: asNumber(row.remaining_percent),
    windowMinutes: asNumber(row.window_minutes),
    resetsAt: asNumber(row.resets_at),
    planType: asNullableString(row.plan_type),
    model: String(row.model),
    pool: String(row.pool) as UsagePool,
    baseline: asNumber(row.baseline) === 1
  };
}
