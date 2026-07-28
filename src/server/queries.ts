import type { QuotaSnapshot, ServiceTier, UsageEvent, UsagePool } from "../shared/domain.js";
import type { UsageDatabase } from "./database.js";

export type PoolFilter = UsagePool | "all";
const RESET_JITTER_TOLERANCE_MS = 5 * 60 * 1_000;
export const SPEED_CREDIT_MULTIPLIER = 2.5;

export interface UsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  creditWeightedTokens: number;
  costNanoUsd: number;
  requestCount: number;
  longContextRequests: number;
  unpricedRequests: number;
}

export interface ModelSummary extends UsageTotals {
  model: string;
  pool: UsagePool;
  serviceTier: ServiceTier;
}

export interface ServiceTierSummary extends UsageTotals {
  serviceTier: ServiceTier;
}

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    creditWeightedTokens: 0,
    costNanoUsd: 0,
    requestCount: 0,
    longContextRequests: 0,
    unpricedRequests: 0
  };
}

function addEvent(target: UsageTotals, event: UsageEvent): void {
  target.inputTokens += event.inputTokens;
  target.cachedInputTokens += event.cachedInputTokens;
  target.cacheWriteInputTokens += event.cacheWriteInputTokens;
  target.uncachedInputTokens += Math.max(0, event.inputTokens - event.cachedInputTokens - event.cacheWriteInputTokens);
  target.outputTokens += event.outputTokens;
  target.reasoningOutputTokens += event.reasoningOutputTokens;
  const totalTokens = event.inputTokens + event.outputTokens;
  target.totalTokens += totalTokens;
  target.creditWeightedTokens += totalTokens * (event.serviceTier === "priority" ? SPEED_CREDIT_MULTIPLIER : 1);
  target.costNanoUsd += event.costNanoUsd ?? 0;
  target.requestCount += 1;
  target.longContextRequests += event.longContext ? 1 : 0;
  target.unpricedRequests += event.costNanoUsd === null ? 1 : 0;
}

function summarizeQuota(snapshots: QuotaSnapshot[], from: number) {
  if (snapshots.length === 0) {
    return {
      startRemainingPercent: null,
      endRemainingPercent: null,
      percentagePointsConsumed: null,
      resetsAt: null,
      resets: [] as Array<{ at: number; resetsAt: number }>,
      observations: 0
    };
  }

  const groups: QuotaSnapshot[][] = [];
  for (const snapshot of [...snapshots].sort((a, b) => a.occurredAt - b.occurredAt)) {
    const current = groups.at(-1);
    const previousReset = current?.at(-1)?.resetsAt;
    if (previousReset === undefined || Math.abs(snapshot.resetsAt - previousReset) > RESET_JITTER_TOLERANCE_MS) {
      groups.push([snapshot]);
    } else {
      current!.push(snapshot);
    }
  }

  const activeGroups = groups
    .filter((group) => group.some((snapshot) => snapshot.occurredAt >= from))
    .sort((a, b) => a[0].occurredAt - b[0].occurredAt);

  if (activeGroups.length === 0) {
    const latest = snapshots.at(-1)!;
    return {
      startRemainingPercent: latest.remainingPercent,
      endRemainingPercent: latest.remainingPercent,
      percentagePointsConsumed: 0,
      resetsAt: latest.resetsAt,
      resets: [],
      observations: snapshots.length
    };
  }

  let consumed = 0;
  const normalized: Array<{ first: QuotaSnapshot; lastUsed: number; resetsAt: number }> = [];
  for (const group of activeGroups) {
    const ordered = [...group].sort((a, b) => a.occurredAt - b.occurredAt);
    const prior = ordered.filter((snapshot) => snapshot.occurredAt <= from).at(-1);
    const inside = ordered.filter((snapshot) => snapshot.occurredAt >= from);
    const first = prior ?? inside[0];
    const lastUsed = Math.max(first.usedPercent, ...inside.map((snapshot) => snapshot.usedPercent));
    consumed += Math.max(0, lastUsed - first.usedPercent);
    normalized.push({ first, lastUsed, resetsAt: ordered.at(-1)!.resetsAt });
  }

  const first = normalized[0];
  const last = normalized.at(-1)!;
  return {
    startRemainingPercent: 100 - first.first.usedPercent,
    endRemainingPercent: 100 - last.lastUsed,
    percentagePointsConsumed: consumed,
    resetsAt: last.resetsAt,
    resets: normalized.slice(1).map((entry) => ({ at: entry.first.occurredAt, resetsAt: entry.resetsAt })),
    observations: snapshots.length
  };
}

