<#
setup-test-repo.ps1: get the repositories used to test Moon ready (listed in config/test-repos.json).
Moon itself works on any project; this is only for the demo tasks and evals.

For each repo (or only the one named with -Name):
  1. Clones <url> at <ref> into <dir>, or, if <dir> exists, checks <ref> out there.
  2. Confirms HEAD is <commit>. Stops if it isn't.
  3. Hides <localIgnores> from the repo's git status via .git/info/exclude (never committed),
     so `git status` stays clean.
  4. Runs the repo's <setup.windows> commands inside it (e.g. create a venv, install deps).

Refuses to touch an existing checkout that has uncommitted changes.

Usage:
  powershell -ExecutionPolicy Bypass -File scripts/setup-test-repo.ps1
  powershell -ExecutionPolicy Bypass -File scripts/setup-test-repo.ps1 -Name flask
  powershell -ExecutionPolicy Bypass -File scripts/setup-test-repo.ps1 -SkipSetup
#>
param(
  [string]$Name,
  [switch]$SkipSetup
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $Root "config/test-repos.json"
$repos = (Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json).repos
if ($Name) {
  $repos = @($repos | Where-Object { $_.name -eq $Name })
  if (-not $repos) { Write-Host "No repo named '$Name' in config/test-repos.json." -ForegroundColor Red; exit 1 }
}

function Invoke-Checked([string]$what, [scriptblock]$block) {
  & $block
  if ($LASTEXITCODE -ne 0) { Write-Host "$what failed (exit $LASTEXITCODE)." -ForegroundColor Red; exit 1 }
}

foreach ($repo in $repos) {
  $Target = Join-Path $Root $repo.dir
  Write-Host "== $($repo.name): $($repo.purpose)"

  if (-not (Test-Path -LiteralPath $Target)) {
    Write-Host "Cloning $($repo.url) at $($repo.ref) into $Target"
    Invoke-Checked "git clone" { git -c advice.detachedHead=false clone --quiet --depth 1 --branch $repo.ref $repo.url $Target }
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
    Write-Host "Checking out $($repo.ref) in $Target"
    Invoke-Checked "git fetch" { git -C $Target fetch --quiet --depth 1 origin $repo.ref }
    Invoke-Checked "git checkout" { git -C $Target -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD }
  }

  $head = (git -C $Target rev-parse HEAD).Trim()
  if (-not $head.StartsWith($repo.commit)) {
    Write-Host "HEAD is $head, expected $($repo.commit). Wrong checkout." -ForegroundColor Red
    exit 1
  }
  Write-Host "OK: $($repo.ref) at commit $head"

  $Exclude = Join-Path $Target ".git/info/exclude"
  $existing = if (Test-Path -LiteralPath $Exclude) { Get-Content -LiteralPath $Exclude } else { @() }
  foreach ($pattern in @($repo.localIgnores)) {
    if ($pattern -and $existing -notcontains $pattern) { Add-Content -LiteralPath $Exclude -Value $pattern }
  }

  if ($SkipSetup) { continue }

  Push-Location $Target
  try {
    foreach ($command in @($repo.setup.windows)) {
      if (-not $command) { continue }
      Write-Host "> $command"
      Invoke-Expression $command
      if ($LASTEXITCODE -ne 0) { Write-Host "Setup step failed (exit $LASTEXITCODE)." -ForegroundColor Red; exit 1 }
    }
  } finally {
    Pop-Location
  }
  Write-Host "Ready: $Target"
}
