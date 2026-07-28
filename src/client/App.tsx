import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { SPEED_CREDIT_MULTIPLIER, type PoolFilter } from "../server/queries.js";
import { httpUsageApi, type HealthResponse, type SummaryResponse, type TimeseriesResponse, type UsageApi } from "./api.js";
import { localInputToUtc, resolveRange, utcToLocalInput, type RangePreset, type RangeSelection } from "./range.js";

interface AppProps {
  apiClient?: UsageApi;
  now?: () => number;
}

interface ChartPointerState {
  activeLabel?: string | number;
}

interface GraphSnapshot {
  schema: "codex-usage-graph/v1";
  exportedAt: number;
  summary: SummaryResponse;
  series: TimeseriesResponse;
}

function parseGraphSnapshot(value: unknown): GraphSnapshot {
  if (!value || typeof value !== "object") throw new Error("Snapshot must be a JSON object.");
  const snapshot = value as Partial<GraphSnapshot>;
  const summary = snapshot.summary as Partial<SummaryResponse> | undefined;
  const series = snapshot.series as Partial<TimeseriesResponse> | undefined;
  if (snapshot.schema !== "codex-usage-graph/v1") throw new Error("Unsupported graph snapshot format.");
  if (!summary || !series || !summary.totals || !summary.quota || !Array.isArray(summary.models) || !Array.isArray(summary.serviceTiers)) {
    throw new Error("Snapshot summary is incomplete.");
  }
  if (!Array.isArray(series.usage) || !Array.isArray(series.quota)) throw new Error("Snapshot graph data is incomplete.");
  if (![summary.from, summary.to, series.from, series.to, series.bucketMs].every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new Error("Snapshot contains invalid timestamps.");
  }
  if (summary.from! >= summary.to! || series.from! >= series.to!) throw new Error("Snapshot time range is invalid.");
  if (!(["standard", "spark", "all"] as string[]).includes(String(summary.pool)) || summary.pool !== series.pool) {
    throw new Error("Snapshot usage pool is invalid.");
  }
  return snapshot as GraphSnapshot;
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
  for (let at = series.from; at <= series.to; at += series.bucketMs) {
    points.set(at, { at });
  }
  if (!points.has(series.to)) points.set(series.to, { at: series.to });
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
  const [graphSelectEnabled, setGraphSelectEnabled] = useState(false);
  const [graphDrag, setGraphDrag] = useState<{ start: number; end: number } | null>(null);
  const [loadedGraph, setLoadedGraph] = useState<{ snapshot: GraphSnapshot; name: string } | null>(null);
  const loadInput = useRef<HTMLInputElement>(null);

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

  const shownSummary = loadedGraph?.snapshot.summary ?? summary;
  const shownSeries = loadedGraph?.snapshot.series ?? series;
  const shownRange = loadedGraph
    ? { from: loadedGraph.snapshot.summary.from, to: loadedGraph.snapshot.summary.to }
    : displayRange;
  const plotted = useMemo(() => chartData(shownSeries), [shownSeries]);
  const quota = shownSummary?.quota;
  const remaining = quota?.endRemainingPercent ?? null;
  const quotaStyle = { "--quota-position": `${remaining ?? 0}%` } as CSSProperties;
  const speed = shownSummary?.serviceTiers.find((tier) => tier.serviceTier === "priority");
  const unknownSpeed = shownSummary?.serviceTiers.find((tier) => tier.serviceTier === "unknown");

  const setCustomBoundary = (side: "from" | "to", value: string) => {
    const timestamp = localInputToUtc(value);
    if (!Number.isFinite(timestamp)) return;
    setLoadedGraph(null);
    setSelection({
      mode: "custom",
      from: side === "from" ? timestamp : shownRange.from,
      to: side === "to" ? timestamp : shownRange.to
    });
  };

  const graphTimestamp = (state: ChartPointerState | null): number | null => {
    const timestamp = Number(state?.activeLabel);
    return Number.isFinite(timestamp) ? timestamp : null;
  };

  const beginGraphSelection = (state: ChartPointerState | null) => {
    if (!graphSelectEnabled) return;
    const timestamp = graphTimestamp(state);
    if (timestamp !== null) setGraphDrag({ start: timestamp, end: timestamp });
  };

  const updateGraphSelection = (state: ChartPointerState | null) => {
    if (!graphSelectEnabled || !graphDrag) return;
    const timestamp = graphTimestamp(state);
    if (timestamp !== null) setGraphDrag((current) => current ? { ...current, end: timestamp } : null);
  };

  const finishGraphSelection = () => {
    if (!graphDrag) return;
    const from = Math.min(graphDrag.start, graphDrag.end);
    const to = Math.max(graphDrag.start, graphDrag.end);
    setGraphDrag(null);
    if (to <= from) return;
    setLoadedGraph(null);
    setSelection({ mode: "custom", from, to });
  };

  const exportGraph = () => {
    if (!shownSummary || !shownSeries) return;
    const snapshot: GraphSnapshot = {
      schema: "codex-usage-graph/v1",
      exportedAt: Date.now(),
      summary: shownSummary,
      series: shownSeries
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `codex-usage-graph-${new Date(snapshot.exportedAt).toISOString().replaceAll(":", "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const loadGraph = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const snapshot = parseGraphSnapshot(JSON.parse(await file.text()) as unknown);
      setLoadedGraph({ snapshot, name: file.name });
      setGraphDrag(null);
      setGraphSelectEnabled(false);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load graph snapshot.");
    }
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
              onClick={() => {
                setLoadedGraph(null);
                setSelection({ mode: "preset", preset: preset.value });
              }}
            >{preset.label}</button>
          ))}
        </div>
        <label>From<input type="datetime-local" value={utcToLocalInput(shownRange.from)} onChange={(event) => setCustomBoundary("from", event.target.value)} /></label>
        <span className="range-arrow" aria-hidden="true">→</span>
        <label>To<input type="datetime-local" value={utcToLocalInput(shownRange.to)} onChange={(event) => setCustomBoundary("to", event.target.value)} /></label>
        <label>Usage pool<select aria-label="Usage pool" value={loadedGraph?.snapshot.summary.pool ?? pool} onChange={(event) => {
          setLoadedGraph(null);
          setPool(event.target.value as PoolFilter);
        }}>
          <option value="standard">Sol / Terra / Luna</option>
          <option value="spark">Spark</option>
          <option value="all">All pools</option>
        </select></label>
        <button
          type="button"
          className={`graph-select-button${graphSelectEnabled ? " is-active" : ""}`}
          aria-pressed={graphSelectEnabled}
          onClick={() => {
            setGraphSelectEnabled((enabled) => !enabled);
            setGraphDrag(null);
          }}
        >{graphSelectEnabled ? "Graph select: on" : "Select on graph"}</button>
        <div className="snapshot-actions">
          <button type="button" onClick={exportGraph} disabled={!shownSummary || !shownSeries}>Export</button>
          <button type="button" onClick={() => loadInput.current?.click()}>Load</button>
          <input ref={loadInput} type="file" accept=".json,application/json" aria-label="Load graph snapshot" onChange={(event) => void loadGraph(event)} />
        </div>
        <button type="button" className="refresh-button" onClick={() => loadedGraph ? setLoadedGraph(null) : void refresh()} disabled={refreshing && !loadedGraph}>
          {loadedGraph ? "Return live" : refreshing ? "Reading…" : "Refresh now"}
        </button>
      </section>

      {loadedGraph && <div className="snapshot-strip"><strong>Loaded snapshot</strong><span>{loadedGraph.name}</span><span>{dateTime.format(loadedGraph.snapshot.exportedAt)}</span></div>}

      {error && <div className="error-strip" role="alert"><strong>Collector error</strong><span>{error}</span></div>}

      <section className="metric-strip" aria-label="Range totals">
        <article><span>Credit-weighted</span><strong>{shownSummary ? number.format(shownSummary.totals.creditWeightedTokens) : "—"}</strong><small>{shownSummary ? `${number.format(speed?.totalTokens ?? 0)} Speed tokens × ${SPEED_CREDIT_MULTIPLIER}${unknownSpeed?.requestCount ? ` · ${number.format(unknownSpeed.requestCount)} unknown at ×1` : ""}` : "Detecting service tier"}</small></article>
        <article><span>API equivalent</span><strong>{shownSummary ? formatUsd(shownSummary.totals.costNanoUsd) : "—"}</strong><small>{shownSummary?.totals.unpricedRequests ? `${shownSummary.totals.unpricedRequests} unpriced requests` : "Exact priced requests"}</small></article>
        <article><span>Total tokens</span><strong>{shownSummary ? number.format(shownSummary.totals.totalTokens) : "—"}</strong><small>{shownSummary ? `${number.format(shownSummary.totals.requestCount)} responses` : "No events yet"}</small></article>
        <article><span>Remaining</span><strong>{remaining === null ? "—" : `${remaining.toFixed(1)}%`}</strong><small>Codex-reported precision</small></article>
        <article><span>Consumed</span><strong>{quota?.percentagePointsConsumed === null || quota?.percentagePointsConsumed === undefined ? "—" : `${quota.percentagePointsConsumed.toFixed(1)} pp`}</strong><small>{quota?.resets.length ? `${quota.resets.length} reset boundary` : "Reset-safe delta"}</small></article>
      </section>

      <section className="workbench">
        <article className="chart-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">Time-aligned record</p><h2>Usage trace</h2></div>
            <span>{dateTime.format(shownRange.from)} — {dateTime.format(shownRange.to)}</span>
          </div>
          <div className="chart-frame">
            {plotted.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={plotted}
                  margin={{ top: 12, right: 12, bottom: 4, left: 4 }}
                  onMouseDown={beginGraphSelection}
                  onMouseMove={updateGraphSelection}
                  onMouseUp={finishGraphSelection}
                  onMouseLeave={finishGraphSelection}
                  className={graphSelectEnabled ? "graph-select-active" : undefined}
                >
                  <CartesianGrid stroke="#273044" strokeDasharray="2 5" vertical={false} />
                  <XAxis dataKey="at" type="number" domain={[shownRange.from, shownRange.to]} tickFormatter={(value) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} stroke="#748198" tick={{ fontSize: 10 }} />
                  <YAxis yAxisId="tokens" tickFormatter={(value) => `${(value / 1_000_000).toFixed(1)}M`} stroke="#748198" tick={{ fontSize: 10 }} />
                  <YAxis yAxisId="quota" orientation="right" domain={[0, 100]} stroke="#f5a95b" tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: "#111827", border: "1px solid #344057", borderRadius: 2 }} labelFormatter={(value) => dateTime.format(Number(value))} />
                  <Area yAxisId="tokens" type="stepAfter" dataKey="tokens" stroke="#55d6e8" fill="#55d6e822" strokeWidth={2} isAnimationActive={false} />
                  <Line yAxisId="quota" type="stepAfter" dataKey="remaining" stroke="#f5a95b" dot={false} connectNulls strokeWidth={1.5} isAnimationActive={false} />
                  {graphDrag && <ReferenceArea yAxisId="tokens" x1={graphDrag.start} x2={graphDrag.end} fill="#55d6e8" fillOpacity={0.16} stroke="#55d6e8" strokeOpacity={0.7} />}
                </ComposedChart>
              </ResponsiveContainer>
            ) : <div className="empty-trace"><span>∿</span><p>No token events in this range.</p></div>}
          </div>
          <div className="chart-legend"><span className="legend-cyan">Cumulative tokens</span><span className="legend-amber">Weekly remaining</span>{graphSelectEnabled && <span className="graph-select-help">Drag across the chart to set From / To</span>}</div>
        </article>

        <article className="ledger-panel">
          <div className="panel-heading"><div><p className="eyebrow">Per-model accounting</p><h2>Model ledger</h2></div><span>{shownSummary?.models.length ?? 0} active</span></div>
          <div className="ledger-scroll">
            <table>
              <thead><tr><th>Model</th><th>Mode</th><th>Input</th><th>Cached</th><th>Writes</th><th>Output</th><th>API eq.</th></tr></thead>
              <tbody>
                {shownSummary?.models.map((model) => (
                  <tr key={`${model.pool}:${model.model}:${model.serviceTier}`}>
                    <td><strong>{model.model}</strong><span className={`pool-tag pool-tag--${model.pool}`}>{model.pool}</span></td>
                    <td><span className={`tier-tag tier-tag--${model.serviceTier}`}>{model.serviceTier === "priority" ? "Speed" : model.serviceTier}</span></td>
                    <td>{number.format(model.inputTokens)}</td>
                    <td>{number.format(model.cachedInputTokens)}</td>
                    <td>{number.format(model.cacheWriteInputTokens)}</td>
                    <td>{number.format(model.outputTokens)}</td>
                    <td>{model.unpricedRequests === model.requestCount ? "Unpriced" : formatUsd(model.costNanoUsd)}</td>
                  </tr>
                ))}
                {!shownSummary?.models.length && <tr><td colSpan={7} className="empty-cell">No model activity in this range.</td></tr>}
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
