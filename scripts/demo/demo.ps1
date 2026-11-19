<#
demo.ps1: helpers for recording the demo video. See docs/demo/video-script.md.

  powershell -ExecutionPolicy Bypass -File scripts/demo/demo.ps1 prep
  powershell -ExecutionPolicy Bypass -File scripts/demo/demo.ps1 break       # Task C: invalid main key
  powershell -ExecutionPolicy Bypass -File scripts/demo/demo.ps1 restore     # put the real keys back
  powershell -ExecutionPolicy Bypass -File scripts/demo/demo.ps1 intro       # render the animated intro
  powershell -ExecutionPolicy Bypass -File scripts/demo/demo.ps1 edit --video raw.mp4 --intro demo-build/moon-intro.mp4
#>
$ErrorActionPreference = "Stop"
$action, $rest = $args
switch ($action) {
  "prep"    { & node (Join-Path $PSScriptRoot "prep-demo.mjs") @rest }
  "break"   { & node (Join-Path $PSScriptRoot "task-c.mjs") break @rest }
  "restore" { & node (Join-Path $PSScriptRoot "task-c.mjs") restore @rest }
  "edit"    { & node (Join-Path $PSScriptRoot "edit-video.mjs") @rest }
  "intro"   { & node (Join-Path $PSScriptRoot "intro/render-intro.mjs") @rest }
  default   { Write-Host "Usage: demo.ps1 prep | break | restore | intro | edit --video <file> [--intro <mp4>]"; exit 1 }
}
exit $LASTEXITCODE
