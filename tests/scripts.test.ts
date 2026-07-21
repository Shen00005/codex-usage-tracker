import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8");

describe("Windows background scripts", () => {
  it("starts one hidden tracker process and waits for local health", () => {
    const script = read("start-background.ps1");
    expect(script).toContain("-WindowStyle Hidden");
    expect(script).toContain("127.0.0.1:4319/api/health");
    expect(script).toContain("tracker.pid");
    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain("Start-Process");
  });

  it("stops only a PID whose command line matches the tracker server", () => {
    const script = read("stop-background.ps1");
    expect(script).toContain("tracker.pid");
    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain("codex-usage-tracker");
    expect(script).toContain("Stop-Process -Id");
    expect(script).not.toContain("Get-Process node | Stop-Process");
  });
});
