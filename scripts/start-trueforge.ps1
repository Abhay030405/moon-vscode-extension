<#
start-trueforge.ps1: start TrueForge in local mode with the settings from config/moon.json.

  - Checks Node.js is new enough (version from "engines.node" in package.json).
  - Sets OUTBOUND_URL_ALLOWED_HOSTS so TrueForge may call Moon's MCP server on localhost
    (blocked by default) and our own provider endpoints (see scripts/lib/allowed-hosts.mjs).
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

# Node reads the file: Windows PowerShell 5.1's ConvertFrom-Json rejects keys that differ only
# by case, and security.networkBlockEnv needs both HTTP_PROXY and http_proxy.
$tfJson = node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).trueforge))" $ConfigPath
if ($LASTEXITCODE -ne 0) { exit 1 }
$tf = $tfJson | ConvertFrom-Json

# Local hosts from config/moon.json + the hosts of our provider endpoints (config/trueforge.json + .env).
$allowed = node (Join-Path $PSScriptRoot "lib/allowed-hosts.mjs")
if ($LASTEXITCODE -ne 0) { exit 1 }
$env:OUTBOUND_URL_ALLOWED_HOSTS = $allowed

Write-Host "Starting TrueForge $($tf.version) on port $($tf.port)"
Write-Host "Allowed outbound hosts: $(($env:OUTBOUND_URL_ALLOWED_HOSTS | ConvertFrom-Json).Count)"
Write-Host "Open $($tf.baseUrl) once it is up. Press Ctrl+C to stop."

& npx --yes "@truefoundry/trueforge@$($tf.version)" --port $tf.port
exit $LASTEXITCODE
