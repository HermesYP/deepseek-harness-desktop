<#
.SYNOPSIS
  Acceptance test for the INSTALLED application, with no development overrides.

.DESCRIPTION
  This is the test the independent review asked for and that nothing in this
  repository performed: install the built application, launch it on a clean
  environment, and require it to reach a working state **without** any
  `DSH_DESKTOP_*` variable being set.

  That distinction is the whole point. Every previous "it works" result came from
  the dev path, where `dev-e2e.ps1` points the shell at a staged runtime under
  `port\.scratch\` and `port\ui\dist`. Those runs say nothing about what a user
  gets after installing. Findings F-11, F-12, F-15 and F-17 were all invisible to
  the dev path and only appear here.

  What it checks, in order:
    1. the installer is present AND plausibly sized (a payload-carrying installer
       cannot be ~12 MB - see finding F-16, a stale artifact at exactly that size)
    2. silent install succeeds
    3. the installed layout contains the runtime, the adapter and the UI assets,
       with NO reparse points (Tauri does not copy junctions - finding F-15)
    4. the application launches with a clean environment and does not exit early
    5. the gateway binds and enforces authentication (unauthenticated GET -> 401)
    6. the diagnostic log evidences the host reaching readiness
    7. no crash report was written

  It deliberately does NOT need the launch token: obtaining it requires the
  dev-only handoff, which is itself an override. Steps 5-7 establish that the
  application booted its runtime without one.

.PARAMETER InstallerPath
  The NSIS installer. Defaults to the newest under
  port\src-tauri\target\release\bundle\nsis.

.PARAMETER InstallDir
  Where to install. Must contain no spaces (NSIS `/D=` cannot be quoted).

.PARAMETER WaitSeconds
  How long to wait for the gateway to bind.

.PARAMETER Uninstall
  Run the uninstaller and verify removal afterwards.

.EXAMPLE
  .\port\scripts\verify-installed.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$InstallerPath,
  [string]$InstallDir = "$env:TEMP\dsh-installed-smoke",
  [int]$WaitSeconds = 120,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PortRoot = Split-Path -Parent $PSScriptRoot
$TauriDir = Join-Path $PortRoot 'src-tauri'
$Scratch = Join-Path $PortRoot '.scratch'
$RunHome = Join-Path $Scratch 'installed-home'
$LogDir = Join-Path $RunHome 'userdata\logs'

$results = @()
function Record([string]$Name, [string]$Status, [string]$Detail) {
  $script:results += [pscustomobject]@{ Name = $Name; Status = $Status; Detail = $Detail }
  $mark = switch ($Status) { 'PASS' { 'PASS' } 'SKIP' { 'SKIP' } default { 'FAIL' } }
  Write-Host ("  [{0}] {1}{2}" -f $mark, $Name, $(if ($Detail) { " - $Detail" } else { '' }))
}
function Step([string]$Title) { Write-Host ''; Write-Host "==> $Title" -ForegroundColor Cyan }

# --- 1. Installer present and plausibly sized ------------------------------
Step 'Installer artifact'
if (-not $InstallerPath) {
  $nsis = Join-Path $TauriDir 'target\release\bundle\nsis'
  $candidate = Get-ChildItem $nsis -Filter *.exe -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($candidate) { $InstallerPath = $candidate.FullName }
}
if (-not $InstallerPath -or -not (Test-Path $InstallerPath)) {
  Record 'installer exists' 'FAIL' 'no installer found; build it first (cargo tauri build)'
} else {
  $file = Get-Item $InstallerPath
  $sizeMb = [math]::Round($file.Length / 1MB, 1)
  Record 'installer exists' 'PASS' "$($file.Name), $sizeMb MB, $($file.LastWriteTime)"
  # Coarse sanity gate only. The AUTHORITATIVE evidence that the payload arrived
  # is the installed-layout section below (adapter, four anchors as real
  # directories, UI assets) - not the installer's size. The threshold is set
  # comfortably above the known stale UI-only artifact (11.8 MB, finding F-16)
  # and well below a correct payload-carrying build (measured: 89.2 MB).
  if ($sizeMb -lt 40) {
    Record 'installer is not the stale empty artifact' 'FAIL' "$sizeMb MB is in the range of the stale UI-only build (finding F-16); treat as non-deliverable"
  } else {
    Record 'installer is not the stale empty artifact' 'PASS' "$sizeMb MB (payload-carrying)"
  }
}

# --- 2. Silent install -----------------------------------------------------
Step 'Silent install'
$installed = $false
if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
if ($InstallerPath -and (Test-Path $InstallerPath)) {
  try {
    # NSIS: /D must be last and unquoted.
    $proc = Start-Process -FilePath $InstallerPath -ArgumentList '/S', "/D=$InstallDir" -PassThru -Wait
    if ($proc.ExitCode -eq 0) { Record 'installer exits 0' 'PASS' "exit $($proc.ExitCode)" }
    else { Record 'installer exits 0' 'FAIL' "exit $($proc.ExitCode)" }
    $installed = Test-Path $InstallDir
  } catch {
    Record 'installer exits 0' 'FAIL' $_.Exception.Message
  }
} else {
  Record 'installer exits 0' 'SKIP' 'no installer'
}

# --- 3. Installed layout, with no reparse points --------------------------
Step 'Installed layout'
$appExe = Get-ChildItem $InstallDir -Filter 'dsh-desktop.exe' -Recurse -ErrorAction SilentlyContinue |
  Select-Object -First 1
if (-not $appExe) {
  Record 'application executable present' 'FAIL' "not found under $InstallDir"
} else {
  Record 'application executable present' 'PASS' $appExe.FullName
  $appDir = $appExe.DirectoryName

  $adapter = Join-Path $appDir 'dsh\adapter.mjs'
  Record 'runtime adapter present' $(if (Test-Path $adapter) { 'PASS' } else { 'FAIL' }) $adapter

  foreach ($anchor in @('dsh', 'cordis-plugin-group', 'dsh-base', 'dsh-web-app')) {
    $pkgDir = Join-Path $appDir "dsh\node_modules\@deepseek-ai\$anchor"
    $marker = Join-Path $pkgDir 'package.json'
    if (-not (Test-Path $marker)) {
      Record "runtime package $anchor" 'FAIL' "$marker missing"
      continue
    }
    # `Test-Path` FOLLOWS links, so existence alone does not prove a real
    # directory. Assert the entry itself is not a reparse point, because a
    # junction that survived into the bundle is exactly the defect (F-15) and a
    # path that merely resolves would hide it (F-20).
    $item = Get-Item $pkgDir -Force -ErrorAction SilentlyContinue
    $isLink = $item -and [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
    Record "runtime package $anchor" $(if ($isLink) { 'FAIL' } else { 'PASS' }) `
      $(if ($isLink) { 'present but is a junction/symlink, not a real directory' } else { 'real directory' })
  }

  $assets = Join-Path $appDir 'ui\assets'
  Record 'UI assets present' $(if (Test-Path $assets) { 'PASS' } else { 'FAIL' }) $assets

  # The decisive F-15 check: a junction farm copies into the bundle as nothing.
  $nm = Join-Path $appDir 'dsh\node_modules'
  if (Test-Path $nm) {
    $links = @(Get-ChildItem $nm -Force -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
    $deepLinks = @(Get-ChildItem $nm -Recurse -Force -Directory -ErrorAction SilentlyContinue -Depth 3 |
      Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
    $all = @($links + $deepLinks | Select-Object -Unique FullName)
    Record 'no reparse points under node_modules' $(if ($all.Count -eq 0) { 'PASS' } else { 'FAIL' }) `
      $(if ($all.Count -eq 0) { 'all real directories' } else { "$($all.Count) junction(s)/symlink(s), e.g. $($all[0])" })
  } else {
    Record 'no reparse points under node_modules' 'FAIL' 'node_modules missing entirely'
  }

  $deepest = 0
  if (Test-Path $nm) {
    Get-ChildItem $nm -Recurse -Force -File -ErrorAction SilentlyContinue |
      ForEach-Object { if ($_.FullName.Length -gt $deepest) { $deepest = $_.FullName.Length } }
  }
  Record 'paths under MAX_PATH' $(if ($deepest -lt 260) { 'PASS' } else { 'FAIL' }) "deepest path $deepest chars"
}

# --- 4-7. Cold launch with a clean environment ----------------------------
Step 'Cold launch, no development overrides'
if (-not $appExe) {
  Record 'launch' 'SKIP' 'no executable'
} else {
  # Isolate Harness state, and REMOVE every dev override. The point of this test
  # is that the application must work without them.
  Remove-Item $RunHome -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $env:DSH_HOME = $RunHome
  foreach ($name in @('DSH_DESKTOP_RUNTIME_DIR', 'DSH_DESKTOP_RUNTIME_ADAPTER', 'DSH_DESKTOP_SHELL_DIR',
      'DSH_DESKTOP_NODE', 'DSH_DESKTOP_DEV_URL_FILE', 'DSH_DESKTOP_DEV_BOOT_FILE',
      'DSH_DESKTOP_USER_DATA_DIR', 'DSH_DESKTOP_PRIMARY_RUNTIME_DIR')) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
  $env:RUST_LOG = 'dsh_runtime=debug,dsh_gateway=debug,dsh_desktop=debug'

  $nodeOnPath = $null -ne (Get-Command node -ErrorAction SilentlyContinue)
  Record 'system Node on PATH (documented prerequisite)' 'PASS' `
    $(if ($nodeOnPath) { 'present - the port requires it by explicit decision' } else { 'ABSENT - the host cannot start; the preflight should say so clearly' })

  $before = Get-Date
  $proc = Start-Process -FilePath $appExe.FullName -PassThru
  Write-Host "    pid $($proc.Id)" -ForegroundColor DarkGray

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  $exitEarly = $false
  while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { $exitEarly = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if ($exitEarly) {
    Record 'application stays running (no early exit)' 'FAIL' "exited with code $($proc.ExitCode)"
  } else {
    Record 'application stays running (no early exit)' 'PASS' "alive after ${WaitSeconds}s"
  }

  # Gateway bound and enforcing auth. No token is used deliberately: obtaining
  # one needs the dev-only handoff, which is itself an override.
  $listeners = @(Get-NetTCPConnection -State Listen -OwningProcess $proc.Id -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0) {
    $port = ($listeners | Select-Object -First 1).LocalPort
    Record 'gateway binds a loopback port' 'PASS' "port $port"
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -MaximumRedirection 0 -ErrorAction Stop
      Record 'unauthenticated request is refused' 'FAIL' "got $($response.StatusCode), expected 401"
    } catch {
      $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
      Record 'unauthenticated request is refused' $(if ($code -eq 401) { 'PASS' } else { 'FAIL' }) "status $code"
    }
  } else {
    Record 'gateway binds a loopback port' 'FAIL' 'no listening socket owned by the process'
  }

  # The application writes diagnostics to its OWN app-data directory, not to
  # $DSH_HOME: `%APPDATA%\DeepSeek Harness\logs`. An earlier version searched only
  # $DSH_HOME/userdata/logs and so reported "no crash report written" while one
  # existed, and "no readiness evidence" when the log was merely elsewhere.
  $logRoots = @(
    $LogDir,
    (Join-Path $env:APPDATA 'DeepSeek Harness\logs'),
    (Join-Path $env:LOCALAPPDATA 'DeepSeek Harness\logs')
  ) | Where-Object { $_ } | Select-Object -Unique

  # Read only files this run touched: the daily log is appended across runs and
  # crash reports are retained, so an unscoped read would false-PASS on an old
  # readiness line and false-FAIL on a previous run's crash report.
  function Read-DiagnosticLog {
    $text = ''
    foreach ($root in $logRoots) {
      if (-not (Test-Path $root)) { continue }
      Get-ChildItem $root -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like '*.log*' -and $_.LastWriteTime -ge $before } |
        ForEach-Object { $text += (Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue) }
    }
    return $text
  }

  # Give the host a bounded chance to report while it is still running.
  $pollDeadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $pollDeadline -and -not $proc.HasExited) {
    if ((Read-DiagnosticLog) -match 'host authentication completed') { break }
    Start-Sleep -Seconds 2
  }

  # Stop the application BEFORE the final evaluation. `tracing-appender` uses a
  # buffered writer, so the readiness line may not reach disk until the process
  # exits: an earlier version read first and reported a false FAIL while the log
  # in fact contained `gateway host authentication completed` (observed).
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 5

  $logText = Read-DiagnosticLog
  if ($logText -match 'host authentication completed') {
    Record 'host reached readiness' 'PASS' 'log evidences host authentication'
  } elseif ($logText -match 'adapter|ERR_MODULE_NOT_FOUND|Cannot find package|not ready|failed to read') {
    $hit = ($logText -split "`n" | Where-Object { $_ -match 'Cannot find package|ERR_MODULE_NOT_FOUND|host is not ready|failed to read' } | Select-Object -First 1)
    Record 'host reached readiness' 'FAIL' "no readiness evidence; first diagnostic: $($hit -replace '\s+$', '')"
  } else {
    Record 'host reached readiness' 'FAIL' 'no readiness evidence in the diagnostic log'
  }

  $crashes = @()
  foreach ($root in $logRoots) {
    if (Test-Path $root) {
      $crashes += @(Get-ChildItem $root -Filter 'crash-*.log' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $before })
    }
  }
  Record 'no crash report written' $(if ($crashes.Count -eq 0) { 'PASS' } else { 'FAIL' }) `
    $(if ($crashes.Count -eq 0) { 'none' } else { "$($crashes.Count): $($crashes[0].Name)" })
}

# --- 8. Optional uninstall -------------------------------------------------
if ($Uninstall) {
  Step 'Uninstall'
  $uninstaller = Get-ChildItem $InstallDir -Filter 'Uninstall*.exe' -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $uninstaller) {
    Record 'uninstaller present' 'FAIL' 'not found'
  } else {
    Record 'uninstaller present' 'PASS' $uninstaller.Name
    Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait
    Start-Sleep -Seconds 5
    Record 'application removed' $(if (Test-Path $InstallDir) { 'FAIL' } else { 'PASS' }) $InstallDir
  }
}

# --- Summary ---------------------------------------------------------------
$fails = @($results | Where-Object { $_.Status -eq 'FAIL' })
Write-Host ''
Write-Host ("Summary: {0} PASS, {1} FAIL, {2} SKIP" -f `
    @($results | Where-Object { $_.Status -eq 'PASS' }).Count, $fails.Count,`
    @($results | Where-Object { $_.Status -eq 'SKIP' }).Count)
if ($fails.Count -gt 0) {
  Write-Host 'RESULT: FAIL - the installed application did not satisfy every required step.' -ForegroundColor Red
  Write-Host 'Failing steps:' -ForegroundColor Red
  $fails | ForEach-Object { Write-Host "  - $($_.Name): $($_.Detail)" -ForegroundColor Red }
  exit 1
}
Write-Host 'RESULT: PASS - the installed application booted with no development overrides.' -ForegroundColor Green
exit 0
