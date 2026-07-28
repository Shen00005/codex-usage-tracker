# Codex Usage Tracker

A private local dashboard for exact Codex CLI, Desktop, and VS Code usage from the moment the tracker is first started.

It follows Codex's local token-count events every two seconds, stores only numeric usage metadata in SQLite, and reports:

- Exact input, cached-input, cache-write, output, and reasoning-token counts
- API-equivalent cost calculated per response
- Short- and long-context pricing
- Speed mode detection from Codex's `priority` service tier, with Speed weighted at 2.5× for credit-equivalent token totals
- Codex weekly percentage remaining and reset-safe percentage-point movement
- Sol, Terra, and Luna as the standard pool, with Spark kept separate
- Rolling presets and exact custom start/end times
- Optional click-and-drag start/end selection directly on the usage graph
- JSON graph snapshot export and load for sharing or reopening a frozen aggregate view

## Start

Double-click `Start Codex Usage Tracker.cmd`.

The first run installs dependencies and builds the application if necessary. The server then runs in a hidden background process and opens [http://127.0.0.1:4319](http://127.0.0.1:4319).

Double-click `Stop Codex Usage Tracker.cmd` to stop only the verified tracker process.

## Development

```powershell
npm install
npm run dev
```

The Vite client runs at `http://127.0.0.1:5173` and proxies the local API at port 4319.

## Verification

```powershell
npm test
npm run typecheck
npm run build
```

## Data and accuracy

The database is stored at `%LOCALAPPDATA%\CodexUsageTracker\usage.sqlite`. Set `CODEX_USAGE_DATA_DIR` to use another location.

On first launch, existing session files are moved to their current byte offsets and are not imported. The latest observed weekly quota becomes the zero-token baseline. After that, restarts catch up from durable offsets, including events written while the tracker was stopped.

The Speed-tracking upgrade performs one automatic replay of every saved session from byte zero. Existing events are updated by their stable event keys rather than duplicated, and previously skipped session history is imported. Speed is recorded as `priority`, disabled Speed as `default`, and events before the first observed setting as `unknown`.

Codex event timestamps—not polling time—are stored as the usage time. Polling delay therefore does not shift historical X-to-Y results. The quota percentage cannot be more precise than the numeric percentage supplied by Codex.

API-equivalent cost is not an actual charge to the ChatGPT subscription. It is what the recorded token traffic would cost at the configured API rates.

Speed does not alter the API-equivalent dollar calculation. The separate credit-weighted total counts `priority` tokens at 2.5× and `default` tokens at 1×; `unknown` historical events are conservatively counted at 1×.

Graph exports contain only the selected range's aggregate summary and chart series. Loading an export freezes that snapshot in the dashboard until **Return live** is selected; it does not write imported data into the tracker database.

## Privacy

The parser allow-lists only session ID, source surface, model, numeric token fields, numeric rate-limit fields, and timestamps. It does not retain prompts, responses, reasoning text, tool calls, tool output, files, attachments, or credentials. The server binds only to `127.0.0.1` and provides no endpoint that modifies Codex data.
