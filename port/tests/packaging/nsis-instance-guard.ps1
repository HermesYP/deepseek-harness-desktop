<#
.SYNOPSIS
  Runtime-qualify the port's installer instance guard.

.DESCRIPTION
  `port/installer/installer-process.nsh` replaces Tauri's stock
  name-scoped-and-kill behaviour with presence detection plus a
  refuse-or-wait decision. This script compiles that module into a standalone
  probe and exercises its real decisions:

    * nothing running            -> allow
    * running, fresh install     -> refuse
    * running, update (`/UPDATE`) -> refuse after a bounded wait, not hang
    * running then exits          -> allow, once it is gone

  A syntax-only `makensis` compile cannot show any of that, and the module had a
  register-discipline defect that only a runtime test exposed: the presence scan
  clobbered the caller's loop counter, so the guard reported "absent" while an
  instance was demonstrably running.

.SAFETY
  No real installer is executed. Only controlled probes and stand-ins are run.
  Only direct roots with captured and freshly rechecked CIM PID/executable/exact
  creation-time identity may be stopped; no descendants or image-name kills.
  All fixtures, transcripts and probe reports remain in protected UUID roots.

.NOTES
  Windows only, and requires `makensis`. When the toolchain is absent the script
  SKIPS rather than failing, because this is a local qualification check.
#>
[CmdletBinding()]
param(
    [string]$ScratchRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PortRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Import-Module (Join-Path $PSScriptRoot 'fixture-safety.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'native-quoting.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'suite-result.psm1') -Force
trap { exit (Write-DshSuiteResult -Id 'installer-instance-guard' -Status 'FAIL' -Detail $_.Exception.Message) }
$ScratchRoot = New-PackagingFixtureRoot -PortRoot $PortRoot -Prefix 'installer-guard-probe' -RequestedRoot $ScratchRoot
$InstallerDir = Join-Path $PortRoot 'installer'
$ProbeSource = Join-Path $PSScriptRoot 'nsis\process-probe.nsi'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
    Write-Host "    ok  $Message" -ForegroundColor Green
}

if ($env:OS -ne 'Windows_NT') {
    Write-Host 'SKIP: the installer guard is Windows/NSIS-specific.' -ForegroundColor Yellow
    exit (Write-DshSuiteResult -Id 'installer-instance-guard' -Status 'SKIP' -Reason 'not-applicable' -Detail 'Windows-only NSIS guard')
}

$makensis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
if (-not (Test-Path $makensis)) {
    $command = Get-Command makensis -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        Write-Host "SKIP: makensis not found (looked in $makensis and on PATH)." -ForegroundColor Yellow
        exit (Write-DshSuiteResult -Id 'installer-instance-guard' -Status 'SKIP' -Reason 'precondition-failed' -Detail "makensis absent from $makensis and PATH")
    }
    $makensis = $command.Source
}

# nsis_tauri_utils lives in the NSIS toolset's `additional` plugin folder, which
# Tauri's bundler adds for the real installer. The probe needs the same path
# explicitly because `$LOCALAPPDATA` cannot be expanded at NSIS compile time.
$pluginDir = Join-Path (Split-Path -Parent $makensis) 'Plugins\x86-unicode\additional'
$pluginDll = Join-Path $pluginDir 'nsis_tauri_utils.dll'
if (-not (Test-Path $pluginDll)) {
    Write-Host "SKIP: nsis_tauri_utils.dll not found at $pluginDll." -ForegroundColor Yellow
    exit (Write-DshSuiteResult -Id 'installer-instance-guard' -Status 'SKIP' -Reason 'precondition-failed' -Detail "nsis_tauri_utils.dll absent from $pluginDir")
}

