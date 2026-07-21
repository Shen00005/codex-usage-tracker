export type RangePreset = "1h" | "6h" | "24h" | "7d" | "30d";

export type RangeSelection =
  | { mode: "preset"; preset: RangePreset }
  | { mode: "custom"; from: number; to: number };

const PRESET_MS: Record<RangePreset, number> = {
  "1h": 60 * 60 * 1_000,
  "6h": 6 * 60 * 60 * 1_000,
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000
};

export function resolveRange(selection: RangeSelection, now: number): { from: number; to: number } {
  if (selection.mode === "custom") return { from: selection.from, to: selection.to };
  return { from: now - PRESET_MS[selection.preset], to: now };
}

export function utcToLocalInput(timestamp: number): string {
  const date = new Date(timestamp);
  const local = new Date(timestamp - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function localInputToUtc(value: string): number {
  return new Date(value).getTime();
}
