import type { CollectorStatus, UsagePool } from "../shared/domain.js";
import type { ModelSummary, PoolFilter, UsageTotals } from "../server/queries.js";

export interface HealthResponse {
  collector: CollectorStatus;
  now: number;
  lagMs: number | null;
}

export interface ConfigResponse {
  refreshIntervalMs: number;
  installedAt: number | null;
  pricing: Record<string, unknown>;
  pools: string[];
}

export interface SummaryResponse {
  from: number;
  to: number;
  pool: PoolFilter;
  totals: UsageTotals;
  models: ModelSummary[];
  quota: {
    startRemainingPercent: number | null;
    endRemainingPercent: number | null;
    percentagePointsConsumed: number | null;
    resetsAt: number | null;
    resets: Array<{ at: number; resetsAt: number }>;
    observations: number;
  };
}

export interface TimeseriesResponse {
  from: number;
  to: number;
  pool: PoolFilter;
  bucketMs: number;
  usage: Array<{ at: number; tokens: number; costNanoUsd: number }>;
  quota: Array<{ at: number; remainingPercent: number; usedPercent: number; resetsAt: number }>;
}

export interface UsageApi {
  getHealth(signal?: AbortSignal): Promise<HealthResponse>;
  getConfig(signal?: AbortSignal): Promise<ConfigResponse>;
  getSummary(from: number, to: number, pool: PoolFilter, signal?: AbortSignal): Promise<SummaryResponse>;
  getTimeseries(from: number, to: number, pool: PoolFilter, signal?: AbortSignal): Promise<TimeseriesResponse>;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`);
  return body;
}

function rangeQuery(from: number, to: number, pool: PoolFilter): string {
  const query = new URLSearchParams({
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    pool
  });
  return query.toString();
}

export const httpUsageApi: UsageApi = {
  getHealth: (signal) => getJson("/api/health", signal),
  getConfig: (signal) => getJson("/api/config", signal),
  getSummary: (from, to, pool, signal) => getJson(`/api/summary?${rangeQuery(from, to, pool)}`, signal),
  getTimeseries: (from, to, pool, signal) => getJson(`/api/timeseries?${rangeQuery(from, to, pool)}`, signal)
};