# PRECONDITION, checked before anything is compiled or started: the guard's own
# "nothing is running" case is only meaningful when nothing of that name is
# running. A live installation on the machine makes every decision below read as
# 'refuse', which is the guard behaving correctly and not a defect -- so this is
# reported as a precondition skip, never as a pass and never as a failure. The
# process is only OBSERVED (its name and pid are read); it is never stopped, and
# no name-scoped kill is ever issued.
$liveInstances = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'dsh-desktop.exe'" -ErrorAction SilentlyContinue)
if ($liveInstances.Count -gt 0) {
    $identity = ($liveInstances | ForEach-Object { "$($_.ProcessId)" }) -join ', '
    Write-Host "SKIP: a real dsh-desktop.exe is already running (pid $identity); the guard's no-instance precondition is false and it is not stopped here." -ForegroundColor Yellow
    exit (Write-DshSuiteResult -Id 'installer-instance-guard' -Status 'SKIP' -Reason 'precondition-failed' `
        -Detail "a live dsh-desktop.exe (pid $identity) makes the no-instance precondition false; not killed")
}

# The fresh protected UUID root and all evidence are retained.

$probe = Join-Path $ScratchRoot 'dsh-installer-guard-probe.exe'
$log = Join-Path $ScratchRoot 'probe-build.log'

Write-Host '==> Compiling the installer-guard probe' -ForegroundColor Cyan
# Every `/D` define goes through the centralised MSVCRT quoting, and the fixture's
# working directory is the owned root rather than the repository root, so a probe
# that ever wrote a literal report name cannot litter the checkout.
$probeArguments = @('/V2', "/DDSH_INSTALLER_DIR=$InstallerDir", "/DDSH_PROBE_OUT=$probe",
    "/DDSH_INSTALLER_STRINGS=$(Join-Path $InstallerDir 'installer-strings.nsh')",
    "/DDSH_PLUGIN_DIR=$pluginDir", "/O$log", $ProbeSource)
$probeCompile = Invoke-DshNativeChecked -FilePath $makensis -Arguments $probeArguments -WorkingDirectory $ScratchRoot -TimeoutSeconds 900 -PassThruOutput
if ($probeCompile.ExitCode -ne 0) {
    Get-Content $log -ErrorAction SilentlyContinue | Select-Object -Last 20 | ForEach-Object { Write-Host "    $_" }
    throw "makensis failed to compile the guard probe with exit code $($probeCompile.ExitCode)"
}
Assert-True (Test-Path $probe) 'the guard probe compiled'

# The stand-in must be a process that runs happily with NO console. An earlier
# version of this harness used `timeout.exe`/`ping.exe`, which are
# console-subsystem binaries that block when started without one -- the probe
# then appeared to hang, and the cause was the stand-in rather than the guard.
$standIn = Join-Path $ScratchRoot 'inst-a\dsh-desktop.exe'
$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $standIn)
$node = (Get-Command node -ErrorAction Stop).Source
Copy-Item $node $standIn -Force

$targetDir = Split-Path -Parent $standIn

function Invoke-GuardProbe {
    param(
        [Parameter(Mandatory)][ValidateSet('fresh', 'update')][string]$Mode,
        [int]$TimeoutSeconds = 45
    )

    $report = Join-Path $ScratchRoot ("report-{0}-{1}.txt" -f $Mode, [guid]::NewGuid().ToString('N'))
    # One element per argument, quoted centrally. The hand-rolled quoted string
    # that used to live here was the P2 defect: it depended on the caller's quoting
    # rules and would truncate a fixture path containing a space.
    $probeRecord = Start-PackagingFixtureProcess -Root $ScratchRoot -Executable $probe `
        -Arguments @('/TARGETDIR', $targetDir, '/MODENAME', $Mode, '/REPORT', $report)
    $process = $probeRecord.Process
    try {
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            throw "The guard probe did not terminate within ${TimeoutSeconds}s in '$Mode' mode. A bounded wait that does not return is a defect in the guard."
        }
    } finally {
        Stop-PackagingFixtureProcess -Record $probeRecord
    }

    $decision = $null
    $present = $null
    # The probe fails closed on a missing /REPORT (it sets error level 3 before any
    # write), so an absent report is a REFUSAL, never a decision of "allow".
    if (-not (Test-Path $report)) {
        throw "The guard probe wrote no report for '$Mode' mode; the required /REPORT parameter was not received before the write."
    }
    if (Test-Path $report) {
        $lines = Get-Content $report
        $decisionLine = $lines | Where-Object { $_ -like 'PROBE-DECISION=*' } | Select-Object -First 1
        $presentLine = $lines | Where-Object { $_ -like 'PROBE-NAME-RUNNING=*' } | Select-Object -First 1
        if ($decisionLine) { $decision = $decisionLine.Substring('PROBE-DECISION='.Length) }
        if ($presentLine) { $present = [int]$presentLine.Substring('PROBE-NAME-RUNNING='.Length) }
    }
    return [pscustomobject]@{ Decision = $decision; Present = $present; Report = $report }
}

