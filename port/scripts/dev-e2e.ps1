<#
.SYNOPSIS
  Launch the assembled desktop port for development and acceptance testing.

.DESCRIPTION
  This is the repeatable flow the independent review asked for:
  installed/assembled app -> cold startup -> native command/event -> session
  and streaming -> host failure -> recovery -> clean shutdown.

  It stages everything the Rust supervisor needs, then launches the Tauri
  application with an ISOLATED Harness home. It never touches a user's real
  `$DSH_HOME`, and it never prints a launch token; the token is handed to the
  verifier through a dev-only file that the app writes only when asked.

  Run `scripts/verify-assembled.mjs` against the printed URL afterwards, or pass
  -Verify to do it automatically.

.PARAMETER Build
  Run `cargo build` for the shell first.

.PARAMETER Verify
  After launch, wait for the dev URL file and run scripts/verify-assembled.mjs.

.EXAMPLE
  .\port\scripts\dev-e2e.ps1 -Build -Verify
#>
[CmdletBinding()]
param(
  [switch]$Build,
  [switch]$Verify,
  [int]$WaitSeconds = 60
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PortRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $PortRoot
$Upstream = Join-Path $RepoRoot '_upstream'
$TauriDir = Join-Path $PortRoot 'src-tauri'
$Scratch = Join-Path $PortRoot '.scratch'
$Stage = Join-Path $Scratch 'host-stage'
$RunHome = Join-Path $Scratch 'run-home'
$Profile = Join-Path $RunHome 'profiles\desktop'
$UrlFile = Join-Path $Scratch 'dev-gateway-url.txt'
# The app writes this ONLY when `runtime_boot_ready` RESOLVES - host ready AND
# gateway attached. The URL file above is published EARLIER (app/src/lib.rs
# publishes it before `set_host`), so it is NOT a readiness signal: gating on it
# reported "gateway is up" while the host had already died on a module error.
$BootFile = Join-Path $Scratch 'dev-boot.json'

function Write-Step([string]$Message) { Write-Host ''; Write-Host "==> $Message" -ForegroundColor Cyan }

# --- 1. Locate the materialized runtime payload ----------------------------
# The runtime must be the SAME materialized tree the installer ships, NOT a
# junction farm over the reference checkout. An earlier version of this script
# staged a junction to `_upstream/apps/desktop-host/node_modules`, whose closure
# covers only that package's own dependencies: it contains neither the profile
# bundles (`dsh-base`, `dsh-web-app`) nor the peer `cordis-plugin-group`. The host
# therefore died during profile boot and this launcher never reached readiness,
# even though the installed application did (finding F-13, and F-33 for the
# launcher divergence).
Write-Step 'Locating the materialized runtime payload'
$payloadDsh = Join-Path $PortRoot 'runtime-payload\dsh'
$payloadAdapter = Join-Path $payloadDsh 'adapter.mjs'
if (-not (Test-Path $payloadAdapter)) {
  throw "Runtime payload missing at $payloadDsh. Build it first with: & `"$PSScriptRoot\build.ps1`" -Stage runtime"
}
foreach ($anchorName in @('dsh', 'cordis-plugin-group', 'dsh-base', 'dsh-web-app')) {
  if (-not (Test-Path (Join-Path $payloadDsh "node_modules\@deepseek-ai\$anchorName\package.json"))) {
    throw "Runtime payload is incomplete: missing @deepseek-ai/$anchorName. Re-run: & `"$PSScriptRoot\build.ps1`" -Stage runtime"
  }
}
Write-Host "    payload -> $payloadDsh" -ForegroundColor DarkGray

# --- 2. Prepare an EMPTY isolated Harness home -----------------------------
# Deliberately do NOT hand-stage the profile. The shell's own initializer creates
# `profiles/desktop` on every launch, before it spawns the host; staging it here
# would mask a broken initializer again -- precisely the trap that hid the missing
# profile initialisation until an installed run exposed it (finding F-23).
Write-Step 'Preparing an empty isolated Harness home'
Remove-Item $RunHome -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $RunHome | Out-Null
Write-Host "    DSH_HOME -> $RunHome (profile intentionally left for the app to create)" -ForegroundColor DarkYellow
Write-Host "    profile  -> $Profile" -ForegroundColor DarkGray

