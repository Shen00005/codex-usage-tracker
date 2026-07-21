export type UsagePool = "standard" | "spark" | "other";

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface UsageEvent extends TokenUsage {
  eventKey: string;
  occurredAt: number;
  sessionId: string | null;
  model: string;
  sourceSurface: string | null;
  contextWindow: number | null;
  longContext: boolean;
  pool: UsagePool;
  costNanoUsd: number | null;
}

export interface QuotaSnapshot {
  eventKey: string;
  occurredAt: number;
  limitId: string;
  usedPercent: number;
  remainingPercent: number;
  windowMinutes: number;
  resetsAt: number;
  planType: string | null;
  model: string;
  pool: UsagePool;
  baseline: boolean;
}

export interface FileCursor {
  sourcePath: string;
  byteOffset: number;
  sessionId: string | null;
  model: string | null;
  sourceSurface: string | null;
  updatedAt: number;
}

export interface PricedUsage {
  priced: boolean;
  longContext: boolean;
  uncachedInputTokens: number;
  costNanoUsd: number | null;
}

export interface CollectorStatus {
  state: "initializing" | "watching" | "stopped" | "error";
  lastScanAt: number | null;
  lastEventAt: number | null;
  lastError: string | null;
  watchedFiles: number;
}
