<#
setup-providers.ps1: register Moon's model providers in TrueForge from config/trueforge.json and .env.
TrueForge must already be running (scripts/start-trueforge.ps1). The work is done by setup-providers.mjs.

Usage:
  powershell -ExecutionPolicy Bypass -File scripts/setup-providers.ps1
#>
$ErrorActionPreference = "Stop"
& node (Join-Path $PSScriptRoot "setup-providers.mjs")
exit $LASTEXITCODE
