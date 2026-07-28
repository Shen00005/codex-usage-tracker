import type { QuotaSnapshot, ServiceTier, UsageEvent } from "../shared/domain.js";
import { poolForModel, priceUsage } from "../shared/pricing.js";

export interface ParserState {
  sessionId: string | null;
  model: string | null;
  sourceSurface: string | null;
  serviceTier: ServiceTier;
}

export interface SourcePosition {
  sourcePath: string;
  byteOffset: number;
}

export interface ParseResult {
  state: ParserState;
  usageEvent: UsageEvent | null;
  quotaSnapshot: QuotaSnapshot | null;
}

export function initialParserState(): ParserState {
  return { sessionId: null, model: null, sourceSurface: null, serviceTier: "unknown" };
}

function eventKey(source: SourcePosition, suffix = "usage"): string {
  const normalized = source.sourcePath.replaceAll("\\", "/").toLowerCase();
  return `${normalized}:${source.byteOffset}:${suffix}`;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseCodexLine(line: string, state: ParserState, source: SourcePosition): ParseResult {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { state, usageEvent: null, quotaSnapshot: null };
  }

  const type = envelope.type;
  const payload = envelope.payload as Record<string, unknown> | undefined;
  if (!payload) return { state, usageEvent: null, quotaSnapshot: null };

  if (type === "session_meta") {
    return {
      state: {
        sessionId: stringOrNull(payload.id) ?? stringOrNull(payload.session_id) ?? state.sessionId,
        model: state.model,
        sourceSurface: stringOrNull(payload.originator) ?? stringOrNull(payload.source) ?? state.sourceSurface,
        serviceTier: state.serviceTier
      },
      usageEvent: null,
      quotaSnapshot: null
    };
  }

  if (type === "turn_context") {
    return {
      state: { ...state, model: stringOrNull(payload.model) ?? state.model },
      usageEvent: null,
      quotaSnapshot: null
    };
  }

  if (type === "event_msg" && payload.type === "thread_settings_applied") {
    const settings = payload.thread_settings as Record<string, unknown> | undefined;
    const rawTier = stringOrNull(settings?.service_tier);
    const serviceTier: ServiceTier = rawTier === "priority" ? "priority" : rawTier === "default" ? "default" : state.serviceTier;
    return {
      state: { ...state, serviceTier },
      usageEvent: null,
      quotaSnapshot: null
    };
  }

  if (type !== "event_msg" || payload.type !== "token_count") {
    return { state, usageEvent: null, quotaSnapshot: null };
  }

  const occurredAt = Date.parse(String(envelope.timestamp ?? ""));
  if (!Number.isFinite(occurredAt)) return { state, usageEvent: null, quotaSnapshot: null };

  const model = state.model ?? "unknown";
  const pool = poolForModel(model);
  const info = payload.info as Record<string, unknown> | undefined;
  const rawUsage = info?.last_token_usage as Record<string, unknown> | undefined;
  let usageEvent: UsageEvent | null = null;

  if (rawUsage) {
    const tokenUsage = {
      inputTokens: finiteNumber(rawUsage.input_tokens),
      cachedInputTokens: finiteNumber(rawUsage.cached_input_tokens),
      cacheWriteInputTokens: finiteNumber(rawUsage.cache_write_input_tokens),
      outputTokens: finiteNumber(rawUsage.output_tokens),
      reasoningOutputTokens: finiteNumber(rawUsage.reasoning_output_tokens)
    };
    const priced = priceUsage(model, tokenUsage);
    usageEvent = {
      eventKey: eventKey(source),
      occurredAt,
      sessionId: state.sessionId,
      model,
      sourceSurface: state.sourceSurface,
      serviceTier: state.serviceTier,
      ...tokenUsage,
      contextWindow: info && typeof info.model_context_window === "number" ? info.model_context_window : null,
      longContext: priced.longContext,
      pool,
      costNanoUsd: priced.costNanoUsd
    };
  }

  const rateLimits = payload.rate_limits as Record<string, unknown> | undefined;
  const primary = rateLimits?.primary as Record<string, unknown> | undefined;
  const usedPercent = primary?.used_percent;
  const windowMinutes = primary?.window_minutes;
  const resetsAtSeconds = primary?.resets_at;
  let quotaSnapshot: QuotaSnapshot | null = null;

  if (
    typeof usedPercent === "number" && Number.isFinite(usedPercent) &&
    typeof windowMinutes === "number" && Number.isFinite(windowMinutes) &&
    typeof resetsAtSeconds === "number" && Number.isFinite(resetsAtSeconds)
  ) {
    quotaSnapshot = {
      eventKey: eventKey(source, "quota"),
      occurredAt,
      limitId: stringOrNull(rateLimits?.limit_id) ?? "codex",
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      windowMinutes,
      resetsAt: resetsAtSeconds * 1_000,
      planType: stringOrNull(rateLimits?.plan_type),
      model,
      pool,
      baseline: false
    };
  }

  return { state, usageEvent, quotaSnapshot };
}
