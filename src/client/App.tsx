import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { PoolFilter } from "../server/queries.js";
import { httpUsageApi, type HealthResponse, type SummaryResponse, type TimeseriesResponse, type UsageApi } from "./api.js";
import { localInputToUtc, resolveRange, utcToLocalInput, type RangePreset, type RangeSelection } from "./range.js";

interface AppProps {
  apiClient?: UsageApi;
  now?: () => number;
}

const PRESETS: Array<{ value: RangePreset; label: string }> = [
  { value: "1h", label: "Past hour" },
  { value: "6h", label: "6 hours" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" }
];

const number = new Intl.NumberFormat("en-US");
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

function formatUsd(nanoUsd: number): string {
  return `$${(nanoUsd / 1_000_000_000).toFixed(8)}`;
}

function formatLag(lagMs: number | null): string {
  if (lagMs === null) return "Waiting for first event";
  if (lagMs < 1_000) return `${number.format(lagMs)} ms behind`;
  return `${(lagMs / 1_000).toFixed(1)} s behind`;
}

function chartData(series: TimeseriesResponse | null) {
  if (!series) return [];
  const points = new Map<number, { at: number; tokens?: number; cost?: number; remaining?: number }>();
  for (const point of series.usage) {
    points.set(point.at, { at: point.at, tokens: point.tokens, cost: point.costNanoUsd / 1_000_000_000 });
  }
  for (const point of series.quota) {
    const existing = points.get(point.at) ?? { at: point.at };
    existing.remaining = point.remainingPercent;
    points.set(point.at, existing);
  }
  let tokens = 0;
  let cost = 0;
  let remaining: number | undefined;
  return [...points.values()].sort((a, b) => a.at - b.at).map((point) => {
    tokens = point.tokens ?? tokens;
    cost = point.cost ?? cost;
    remaining = point.remaining ?? remaining;
    return { ...point, tokens, cost, remaining };
  });
}

export function App({ apiClient = httpUsageApi, now = Date.now }: AppProps) {
  const [selection, setSelection] = useState<RangeSelection>({ mode: "preset", preset: "1h" });
  const [pool, setPool] = useState<PoolFilter>("standard");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [series, setSeries] = useState<TimeseriesResponse | null>(null);
  const [refreshMs, setRefreshMs] = useState(2_000);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [displayRange, setDisplayRange] = useState(() => resolveRange(selection, now()));

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const range = resolveRange(selection, now());
    setDisplayRange(range);
    setRefreshing(true);
    try {
      const [nextHealth, nextSummary, nextSeries] = await Promise.all([
        apiClient.getHealth(signal),
        apiClient.getSummary(range.from, range.to, pool, signal),
        apiClient.getTimeseries(range.from, range.to, pool, signal)
      ]);
      setHealth(nextHealth);
      setSummary(nextSummary);
      setSeries(nextSeries);
      setError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  }, [apiClient, now, pool, selection]);

  useEffect(() => {
    const controller = new AbortController();
    void apiClient.getConfig(controller.signal).then((config) => setRefreshMs(config.refreshIntervalMs)).catch(() => undefined);
    return () => controller.abort();
  }, [apiClient]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(), refreshMs);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh, refreshMs]);

  const plotted = useMemo(() => chartData(series), [series]);
  const quota = summary?.quota;
  const remaining = quota?.endRemainingPercent ?? null;
  const quotaStyle = { "--quota-position": `${remaining ?? 0}%` } as CSSProperties;

  const setCustomBoundary = (side: "from" | "to", value: string) => {
    const timestamp = localInputToUtc(value);
    if (!Number.isFinite(timestamp)) return;
    setSelection({
      mode: "custom",
      from: side === "from" ? timestamp : displayRange.from,
      to: side === "to" ? timestamp : displayRange.to
    });
  };

  return (
    <main className="console-shell">
      <header className="masthead">
        <div className="identity">
          <span className="wordmark-mark" aria-hidden="true">C/</span>
          <div>
            <p className="eyebrow">Local Codex telemetry</p>
            <h1>Usage reference</h1>
          </div>
        </div>
        <div className={`live-state live-state--${health?.collector.state ?? "initializing"}`}>
          <span className="live-pulse" aria-hidden="true" />
          <div>
            <strong>{health?.collector.state === "watching" ? "Live collector" : "Connecting"}</strong>
            <span>{health ? formatLag(health.lagMs) : "Reading local sessions"}</span>
          </div>
        </div>
      </header>

      <section className="quota-ruler" style={quotaStyle} aria-label="Weekly usage remaining">
        <div className="quota-ruler__heading">
          <span>Weekly pool remaining</span>
          <strong>{remaining === null ? "—" : `${remaining.toFixed(1)}%`}</strong>
        </div>
        <div className="quota-track"><span className="quota-fill" /><i className="quota-needle" /></div>
        <div className="quota-scale"><span>0</span><span>25</span><span>50</span><span>75</span><span>100%</span></div>
        <div className="quota-meta">
          <span>{quota?.percentagePointsConsumed === null || quota?.percentagePointsConsumed === undefined ? "No movement yet" : `${quota.percentagePointsConsumed.toFixed(1)} pp consumed in range`}</span>
          <span>{quota?.resetsAt ? `Reset ${dateTime.format(quota.resetsAt)}` : "Reset time not observed"}</span>
        </div>
      </section>

      <section className="range-console" aria-label="Usage range">
        <div className="preset-bank" role="group" aria-label="Quick ranges">
          {PRESETS.map((preset) => (
            <button
              type="button"
              key={preset.value}
              className={selection.mode === "preset" && selection.preset === preset.value ? "is-active" : ""}
              onClick={() => setSelection({ mode: "preset", preset: preset.value })}
            >{preset.label}</button>
          ))}
        </div>
        <label>From<input type="datetime-local" value={utcToLocalInput(displayRange.from)} onChange={(event) => setCustomBoundary("from", event.target.value)} /></label>
        <span className="range-arrow" aria-hidden="true">→</span>
        <label>To<input type="datetime-local" value={utcToLocalInput(displayRange.to)} onChange={(event) => setCustomBoundary("to", event.target.value)} /></label>
        <label>Usage pool<select aria-label="Usage pool" value={pool} onChange={(event) => setPool(event.target.value as PoolFilter)}>
          <option value="standard">Sol / Terra / Luna</option>
          <option value="spark">Spark</option>
          <option value="all">All pools</option>
        </select></label>
        <button type="button" className="refresh-button" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? "Reading…" : "Refresh now"}
        </button>
      </section>

      {error && <div className="error-strip" role="alert"><strong>Collector error</strong><span>{error}</span></div>}

      <section className="metric-strip" aria-label="Range totals">
        <article><span>API equivalent</span><strong>{summary ? formatUsd(summary.totals.costNanoUsd) : "—"}</strong><small>{summary?.totals.unpricedRequests ? `${summary.totals.unpricedRequests} unpriced requests` : "Exact priced requests"}</small></article>
        <article><span>Total tokens</span><strong>{summary ? number.format(summary.totals.totalTokens) : "—"}</strong><small>{summary ? `${number.format(summary.totals.requestCount)} responses` : "No events yet"}</small></article>
        <article><span>Remaining</span><strong>{remaining === null ? "—" : `${remaining.toFixed(1)}%`}</strong><small>Codex-reported precision</small></article>
        <article><span>Consumed</span><strong>{quota?.percentagePointsConsumed === null || quota?.percentagePointsConsumed === undefined ? "—" : `${quota.percentagePointsConsumed.toFixed(1)} pp`}</strong><small>{quota?.resets.length ? `${quota.resets.length} reset boundary` : "Reset-safe delta"}</small></article>
      </section>

      <section className="workbench">
        <article className="chart-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">Time-aligned record</p><h2>Usage trace</h2></div>
            <span>{dateTime.format(displayRange.from)} — {dateTime.format(displayRange.to)}</span>
          </div>
          <div className="chart-frame">
            {plotted.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={plotted} margin={{ top: 12, right: 12, bottom: 4, left: 4 }}>
                  <CartesianGrid stroke="#273044" strokeDasharray="2 5" vertical={false} />
                  <XAxis dataKey="at" type="number" domain={[displayRange.from, displayRange.to]} tickFormatter={(value) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} stroke="#748198" tick={{ fontSize: 10 }} />
                  <YAxis yAxisId="tokens" tickFormatter={(value) => `${(value / 1_000_000).toFixed(1)}M`} stroke="#748198" tick={{ fontSize: 10 }} />
                  <YAxis yAxisId="quota" orientation="right" domain={[0, 100]} stroke="#f5a95b" tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: "#111827", border: "1px solid #344057", borderRadius: 2 }} labelFormatter={(value) => dateTime.format(Number(value))} />
                  <Area yAxisId="tokens" type="stepAfter" dataKey="tokens" stroke="#55d6e8" fill="#55d6e822" strokeWidth={2} isAnimationActive={false} />
                  <Line yAxisId="quota" type="stepAfter" dataKey="remaining" stroke="#f5a95b" dot={false} connectNulls strokeWidth={1.5} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            ) : <div className="empty-trace"><span>∿</span><p>No token events in this range.</p></div>}
          </div>
          <div className="chart-legend"><span className="legend-cyan">Cumulative tokens</span><span className="legend-amber">Weekly remaining</span></div>
        </article>

        <article className="ledger-panel">
          <div className="panel-heading"><div><p className="eyebrow">Per-model accounting</p><h2>Model ledger</h2></div><span>{summary?.models.length ?? 0} active</span></div>
          <div className="ledger-scroll">
            <table>
              <thead><tr><th>Model</th><th>Input</th><th>Cached</th><th>Writes</th><th>Output</th><th>API eq.</th></tr></thead>
              <tbody>
                {summary?.models.map((model) => (
                  <tr key={`${model.pool}:${model.model}`}>
                    <td><strong>{model.model}</strong><span className={`pool-tag pool-tag--${model.pool}`}>{model.pool}</span></td>
                    <td>{number.format(model.inputTokens)}</td>
                    <td>{number.format(model.cachedInputTokens)}</td>
                    <td>{number.format(model.cacheWriteInputTokens)}</td>
                    <td>{number.format(model.outputTokens)}</td>
                    <td>{model.unpricedRequests === model.requestCount ? "Unpriced" : formatUsd(model.costNanoUsd)}</td>
                  </tr>
                ))}
                {!summary?.models.length && <tr><td colSpan={6} className="empty-cell">No model activity in this range.</td></tr>}
              </tbody>
            </table>
          </div>
        </article>
      </section>

      <footer>
        <span>Local only · prompts are never collected</span>
        <span>{health?.collector.lastEventAt ? `Last event ${dateTime.format(health.collector.lastEventAt)}` : "Waiting for a Codex event"}</span>
      </footer>
    </main>
  );
}
