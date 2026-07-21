# Codex Usage Tracker Design

## Purpose

Build a private Windows application that runs a local background collector and serves a live web dashboard for Codex CLI, Codex Desktop, and the VS Code Codex extension. It records usage from installation onward, lets the user query any exact start and end time, and calculates token totals, API-equivalent cost, and weekly quota movement without relying on reset estimates.

## Accuracy contract

- Codex event timestamps are the source of truth. The collector polling time is never used as the usage time.
- The collector refreshes within two seconds under normal operation.
- Only newly appended events are imported on first installation. Existing history is not backfilled.
- On first launch, the latest weekly quota observation is stored as a zero-token baseline.
- Restarts resume from durable byte offsets and import events missed while the tracker was stopped.
- Every source event is deduplicated by normalized source path and byte offset.
- Token categories remain separate: total input, cached input, cache-write input, uncached input, output, and reasoning output. Cached and cache-write input are subsets of input; reasoning output is a subset of output.
- Event cost is stored as integer nano-dollars to avoid floating-point drift.
- The weekly quota percentage is reported only to the precision provided by Codex. The application does not invent hidden decimal places.

## Scope

The first version tracks local Codex usage from CLI, Desktop, and VS Code. It reads local session JSONL events and ignores prompt, response, tool-output, attachment, credential, and repository content.

GPT-5.6 Sol, Terra, and Luna share the standard pool view. `gpt-5.3-codex-spark` is retained as a separate model and pool and is excluded from standard-pool totals by default. Unknown models remain visible with an explicit “pricing unavailable” state instead of being silently priced.

## Architecture

The project is a TypeScript application with three focused areas:

1. A Node.js collector incrementally follows `%USERPROFILE%\.codex\sessions\**\*.jsonl`, parses only metadata, turn context, and token-count events, and persists normalized records with Node's built-in SQLite module.
2. An HTTP API queries exact ranges, calculates reset-safe quota movement, and returns summaries and time-series buckets.
3. A React web interface polls the local API every two seconds and displays the current status and selected range.

The parser, pricing calculator, range aggregation, and file-following logic are independent modules with fixture-driven tests. This isolates the internal Codex event format so an OpenTelemetry adapter can replace or supplement it later without changing storage or the UI.

## First-run and restart behavior

On the first run, the collector scans existing session files without importing historical token events. It records each file’s current length and the most recent model context. It also scans for the latest rate-limit snapshot and stores that single snapshot as the baseline. Files created after initialization are read from byte zero.

On later runs, the collector resumes every file from its stored byte offset. If a file ends with a partial JSON line, the cursor remains at the start of that line. If a file is truncated below its stored cursor, the collector restarts that file from byte zero and relies on event deduplication.

## Data model

`file_cursors` stores source path, byte offset, current session ID, current model, source surface, size, and update time.

`usage_events` stores the source identity, event time in UTC milliseconds, session ID, model, source surface, all token categories, context-window size, long-context flag, pool, and exact nano-dollar cost.

`quota_snapshots` stores event time, limit ID, used percentage, remaining percentage, window length, reset timestamp, plan type, model, and pool. Baseline snapshots are marked explicitly.

`app_meta` stores the schema version and whether first-run initialization has completed.

## Pricing

Pricing is a local typed catalog. GPT-5.6 standard prices per one million tokens are:

| Model | Uncached input | Cached input | Cache write | Output |
|---|---:|---:|---:|---:|
| Sol | $5.00 | $0.50 | $6.25 | $30.00 |
| Terra | $2.50 | $0.25 | $3.125 | $15.00 |
| Luna | $1.00 | $0.10 | $1.25 | $6.00 |

For a request with more than 272,000 input tokens, the full request uses twice the input-side rates and 1.5 times the output rate. Cost is calculated per response before aggregation. A response with no catalog entry has no computed cost and is surfaced as unpriced.

## Range and quota calculations

The API accepts inclusive `from` and exclusive `to` UTC timestamps. Presets calculate the exact previous hour, six hours, 24 hours, seven days, or 30 days at selection time. Custom local date-time input is converted to UTC by the browser.

Token and cost totals include events whose timestamps fall inside the range. Percentage points consumed are calculated independently inside each reset window. For each window, the aggregator uses the maximum observed `used_percent` up to each point so stale parallel observations cannot make usage move backward. Movement across a new `resets_at` value is segmented as a reset rather than subtracted across windows.

## HTTP interface

- `GET /api/health` returns collector state, newest processed event, newest quota observation, lag, and database path.
- `GET /api/summary?from=<iso>&to=<iso>&pool=<standard|spark|all>` returns totals, per-model rows, quota movement, and resets.
- `GET /api/timeseries?from=<iso>&to=<iso>&pool=<...>` returns automatically bucketed cumulative tokens and cost plus quota observations.
- `GET /api/config` returns refresh interval, supported models, pricing, and installation baseline time.

Invalid ranges return HTTP 400 with a direct message. Database and collector failures return a safe error without exposing local file content.

## Web interface

The visual direction is a compact Windows-native measurement console: smoked indigo surfaces, phosphor cyan telemetry, tungsten amber reset markers, Bahnschrift headings, and Cascadia Mono data. The signature element is a horizontal quota ruler with a precise remaining-position needle. The interface avoids generic oversized cards and uses tabular numerals throughout.

The header shows collector health, last event time, processing lag, and the next reset. The range bar provides exact start/end inputs and presets. Four primary readouts show API-equivalent cost, total tokens, weekly remaining percentage, and percentage points consumed.

The main chart combines cumulative cost and tokens with a stepped weekly-remaining line. A model ledger shows token categories and cost for each model. Spark has a distinct pool badge and is excluded from the standard view. Reset markers and data gaps are visible on the timeline. The page refreshes every two seconds without resetting the selected range.

## Privacy and security

- Bind the HTTP server to `127.0.0.1` only.
- Never read or store `auth.json`.
- Never store prompts, responses, reasoning text, tool data, paths from tool output, or attachments.
- Do not expose a mutation endpoint for Codex files.
- Use parameterized database queries.
- Escape all rendered model and status strings through React.

## Background launch

`scripts/start-background.ps1` starts the compiled server in a hidden Windows process, waits for `/api/health`, and opens the dashboard. A PID file prevents duplicate collectors. `scripts/stop-background.ps1` stops only the verified tracker process. Normal development remains available through `npm run dev`.

## Testing and acceptance

Fixture tests cover short and long pricing, cached and cache-write accounting, partial JSON lines, restart cursors, duplicate suppression, model changes, first-run baseline behavior, quota resets, stale percentage observations, range boundaries, and Spark exclusion.

The implementation is accepted when a generated fixture produces exact expected totals and nano-dollar cost, live local events appear within two seconds, restarting does not duplicate events, a custom X-to-Y query is stable, reset boundaries do not create negative usage, and no prompt text enters the database.