function primaryQuotaSnapshots(snapshots: QuotaSnapshot[], pool: PoolFilter): QuotaSnapshot[] {
  return snapshots.filter((snapshot) => {
    if (snapshot.limitId !== "codex") return false;
    return pool === "all" ? snapshot.pool === "standard" : true;
  });
}

export function getSummary(database: UsageDatabase, from: number, to: number, pool: PoolFilter) {
  const events = database.listUsageEvents(from, to, pool);
  const totals = emptyTotals();
  const byModel = new Map<string, ModelSummary>();
  const byServiceTier = new Map<ServiceTier, ServiceTierSummary>();
  for (const event of events) {
    addEvent(totals, event);
    let tier = byServiceTier.get(event.serviceTier);
    if (!tier) {
      tier = { serviceTier: event.serviceTier, ...emptyTotals() };
      byServiceTier.set(event.serviceTier, tier);
    }
    addEvent(tier, event);
    const key = `${event.pool}:${event.model}:${event.serviceTier}`;
    let model = byModel.get(key);
    if (!model) {
      model = { model: event.model, pool: event.pool, serviceTier: event.serviceTier, ...emptyTotals() };
      byModel.set(key, model);
    }
    addEvent(model, event);
  }

  const quotaSnapshots = primaryQuotaSnapshots(database.listQuotaSnapshots(to, pool), pool);
  return {
    from,
    to,
    pool,
    totals,
    models: [...byModel.values()].sort((a, b) => b.costNanoUsd - a.costNanoUsd || a.model.localeCompare(b.model)),
    serviceTiers: [...byServiceTier.values()].sort((a, b) => {
      const order: Record<ServiceTier, number> = { priority: 0, default: 1, unknown: 2 };
      return order[a.serviceTier] - order[b.serviceTier];
    }),
    quota: summarizeQuota(quotaSnapshots, from)
  };
}

export function getTimeseries(
  database: UsageDatabase,
  from: number,
  to: number,
  pool: PoolFilter,
  requestedBucketMs?: number
) {
  const span = Math.max(1, to - from);
  const bucketMs = requestedBucketMs ?? Math.max(1_000, Math.ceil(span / 180));
  const events = database.listUsageEvents(from, to, pool);
  const buckets = new Map<number, { tokens: number; costNanoUsd: number }>();
  for (const event of events) {
    const at = from + Math.floor((event.occurredAt - from) / bucketMs) * bucketMs;
    const bucket = buckets.get(at) ?? { tokens: 0, costNanoUsd: 0 };
    bucket.tokens += event.inputTokens + event.outputTokens;
    bucket.costNanoUsd += event.costNanoUsd ?? 0;
    buckets.set(at, bucket);
  }

  let tokens = 0;
  let costNanoUsd = 0;
  const usage = [...buckets.entries()].sort(([a], [b]) => a - b).map(([at, bucket]) => {
    tokens += bucket.tokens;
    costNanoUsd += bucket.costNanoUsd;
    return { at, tokens, costNanoUsd };
  });

  const quota = primaryQuotaSnapshots(database.listQuotaSnapshots(to, pool), pool)
    .filter((snapshot) => snapshot.occurredAt >= from)
    .map((snapshot) => ({
      at: snapshot.occurredAt,
      remainingPercent: snapshot.remainingPercent,
      usedPercent: snapshot.usedPercent,
      resetsAt: snapshot.resetsAt
    }));

  return { from, to, pool, bucketMs, usage, quota };
}