$standInRecord = $null
$standInProcess = $null
try {
    Write-Host '==> Case 1: nothing running' -ForegroundColor Cyan
    $result = Invoke-GuardProbe -Mode 'fresh'
    Assert-True ($result.Decision -eq 'allow') "a fresh install is allowed when nothing is running (decision=$($result.Decision))"
    Assert-True ($result.Present -eq 0) "the scan reports no matching process (present=$($result.Present))"

    Write-Host '==> Case 2: an instance is running, fresh install' -ForegroundColor Cyan
    # A bare idling interpreter. The script text is passed as one argument and
    # kept free of spaces so a shell cannot split it; the stand-in only has to
    # exist and hold the product's image name.
    $standInRecord = Start-PackagingFixtureProcess -Root $ScratchRoot -Executable $standIn -Arguments @('-e', 'setInterval(()=>{},1000)')
    $standInProcess = $standInRecord.Process
    Start-Sleep -Seconds 2
    Assert-True (-not $standInProcess.HasExited) 'the stand-in instance is running'

    $result = Invoke-GuardProbe -Mode 'fresh'
    Assert-True ($result.Present -eq 1) "the scan finds the running instance (present=$($result.Present))"
    Assert-True ($result.Decision -eq 'refuse') "a fresh install is REFUSED while an instance runs (decision=$($result.Decision))"

    Write-Host '==> Case 3: an instance is running, update must wait then refuse' -ForegroundColor Cyan
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $result = Invoke-GuardProbe -Mode 'update'
    $stopwatch.Stop()
    Assert-True ($result.Decision -eq 'refuse') "an update is refused when the instance never exits (decision=$($result.Decision))"
    # The bounded wait must actually have run, and must not have run forever. A
    # guard that returns immediately here would be skipping the wait; one that
    # exceeds the probe timeout would have thrown above.
    Assert-True ($stopwatch.Elapsed.TotalSeconds -ge 9) "the update waited for the bounded period before refusing ($([math]::Round($stopwatch.Elapsed.TotalSeconds, 1))s)"
    Assert-True ($stopwatch.Elapsed.TotalSeconds -lt 45) "the update wait is bounded and returned ($([math]::Round($stopwatch.Elapsed.TotalSeconds, 1))s)"

    Write-Host '==> Case 4: the instance exits; the guard then allows' -ForegroundColor Cyan
    Stop-PackagingFixtureProcess -Record $standInRecord
    $standInRecord = $null
    $standInProcess = $null
    $deadline = [datetime]::UtcNow.AddSeconds(20)
    $allowed = $false
    while ([datetime]::UtcNow -lt $deadline) {
        $result = Invoke-GuardProbe -Mode 'fresh'
        if ($result.Decision -eq 'allow') { $allowed = $true; break }
        Start-Sleep -Milliseconds 500
    }
    Assert-True $allowed 'the guard allows the install once the instance has exited'

    Write-Host '==> Case 5: an update is allowed when nothing is running' -ForegroundColor Cyan
    $result = Invoke-GuardProbe -Mode 'update'
    Assert-True ($result.Decision -eq 'allow') "an update is allowed with no instance running (decision=$($result.Decision))"
} finally {
    if ($null -ne $standInRecord) {
        Stop-PackagingFixtureProcess -Record $standInRecord
    }
}

Write-Host ''
Write-Host 'Installer instance guard: PASS' -ForegroundColor Green
exit (Write-DshSuiteResult -Id 'installer-instance-guard' -Status 'PASS' -Checks 9 -Detail 'allow/refuse/update-wait/exit-then-allow decisions plus a proven bounded wait')