# --- 3. Build ---------------------------------------------------------------
if ($Build) {
  Write-Step 'Building the Tauri shell'
  Push-Location $TauriDir
  try {
    & cargo build -p dsh-desktop
    if ($LASTEXITCODE -ne 0) { throw "cargo build -p dsh-desktop failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
}

# --- 4. Resolve the executable ---------------------------------------------
Write-Step 'Resolving the executable'
$exe = Get-ChildItem (Join-Path $TauriDir 'target\debug\dsh-desktop.exe'), (Join-Path $TauriDir 'target\release\dsh-desktop.exe') -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($null -eq $exe) { throw "No dsh-desktop.exe under target\. Build it first (use -Build)." }
Write-Host "    $($exe.FullName)" -ForegroundColor DarkGray

# Point the supervisor at the MATERIALIZED payload's adapter. Node resolves bare
# specifiers relative to the importing file, so the adapter must live inside the
# payload tree itself: copying it beside the executable fails with
# ERR_MODULE_NOT_FOUND, and the old `host-stage` junction tree lacked the profile
# closure entirely (finding F-13).
$adapter = $payloadAdapter
Write-Host "    adapter -> $adapter" -ForegroundColor DarkGray

# --- 5. Launch with isolated state ----------------------------------------
Write-Step 'Launching the assembled application'
Remove-Item $UrlFile -ErrorAction SilentlyContinue
Remove-Item $BootFile -ErrorAction SilentlyContinue
$env:DSH_HOME = $RunHome
$env:DSH_DESKTOP_USER_DATA_DIR = (Join-Path $RunHome 'userdata')
$env:DSH_DESKTOP_RUNTIME_DIR = $payloadDsh
$env:DSH_DESKTOP_SHELL_DIR = (Join-Path $PortRoot 'ui\dist')
$env:DSH_DESKTOP_NODE = (Get-Command node).Source
$env:DSH_DESKTOP_RUNTIME_ADAPTER = $adapter
$env:DSH_DESKTOP_DEV_URL_FILE = $UrlFile
$env:DSH_DESKTOP_DEV_BOOT_FILE = $BootFile
$env:RUST_LOG = 'dsh_runtime=debug,dsh_gateway=debug,dsh_desktop=debug'
Write-Host "    DSH_DESKTOP_RUNTIME_DIR = $payloadDsh" -ForegroundColor DarkGray
Write-Host "    DSH_DESKTOP_SHELL_DIR   = $env:DSH_DESKTOP_SHELL_DIR" -ForegroundColor DarkGray
Write-Host "    DSH_DESKTOP_DEV_URL_FILE= $UrlFile" -ForegroundColor DarkGray

$proc = Start-Process -FilePath $exe.FullName -PassThru
Write-Host "    pid $($proc.Id)" -ForegroundColor DarkGray

if (-not $Verify) {
  Write-Host ''
  Write-Host "Launched. Diagnostic log and crash reports under $RunHome" -ForegroundColor Green
  Write-Host "Dev gateway URL file: $UrlFile" -ForegroundColor Green
  exit 0
}

# --- 6. Verify the assembled flow -----------------------------------------
Write-Step "Waiting up to ${WaitSeconds}s for host readiness (boot-payload handoff)"
$boot = $null
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  if (Test-Path $BootFile) {
    try {
      $candidate = Get-Content $BootFile -Raw | ConvertFrom-Json
      if ($null -ne $candidate.streamBaseUrl) { $boot = $candidate; break }
    } catch {
      # The file exists but is not yet complete JSON: keep waiting rather than
      # failing, because the write is not atomic from the reader's perspective.
    }
  }
  if ($proc.HasExited) { throw "The application exited early with code $($proc.ExitCode). Check the crash reports under $RunHome." }
  Start-Sleep -Milliseconds 500
}
if ($null -eq $boot) {
  throw "The host never reached 'ready' within ${WaitSeconds}s. The gateway URL file may exist - it is published BEFORE host authentication - but no boot payload was written, which means the host did not boot. Read the crash report's structured host-diagnostic section under $RunHome."
}
Write-Host '    host ready and gateway attached' -ForegroundColor Green
Write-Host "    streamBaseUrl     : $($boot.streamBaseUrl)" -ForegroundColor DarkGray
Write-Host "    bootstrapBatchUrl : $($boot.bootstrapBatchUrl)" -ForegroundColor DarkGray
Write-Host "    graphRevision     : $($boot.graphRevision)" -ForegroundColor DarkGray

# The launch token stays in the URL file and is deliberately absent from the
# boot JSON; read it only now that readiness is established.
$url = (Get-Content $UrlFile -Raw).Trim()
if ([string]::IsNullOrEmpty($url)) { throw 'The boot payload arrived but the dev gateway URL file is empty.' }

$base = [uri]::new($url)
# Parse the launch token without System.Web (not loaded by default on PS 5.1).
$token = $null
foreach ($pair in $base.Query.TrimStart('?').Split('&')) {
  if ($pair -like 'token=*') { $token = [uri]::UnescapeDataString($pair.Substring(6)); break }
}
if ([string]::IsNullOrEmpty($token)) { throw 'The dev gateway URL carried no token; cannot run the assembled check.' }
$origin = "{0}://{1}" -f $base.Scheme, $base.Authority
& node (Join-Path $RepoRoot 'scripts\verify-assembled.mjs') --base $origin --token $token
$result = $LASTEXITCODE

Write-Host ''
if ($result -eq 0) { Write-Host 'ASSEMBLED FLOW: PASS' -ForegroundColor Green }
else { Write-Host 'ASSEMBLED FLOW: FAIL (see steps above and the logs)' -ForegroundColor Red }
Write-Host "The application is still running (pid $($proc.Id)). Close it from the tray to test clean shutdown." -ForegroundColor Yellow
exit $result
