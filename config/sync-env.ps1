<#
sync-env.ps1 — rebuild .env from .env.example, keeping your existing values.
No Node/Python needed: runs on plain Windows PowerShell (5.1+) and PowerShell 7.

  1. .env.example is the template (order, comments, blank lines, example values).
  2. Keys already in .env keep their value.
  3. Keys missing from .env get the example value.
  4. Keys only in .env are kept at the bottom (nothing is lost).
  5. Old .env is backed up to .env.bak.

Usage:
  powershell -ExecutionPolicy Bypass -File sync-env.ps1
  powershell -ExecutionPolicy Bypass -File sync-env.ps1 -DryRun
  powershell -ExecutionPolicy Bypass -File sync-env.ps1 -Example path\.env.example -Env path\.env
  powershell -ExecutionPolicy Bypass -File sync-env.ps1 -NoBackup
#>
param(
  [string]$Example = ".env.example",
  [Alias("Env")][string]$EnvFile = ".env",
  [switch]$DryRun,
  [switch]$NoBackup
)

$ErrorActionPreference = "Stop"
$KeyRe = '^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$'

function Test-Closes([string]$s, [char]$q, [int]$start) {
  for ($i = $start; $i -lt $s.Length; $i++) {
    if ($s[$i] -eq '\') { $i++; continue }
    if ($s[$i] -eq $q) { return $true }
  }
  return $false
}

function Parse-EnvFile([string]$content) {
  $lines = $content -replace "`r`n", "`n" -split "`n"
  if ($lines.Count -and $lines[-1] -eq "") { $lines = $lines[0..($lines.Count - 2)] }
  $entries = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    if ($line -notmatch $KeyRe) { [void]$entries.Add(@{ Type = "raw"; Text = $line }); continue }
    $prefix = $Matches[1]; $key = $Matches[2]; $value = $Matches[3]; $text = $line
    $t = $value.TrimStart()
    if ($t.Length -gt 0) {
      $q = $t[0]
      if (($q -eq '"' -or $q -eq "'" -or $q -eq '`') -and -not (Test-Closes $t $q 1)) {
        while ($i + 1 -lt $lines.Count) {
          $i++
          $value += "`n" + $lines[$i]; $text += "`n" + $lines[$i]
          if (Test-Closes $lines[$i] $q 0) { break }
        }
      }
    }
    [void]$entries.Add(@{ Type = "kv"; Prefix = "$prefix"; Key = $key; Value = $value; Text = $text })
  }
  return ,$entries
}

if (-not (Test-Path -LiteralPath $Example)) { Write-Error "Template not found: $Example"; exit 1 }
$exampleContent = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $Example))
$envExists = Test-Path -LiteralPath $EnvFile
$envContent = if ($envExists) { [IO.File]::ReadAllText((Resolve-Path -LiteralPath $EnvFile)) } else { "" }

$envVals = [ordered]@{}
foreach ($e in (Parse-EnvFile $envContent)) { if ($e.Type -eq "kv") { $envVals[$e.Key] = $e } }

$seen = @{}; $kept = @(); $added = @()
$out = New-Object System.Collections.Generic.List[string]
foreach ($e in (Parse-EnvFile $exampleContent)) {
  if ($e.Type -eq "raw") { $out.Add($e.Text); continue }
  if ($seen.ContainsKey($e.Key)) { continue }
  $seen[$e.Key] = $true
  if ($envVals.Contains($e.Key)) {
    $out.Add("$($e.Prefix)$($e.Key)=$($envVals[$e.Key].Value)"); $kept += $e.Key
  } else {
    $out.Add($e.Text); $added += $e.Key
  }
}

$extras = @($envVals.Values | Where-Object { -not $seen.ContainsKey($_.Key) })
if ($extras.Count) {
  if ($out.Count -and $out[$out.Count - 1].Trim() -ne "") { $out.Add("") }
  $out.Add("# ---- Keys present in .env but not in .env.example ----")
  foreach ($e in $extras) { $out.Add("$($e.Prefix)$($e.Key)=$($e.Value)") }
}
$result = ($out -join "`n") + "`n"

function Show([string]$label, $items) {
  $list = if ($items.Count) { $items -join ", " } else { "-" }
  Write-Host ("{0} ({1}): {2}" -f $label, $items.Count, $list)
}
Show "[kept]  from .env     " $kept
Show "[added] from example  " $added
Show "[extra] only in .env  " @($extras | ForEach-Object { $_.Key })

if ($DryRun) { Write-Host "`n--- dry run: new .env would be ---`n"; Write-Host $result; exit 0 }

if ($envExists -and ($envContent -replace "`r`n", "`n") -eq $result) {
  Write-Host "`n.env is already in sync. Nothing written."; exit 0
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
$envFull = [IO.Path]::GetFullPath((Join-Path (Get-Location) $EnvFile))
if ($envExists -and -not $NoBackup) {
  [IO.File]::WriteAllText("$envFull.bak", $envContent, $utf8)
  Write-Host "`nBackup   : $envFull.bak"
}
[IO.File]::WriteAllText($envFull, $result, $utf8)
Write-Host "Written  : $envFull"
