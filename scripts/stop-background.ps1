$ErrorActionPreference = "Stop"

$dataDirectory = if ($env:CODEX_USAGE_DATA_DIR) {
    $env:CODEX_USAGE_DATA_DIR
} else {
    Join-Path $env:LOCALAPPDATA "CodexUsageTracker"
}
$pidFile = Join-Path $dataDirectory "tracker.pid"

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Output "Codex Usage Tracker is not running."
    exit 0
}

$storedPid = 0
if (-not [int]::TryParse((Get-Content -Raw -LiteralPath $pidFile).Trim(), [ref]$storedPid)) {
    throw "The tracker PID file is invalid: $pidFile"
}

$candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $storedPid" -ErrorAction SilentlyContinue
if ($candidate) {
    if ($candidate.CommandLine -notlike "*codex-usage-tracker*server*index.js*") {
        throw "PID $storedPid does not belong to codex-usage-tracker; no process was stopped."
    }
    Stop-Process -Id $storedPid
    Wait-Process -Id $storedPid -Timeout 5 -ErrorAction SilentlyContinue
}

Remove-Item -LiteralPath $pidFile -Force
Write-Output "Codex Usage Tracker stopped."
