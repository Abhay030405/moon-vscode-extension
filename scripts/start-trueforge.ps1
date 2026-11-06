<#
start-trueforge.ps1: start TrueForge in local mode with the settings from config/moon.json.

  - Checks Node.js is new enough (version from "engines.node" in package.json).
  - Sets OUTBOUND_URL_ALLOWED_HOSTS so TrueForge may call Moon's MCP server on localhost
    (TrueForge blocks localhost by default).
  - Runs npx @truefoundry/trueforge@<trueforge.version> --port <trueforge.port>.

Usage (from anywhere):
  powershell -ExecutionPolicy Bypass -File scripts/start-trueforge.ps1
#>
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $Root "config/moon.json"
$PackagePath = Join-Path $Root "package.json"

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  Write-Host "config/moon.json not found. Create it first:" -ForegroundColor Red
  Write-Host "  Copy-Item config/moon.example.json config/moon.json"
  exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js is not installed or not on PATH." -ForegroundColor Red
  exit 1
}

# Node version check against package.json "engines.node" (e.g. ">=22.14").
$engines = (Get-Content -LiteralPath $PackagePath -Raw | ConvertFrom-Json).engines.node
$required = [version]([regex]::Match($engines, '\d+(\.\d+)+').Value)
$current = [version]((node -v).TrimStart('v'))
if ($current -lt $required) {
  Write-Host "Node.js $current found, but $engines is required." -ForegroundColor Red
  exit 1
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$tf = $config.trueforge

$env:OUTBOUND_URL_ALLOWED_HOSTS = ConvertTo-Json -InputObject @($tf.allowedOutboundHosts) -Compress

Write-Host "Starting TrueForge $($tf.version) on port $($tf.port)"
Write-Host "OUTBOUND_URL_ALLOWED_HOSTS=$env:OUTBOUND_URL_ALLOWED_HOSTS"
Write-Host "Open $($tf.baseUrl) once it is up. Press Ctrl+C to stop."

& npx --yes "@truefoundry/trueforge@$($tf.version)" --port $tf.port
exit $LASTEXITCODE
