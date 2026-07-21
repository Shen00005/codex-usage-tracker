// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App.js";
import type { UsageApi } from "../src/client/api.js";

const now = Date.parse("2026-07-21T22:30:00Z");

function api(): UsageApi {
  return {
    getHealth: vi.fn().mockResolvedValue({
      now,
      lagMs: 850,
      collector: { state: "watching", lastScanAt: now - 500, lastEventAt: now - 850, lastError: null, watchedFiles: 12 }
    }),
    getConfig: vi.fn().mockResolvedValue({ refreshIntervalMs: 100_000, installedAt: now - 10_000, pricing: {}, pools: [] }),
    getSummary: vi.fn().mockResolvedValue({
      from: now - 3_600_000,
      to: now,
      pool: "standard",
      totals: {
        inputTokens: 7_076_000,
        cachedInputTokens: 6_640_384,
        cacheWriteInputTokens: 0,
        uncachedInputTokens: 435_616,
        outputTokens: 71_085,
        reasoningOutputTokens: 24_919,
        totalTokens: 7_147_085,
        costNanoUsd: 7_134_208_200,
        requestCount: 124,
        longContextRequests: 0,
        unpricedRequests: 0
      },
      models: [
        {
          model: "gpt-5.6-sol", pool: "standard", inputTokens: 6_890_547, cachedInputTokens: 6_566_912,
          cacheWriteInputTokens: 0, uncachedInputTokens: 323_635, outputTokens: 70_268,
          reasoningOutputTokens: 24_441, totalTokens: 6_960_815, costNanoUsd: 7_009_671_000,
          requestCount: 119, longContextRequests: 0, unpricedRequests: 0
        },
        {
          model: "gpt-5.6-luna", pool: "standard", inputTokens: 185_453, cachedInputTokens: 73_472,
          cacheWriteInputTokens: 0, uncachedInputTokens: 111_981, outputTokens: 817,
          reasoningOutputTokens: 478, totalTokens: 186_270, costNanoUsd: 124_537_200,
          requestCount: 5, longContextRequests: 0, unpricedRequests: 0
        }
      ],
      quota: {
        startRemainingPercent: 100,
        endRemainingPercent: 99,
        percentagePointsConsumed: 1,
        resetsAt: Date.parse("2026-07-28T17:54:37Z"),
        resets: [],
        observations: 124
      }
    }),
    getTimeseries: vi.fn().mockResolvedValue({
      from: now - 3_600_000,
      to: now,
      pool: "standard",
      bucketMs: 60_000,
      usage: [
        { at: now - 1_000, tokens: 7_147_085, costNanoUsd: 7_134_208_200 }
      ],
      quota: [{ at: now - 1_000, remainingPercent: 99, usedPercent: 1, resetsAt: Date.parse("2026-07-28T17:54:37Z") }]
    })
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("App", () => {
  it("renders exact live totals, quota precision, and model accounting", async () => {
    render(<App apiClient={api()} now={() => now} />);
    expect(await screen.findByText("$7.13420820")).toBeInTheDocument();
    expect(screen.getByText("7,147,085")).toBeInTheDocument();
    expect(screen.getAllByText("99.0%").length).toBeGreaterThan(0);
    expect(screen.getByText("1.0 pp")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.6-sol")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.6-luna")).toBeInTheDocument();
    expect(screen.getByText("850 ms behind")).toBeInTheDocument();
  });

  it("requests a separate Spark pool when selected", async () => {
    const client = api();
    render(<App apiClient={client} now={() => now} />);
    await screen.findByText("$7.13420820");
    fireEvent.change(screen.getByLabelText("Usage pool"), { target: { value: "spark" } });
    await waitFor(() => expect(client.getSummary).toHaveBeenLastCalledWith(
      expect.any(Number),
      expect.any(Number),
      "spark",
      expect.anything()
    ));
  });

  it("shows a direct error when refresh fails", async () => {
    const client = api();
    vi.mocked(client.getSummary).mockRejectedValue(new Error("collector offline"));
    render(<App apiClient={client} now={() => now} />);
    expect(await screen.findByText("collector offline")).toBeInTheDocument();
  });
});
