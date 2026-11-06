<#
setup-flask.ps1: get the competition repository (pallets/flask) ready for the three fixed tasks.

  1. Clones flask.repoUrl at flask.tag into flask.dir (from config/moon.json),
     or, if that folder already exists, checks the tag out there.
  2. Confirms HEAD is flask.commit. Stops if it isn't.
  3. Hides flask.localIgnores (venv, test cache) from Flask's git status using
     .git/info/exclude, so `git status` stays clean for Task C.
  4. Creates a Python virtual environment in <flask.dir>/.venv and installs
     Flask (editable) plus flask.testRequirements, so the task checks can run.

Refuses to touch an existing checkout that has uncommitted changes.

Usage:
  powershell -ExecutionPolicy Bypass -File scripts/setup-flask.ps1
  powershell -ExecutionPolicy Bypass -File scripts/setup-flask.ps1 -SkipInstall
#>
param([switch]$SkipInstall)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $Root "config/moon.json"
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  Write-Host "config/moon.json not found. Create it first:" -ForegroundColor Red
  Write-Host "  Copy-Item config/moon.example.json config/moon.json"
  exit 1
}
$flask = (Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json).flask
$Target = Join-Path $Root $flask.dir

function Invoke-Checked([string]$what, [scriptblock]$block) {
  & $block
  if ($LASTEXITCODE -ne 0) { Write-Host "$what failed (exit $LASTEXITCODE)." -ForegroundColor Red; exit 1 }
}

if (-not (Test-Path -LiteralPath $Target)) {
  Write-Host "Cloning $($flask.repoUrl) at $($flask.tag) into $Target"
  Invoke-Checked "git clone" { git -c advice.detachedHead=false clone --quiet --depth 1 --branch $flask.tag $flask.repoUrl $Target }
} else {
  if (-not (Test-Path -LiteralPath (Join-Path $Target ".git"))) {
    Write-Host "$Target exists but is not a git repository. Move it away and run again." -ForegroundColor Red
    exit 1
  }
  $dirty = git -C $Target status --porcelain
  if ($dirty) {
    Write-Host "$Target has uncommitted changes. Commit, stash or discard them first:" -ForegroundColor Red
    Write-Host $dirty
    exit 1
  }
  Write-Host "Checking out $($flask.tag) in $Target"
  Invoke-Checked "git fetch" { git -C $Target fetch --quiet --depth 1 origin "refs/tags/$($flask.tag):refs/tags/$($flask.tag)" }
  Invoke-Checked "git checkout" { git -C $Target checkout --quiet --detach $flask.tag }
}

$head = (git -C $Target rev-parse HEAD).Trim()
if (-not $head.StartsWith($flask.commit)) {
  Write-Host "HEAD is $head, expected $($flask.commit). Wrong checkout." -ForegroundColor Red
  exit 1
}
Write-Host "OK: $($flask.tag) at commit $head"

# Hide local-only files (venv, test cache) from git status, without touching Flask's own files.
$Exclude = Join-Path $Target ".git/info/exclude"
$existing = if (Test-Path -LiteralPath $Exclude) { Get-Content -LiteralPath $Exclude } else { @() }
foreach ($pattern in $flask.localIgnores) {
  if ($existing -notcontains $pattern) { Add-Content -LiteralPath $Exclude -Value $pattern }
}

if ($SkipInstall) { exit 0 }

$python = if (Get-Command python -ErrorAction SilentlyContinue) { "python" } else { "python3" }
$Venv = Join-Path $Target ".venv"
if (-not (Test-Path -LiteralPath $Venv)) {
  Write-Host "Creating virtual environment in $Venv"
  Invoke-Checked "python -m venv" { & $python -m venv $Venv }
}
$VenvPython = if (Test-Path (Join-Path $Venv "Scripts/python.exe")) { Join-Path $Venv "Scripts/python.exe" } else { Join-Path $Venv "bin/python" }

Write-Host "Installing Flask (editable) and its test requirements"
Invoke-Checked "pip install" { & $VenvPython -m pip install --quiet --disable-pip-version-check -e $Target @($flask.testRequirements) }

Write-Host ""
Write-Host "Flask is ready in $Target"
Write-Host "Activate the environment with:  $Venv\Scripts\Activate.ps1"
