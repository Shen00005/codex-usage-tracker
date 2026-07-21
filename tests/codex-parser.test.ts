import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { initialParserState, parseCodexLine } from "../src/server/codex-parser.js";

const fixturePath = fileURLToPath(new URL("./fixtures/codex-session.jsonl", import.meta.url));

describe("parseCodexLine", () => {
  it("tracks session, surface, and model changes while emitting only usage fields", () => {
    let state = initialParserState();
    const results = readFileSync(fixturePath, "utf8").trimEnd().split("\n").map((line, index) => {
      const result = parseCodexLine(line, state, { sourcePath: fixturePath, byteOffset: index * 100 });
      state = result.state;
      return result;
    });
    const usage = results.flatMap((result) => result.usageEvent ? [result.usageEvent] : []);

    expect(usage).toHaveLength(3);
    expect(usage[0]).toMatchObject({
      sessionId: "session-1",
      sourceSurface: "Codex Desktop",
      model: "gpt-5.6-sol",
      inputTokens: 1_000,
      cachedInputTokens: 700,
      cacheWriteInputTokens: 100,
      outputTokens: 40,
      pool: "standard",
      longContext: false
    });
    expect(usage[1]).toMatchObject({ model: "gpt-5.6-luna", longContext: true, costNanoUsd: 212_002_000 });
    expect(usage[2]).toMatchObject({ model: "gpt-5.3-codex-spark", pool: "spark", costNanoUsd: null });
    expect(JSON.stringify(results)).not.toContain("SECRET PROMPT");
  });

  it("emits quota precision and reset metadata from token events", () => {
    let state = initialParserState();
    const quotas = [];
    for (const [index, line] of readFileSync(fixturePath, "utf8").trimEnd().split("\n").entries()) {
      const result = parseCodexLine(line, state, { sourcePath: fixturePath, byteOffset: index * 100 });
      state = result.state;
      if (result.quotaSnapshot) quotas.push(result.quotaSnapshot);
    }
    expect(quotas[0]).toMatchObject({
      usedPercent: 1.2,
      remainingPercent: 98.8,
      resetsAt: 1_785_261_277_000,
      windowMinutes: 10_080,
      baseline: false
    });
    expect(quotas[2]).toMatchObject({ limitId: "codex_spark", pool: "spark" });
  });

  it("ignores malformed and irrelevant lines without changing parser state", () => {
    const state = { ...initialParserState(), model: "gpt-5.6-sol" };
    const malformed = parseCodexLine("not-json", state, { sourcePath: "x", byteOffset: 2 });
    const prompt = parseCodexLine(
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "private" } }),
      state,
      { sourcePath: "x", byteOffset: 3 }
    );
    expect(malformed).toEqual({ state, usageEvent: null, quotaSnapshot: null });
    expect(prompt).toEqual({ state, usageEvent: null, quotaSnapshot: null });
  });
});
