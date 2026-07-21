import { describe, expect, it } from "vitest";
import { localInputToUtc, resolveRange, utcToLocalInput } from "../src/client/range.js";

describe("range selection", () => {
  it("keeps custom absolute ranges stable", () => {
    const selection = { mode: "custom" as const, from: 1_000, to: 2_000 };
    expect(resolveRange(selection, 9_000)).toEqual({ from: 1_000, to: 2_000 });
  });

  it("resolves rolling presets against the current refresh time", () => {
    expect(resolveRange({ mode: "preset", preset: "1h" }, 7_200_000)).toEqual({ from: 3_600_000, to: 7_200_000 });
    expect(resolveRange({ mode: "preset", preset: "7d" }, 700_000_000)).toEqual({
      from: 95_200_000,
      to: 700_000_000
    });
  });

  it("round-trips local datetime controls without dropping minutes", () => {
    const instant = new Date(2026, 6, 21, 19, 37, 0, 0).getTime();
    const value = utcToLocalInput(instant);
    expect(localInputToUtc(value)).toBe(instant);
  });
});
