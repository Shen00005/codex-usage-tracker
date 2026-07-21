# Codex Usage Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows background collector and live local web dashboard that reports exact Codex tokens, API-equivalent cost, and reset-safe quota movement for any selected time range.

**Architecture:** A TypeScript Node service incrementally follows Codex JSONL session events into SQLite and exposes read-only range APIs. A React/Vite client polls those APIs every two seconds and renders health, exact totals, quota movement, charts, and per-model accounting.

**Tech Stack:** Node.js 26, TypeScript, Fastify, built-in `node:sqlite`, chokidar, React, Vite, Recharts, Vitest, Testing Library

## Global Constraints

- Store no prompt, response, reasoning text, tool data, credential, attachment, or repository content.
- Bind only to `127.0.0.1`.
- Use Codex event timestamps as the usage time and refresh the UI every 2,000 milliseconds.
- Do not import historical token events on first installation; store only the current quota baseline.
- Persist token cost as integer nano-dollars.
- Treat cached input and cache-write input as subsets of input, and reasoning output as a subset of output.
- Apply long-context prices to the full request only when input tokens exceed 272,000.
- Exclude Spark from the standard Sol/Terra/Luna pool by default.

---

### Task 1: Project foundation and typed domain

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/shared/domain.ts`
- Create: `src/shared/pricing.ts`
- Test: `tests/pricing.test.ts`

**Interfaces:**
- Produces: `TokenUsage`, `UsageEvent`, `QuotaSnapshot`, `PriceBand`, `priceUsage(model, usage): PricedUsage`, and `poolForModel(model): UsagePool`.

- [ ] **Step 1: Write pricing tests** covering Sol and Luna cached input, uncached input, cache writes, output, the 272,000 boundary, the 272,001 long-context request, and unknown models.
- [ ] **Step 2: Run `npm test -- tests/pricing.test.ts`** and verify failure because the modules do not exist.
- [ ] **Step 3: Implement integer nano-dollar pricing** with typed immutable model rates and explicit unknown-model results.
- [ ] **Step 4: Run `npm test -- tests/pricing.test.ts`** and verify all pricing cases pass.
- [ ] **Step 5: Commit** with `git commit -m "feat: add exact Codex pricing domain"`.

### Task 2: SQLite persistence and range aggregation

**Files:**
- Create: `src/server/database.ts`
- Create: `src/server/queries.ts`
- Test: `tests/database.test.ts`
- Test: `tests/queries.test.ts`

**Interfaces:**
- Consumes: `UsageEvent`, `QuotaSnapshot`, and `UsagePool` from `src/shared/domain.ts`.
- Produces: `openDatabase(path): UsageDatabase`, `UsageDatabase.insertUsageEvent`, `insertQuotaSnapshot`, `upsertCursor`, `getCursor`, `getSummary`, and `getTimeseries`.

- [ ] **Step 1: Write database tests** for schema creation, parameterized inserts, event-key deduplication, cursor persistence, and baseline metadata.
- [ ] **Step 2: Run the database tests** and verify they fail before implementation.
- [ ] **Step 3: Implement migrations and repository methods** using prepared statements and integer timestamp/token/cost columns.
- [ ] **Step 4: Write aggregation tests** for inclusive-from/exclusive-to boundaries, model grouping, Spark exclusion, monotonic quota observations, and reset segmentation.
- [ ] **Step 5: Implement query functions** and return serializable summary and time-series objects.
- [ ] **Step 6: Run both test files** and verify they pass.
- [ ] **Step 7: Commit** with `git commit -m "feat: persist and aggregate usage events"`.

### Task 3: Incremental Codex JSONL parser

**Files:**
- Create: `src/server/codex-parser.ts`
- Create: `tests/fixtures/codex-session.jsonl`
- Test: `tests/codex-parser.test.ts`

**Interfaces:**
- Consumes: raw complete JSON lines and prior `ParserState`.
- Produces: `parseCodexLine(line, state, source): ParseResult`, where the result contains updated session/model/surface state plus zero or one normalized usage event and quota snapshot.

- [ ] **Step 1: Create a synthetic fixture** containing session metadata, Sol and Luna turn contexts, short and long token events, a cache write, a Spark event, a reset, irrelevant prompt content, and a malformed line.
- [ ] **Step 2: Write parser tests** proving exact field normalization, model changes, pool assignment, quota parsing, safe malformed-line handling, and complete rejection of prompt content.
- [ ] **Step 3: Run the parser tests** and verify failure before implementation.
- [ ] **Step 4: Implement the allow-list parser** so only approved metadata and numeric usage fields leave the module.
- [ ] **Step 5: Run the parser tests** and verify they pass.
- [ ] **Step 6: Commit** with `git commit -m "feat: parse Codex usage events safely"`.

### Task 4: Durable file follower and first-run baseline

**Files:**
- Create: `src/server/session-follower.ts`
- Test: `tests/session-follower.test.ts`

**Interfaces:**
- Consumes: session root, `UsageDatabase`, clock, and scan interval.
- Produces: `SessionFollower.start()`, `scanNow()`, `stop()`, and `getStatus(): CollectorStatus`.

- [ ] **Step 1: Write follower tests** for first-run EOF seeding, latest quota baseline, new-file import, append import, partial-line retention, restart catch-up, truncation, duplicate suppression, and two-second scheduling.
- [ ] **Step 2: Run the follower tests** and verify failure before implementation.
- [ ] **Step 3: Implement bounded recursive discovery and byte-range reads** without ever reading `auth.json` or unrelated Codex files.
- [ ] **Step 4: Implement initialization and cursor recovery** with persisted parser state and explicit baseline snapshots.
- [ ] **Step 5: Run the follower tests** and verify they pass.
- [ ] **Step 6: Commit** with `git commit -m "feat: follow Codex sessions incrementally"`.

### Task 5: Local read-only API

**Files:**
- Create: `src/server/app.ts`
- Create: `src/server/index.ts`
- Test: `tests/api.test.ts`

**Interfaces:**
- Consumes: `UsageDatabase` and `SessionFollower`.
- Produces: `buildServer(dependencies)` and the `/api/health`, `/api/config`, `/api/summary`, and `/api/timeseries` routes.

- [ ] **Step 1: Write injected Fastify route tests** for healthy responses, exact UTC ranges, default standard-pool behavior, Spark and all-pool selection, invalid input, and safe internal errors.
- [ ] **Step 2: Run the API tests** and verify failure before implementation.
- [ ] **Step 3: Implement validation and routes** with localhost-only defaults and no mutation endpoints.
- [ ] **Step 4: Serve the built client with SPA fallback** while keeping `/api/*` errors JSON-only.
- [ ] **Step 5: Run the API tests** and verify they pass.
- [ ] **Step 6: Commit** with `git commit -m "feat: expose local usage API"`.

### Task 6: Live operations dashboard

**Files:**
- Create: `index.html`
- Create: `src/client/main.tsx`
- Create: `src/client/App.tsx`
- Create: `src/client/api.ts`
- Create: `src/client/range.ts`
- Create: `src/client/styles.css`
- Test: `tests/range.test.ts`
- Test: `tests/dashboard.test.tsx`

**Interfaces:**
- Consumes: JSON responses from the four local API routes.
- Produces: a responsive dashboard that preserves its selected range while refreshing every two seconds.

- [ ] **Step 1: Write range tests** for presets, custom local-time conversion, and stable absolute selections during refresh.
- [ ] **Step 2: Write dashboard tests** for health, metric cards, quota precision, model rows, Spark exclusion, reset notices, loading, empty, and error states.
- [ ] **Step 3: Run the client tests** and verify failure before implementation.
- [ ] **Step 4: Implement typed API fetching and range state** with abortable refresh requests.
- [ ] **Step 5: Implement the operations-console interface** with live status, exact X-to-Y controls, metric strip, Recharts time series, model ledger, reset markers, and accessible responsive behavior.
- [ ] **Step 6: Run the client tests** and verify they pass.
- [ ] **Step 7: Commit** with `git commit -m "feat: add live usage dashboard"`.

### Task 7: Windows background lifecycle

**Files:**
- Create: `scripts/start-background.ps1`
- Create: `scripts/stop-background.ps1`
- Create: `README.md`
- Test: `tests/scripts.test.ts`

**Interfaces:**
- Produces: safe, idempotent background start and stop commands scoped to the tracker PID file.

- [ ] **Step 1: Write static script tests** proving explicit paths, hidden process launch, health wait, duplicate prevention, and verified PID shutdown.
- [ ] **Step 2: Run the script tests** and verify failure before scripts exist.
- [ ] **Step 3: Implement start and stop scripts** without broad process termination or destructive filesystem operations.
- [ ] **Step 4: Document install, development, production build, background launch, data location, accuracy boundaries, and privacy behavior.**
- [ ] **Step 5: Run the script tests** and verify they pass.
- [ ] **Step 6: Commit** with `git commit -m "feat: add Windows background launcher"`.

### Task 8: End-to-end verification

**Files:**
- Modify only files required by failures found during verification.

**Interfaces:**
- Verifies all earlier task interfaces together.

- [ ] **Step 1: Run `npm test`** and require zero failures.
- [ ] **Step 2: Run `npm run typecheck`** and require zero diagnostics.
- [ ] **Step 3: Run `npm run build`** and require a successful server and client build.
- [ ] **Step 4: Run the built server against a temporary synthetic session root** and query all four endpoints.
- [ ] **Step 5: Use a browser at desktop and narrow viewport widths** to verify initial load, two-second refresh, custom range, model ledger, chart, empty/error states, and no console errors.
- [ ] **Step 6: Inspect the temporary SQLite database** and prove no fixture prompt text was stored.
- [ ] **Step 7: Commit final verified fixes** with `git commit -m "test: verify Codex usage tracker end to end"` if any files changed.
