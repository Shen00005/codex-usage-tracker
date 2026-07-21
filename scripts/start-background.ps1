$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$serverEntry = Join-Path $projectRoot "dist\server\server\index.js"
$dashboardUrl = "http://127.0.0.1:4319"
$healthUrl = "http://127.0.0.1:4319/api/health"
$dataDirectory = if ($env:CODEX_USAGE_DATA_DIR) {
    $env:CODEX_USAGE_DATA_DIR
} else {
    Join-Path $env:LOCALAPPDATA "CodexUsageTracker"
}
$pidFile = Join-Path $dataDirectory "tracker.pid"

if (-not (Test-Path -LiteralPath $serverEntry)) {
    Push-Location $projectRoot
    try {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "The production build failed." }
    } finally {
        Pop-Location
    }
}

New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null

function Get-VerifiedTrackerProcess([int]$processId) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    if (-not $candidate) { return $null }
    if ($candidate.CommandLine -notlike "*codex-usage-tracker*server*index.js*") { return $null }
    return $candidate
}

if (Test-Path -LiteralPath $pidFile) {
    $storedPid = 0
    if ([int]::TryParse((Get-Content -Raw -LiteralPath $pidFile).Trim(), [ref]$storedPid)) {
        if (Get-VerifiedTrackerProcess $storedPid) {
            Start-Process $dashboardUrl
            Write-Output "Codex Usage Tracker is already running (PID $storedPid)."
            exit 0
        }
    }
    Remove-Item -LiteralPath $pidFile -Force
}

$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$trackerProcess = Start-Process `
    -FilePath $nodeExecutable `
    -ArgumentList @($serverEntry) `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -PassThru

Set-Content -LiteralPath $pidFile -Value $trackerProcess.Id -NoNewline

$healthy = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try {
        $result = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
        if ($result.collector.state) {
            $healthy = $true
            break
        }
    } catch {
        Start-Sleep -Milliseconds 250
    }
}

if (-not $healthy) {
    & (Join-Path $PSScriptRoot "stop-background.ps1")
    throw "The tracker did not become healthy at $healthUrl."
}

Start-Process $dashboardUrl
Write-Output "Codex Usage Tracker started in the background (PID $($trackerProcess.Id))."
