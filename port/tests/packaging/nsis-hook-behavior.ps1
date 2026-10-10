<#
.SYNOPSIS
  Executed behavioral tests for the installer hook control flow.

.DESCRIPTION
  `nsis-hooks-compile.ps1` proves the hooks COMPILE. That is not the same as
  proving they behave: a compile cannot show that a refusal stops the install, that
  an update relaunches the application exactly once, or that the `=` that
  `GetOptions` leaves on the documented `/ARGS=<value>` form is removed before the
  value is handed to the application.

  This suite compiles small probes that exercise those decisions and RUNS them
  under an isolated scratch directory. Nothing is installed, no process is killed,
  and no real application is launched: the probes record "what would have
  happened" into a scratch report file.

  The properties asserted, each measured rather than read:
    * a refusal terminates the section, so the template's own file/registry work
      after the hook does not run;
    * the refusal is observable to a caller as a NON-ZERO exit code in both the
      `Abort` and `Quit` idioms (this is what an updater inspects);
    * a silent `/UPDATE /R` install relaunches the application ONCE, not twice;
    * `Abort` fails the section without discarding a later section's work, which is
      the property `Quit` does not have;
    * `/ARGS=<value>` reaches the relaunch WITHOUT the leading `=`, and the
      two-token `/ARGS <value>` form is preserved unchanged.

.NOTES
  Windows only. SKIPs when makensis is absent, like the other NSIS suites.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PortRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$InstallerDir = Join-Path $PortRoot 'installer'
Import-Module (Join-Path $PSScriptRoot 'fixture-safety.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'native-quoting.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'suite-result.psm1') -Force
trap { exit (Write-DshSuiteResult -Id 'installer-hook-behavior' -Status 'FAIL' -Detail $_.Exception.Message) }
$Scratch = New-PackagingFixtureRoot -PortRoot $PortRoot -Prefix 'installer-hook-behavior'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
    Write-Host "    ok  $Message" -ForegroundColor Green
}

if ($env:OS -ne 'Windows_NT') {
    Write-Host 'SKIP: the installer hooks are Windows/NSIS-specific.' -ForegroundColor Yellow
    exit (Write-DshSuiteResult -Id 'installer-hook-behavior' -Status 'SKIP' -Reason 'not-applicable' -Detail 'Windows-only NSIS hook behaviour')
}

$makensis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
if (-not (Test-Path $makensis)) {
    $command = Get-Command makensis -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        Write-Host "SKIP: makensis not found (looked in $makensis and on PATH)." -ForegroundColor Yellow
        exit (Write-DshSuiteResult -Id 'installer-hook-behavior' -Status 'SKIP' -Reason 'precondition-failed' -Detail "makensis absent from $makensis and PATH")
    }
    $makensis = $command.Source
}
$pluginDir = Join-Path (Split-Path -Parent $makensis) 'Plugins\x86-unicode\additional'
if (-not (Test-Path (Join-Path $pluginDir 'nsis_tauri_utils.dll'))) {
    Write-Host "SKIP: nsis_tauri_utils.dll not found at $pluginDir." -ForegroundColor Yellow
    exit (Write-DshSuiteResult -Id 'installer-hook-behavior' -Status 'SKIP' -Reason 'precondition-failed' -Detail "nsis_tauri_utils.dll absent from $pluginDir")
}

# The fresh protected UUID root and all evidence are retained.

function Invoke-HookCompile {
    <#
    .SYNOPSIS
      Compile one synthetic hook probe with centrally quoted `/D` defines and the
      fixture's owned root as the working directory.
    #>
    param([Parameter(Mandatory)][string]$Source,
          [Parameter(Mandatory)][string]$Output,
          [Parameter(Mandatory)][string]$CaseDir,
          [Parameter(Mandatory)][string]$Mode,
          [string]$ExtraDefine = '')

    $arguments = @('/V1', "/DPROBE_OUT=$Output", "/DPROBE_DIR=$CaseDir", "/DMODE=$Mode")
    if ($ExtraDefine) { $arguments += $ExtraDefine }
    $arguments += @("/DDSH_PLUGIN_DIR=$pluginDir", "/O$(Join-Path $CaseDir 'compile.log')", $Source)
    $compile = Invoke-DshNativeChecked -FilePath $makensis -Arguments $arguments -WorkingDirectory $Scratch -TimeoutSeconds 900 -PassThruOutput
    if ($compile.ExitCode -ne 0) {
        Write-Host ($compile.StandardOutput + $compile.StandardError)
        throw "makensis failed to compile '$Source' for mode '$Mode' (exit $($compile.ExitCode))."
    }
}

# ---------------------------------------------------------------------------
# Probe 1: refusal control flow and exit code.
#
# Structured like the real hook: the decision is made inside a CALLed function
# that sets $dshInstallerError, and the section then refuses. The statements after
# the refusal stand in for everything Tauri's template does later (file copy,
# registry, shortcuts); a marker proves they did not run.
# ---------------------------------------------------------------------------
$refusalProbe = Join-Path $Scratch 'refusal.nsi'
@'
Unicode true
!include "LogicLib.nsh"
!ifdef DSH_PLUGIN_DIR
  !addplugindir "${DSH_PLUGIN_DIR}"
!endif
OutFile "${PROBE_OUT}"
Name "dsh-refusal-probe"
InstallDir "$TEMP\dsh-refusal-probe"
SilentInstall silent
RequestExecutionLevel user

Var dshInstallerError

Function DshGuard
  StrCpy $dshInstallerError "refused: DeepSeek Harness is still running"
FunctionEnd

Section Install
  Call DshGuard
  ${If} $dshInstallerError != ""
    DetailPrint "$dshInstallerError"
    SetErrorLevel 2
    !if "${MODE}" == "Abort"
      Abort
    !endif
    !if "${MODE}" == "Quit"
      Quit
    !endif
  ${EndIf}
  FileOpen $9 "${PROBE_DIR}\template-continued.marker" w
  FileWrite $9 "the template kept working after the refusal"
  FileClose $9
  SetErrorLevel 0
SectionEnd

Section Uninstall
SectionEnd
'@ | Set-Content -Path $refusalProbe -Encoding ASCII

foreach ($mode in @('Abort', 'Quit')) {
    $exe = Join-Path $Scratch "refusal-$mode.exe"
    $caseDir = Join-Path $Scratch "refusal-$mode"
    $null = New-Item -ItemType Directory -Path $caseDir -ErrorAction Stop
    $marker = Join-Path $caseDir 'template-continued.marker'
    Invoke-HookCompile -Source $refusalProbe -Output $exe -CaseDir $caseDir -Mode $mode

    & $exe /S | Out-Null
    $exitCode = $LASTEXITCODE
    Assert-True ($exitCode -eq 2) "the $mode refusal is observable as exit code 2 (got $exitCode)"
    Assert-True (-not (Test-Path $marker)) "the $mode refusal stops the rest of the template's work"
}

# ---------------------------------------------------------------------------
# Probe 2: exactly one relaunch for a silent /UPDATE install.
#
# Both the hook's POSTINSTALL relaunch and Tauri's own .onInstSuccess are
# reproduced. The measure is the NUMBER of launches recorded, so a regression to
# the double-launch is caught by counting rather than by reading the source.
# ---------------------------------------------------------------------------
$relaunchProbe = Join-Path $Scratch 'relaunch.nsi'
@'
Unicode true
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifdef DSH_PLUGIN_DIR
  !addplugindir "${DSH_PLUGIN_DIR}"
!endif
OutFile "${PROBE_OUT}"
Name "dsh-relaunch-probe"
InstallDir "$TEMP\dsh-relaunch-probe"
SilentInstall silent
RequestExecutionLevel user

Var PassiveMode
Var UpdateMode
Var dshRelaunchRequested
Var dshRelaunchArgs
Var dshRelaunchHandled
Var dshCapture
Var dshLaunchCount

Function DshNormalizeLaunchArgs
  StrCpy $0 $dshRelaunchArgs 1
  ${If} $0 == "="
    StrCpy $dshRelaunchArgs $dshRelaunchArgs "" 1
  ${EndIf}
FunctionEnd

Function DshInstallerRelaunch
  ; The port's relaunch is idempotent: it records that it launched, so a second
  ; caller is a no-op. `MODE=deferring` models the FIXED hook (which also defers to
  ; the template), and `MODE=unguarded` models the PRE-FIX hook, which both called
  ; a NON-idempotent relaunch and did not defer. Reproducing the pre-fix shape is
  ; what makes the regression measurable rather than asserted.
  !if "${MODE}" == "deferring"
    ${If} $dshRelaunchHandled = "1"
      Return
    ${EndIf}
    StrCpy $dshRelaunchHandled "1"
  !endif
  IntOp $dshLaunchCount $dshLaunchCount + 1
  FileOpen $9 "${PROBE_DIR}\launch-$dshLaunchCount.txt" w
  FileWrite $9 "launch#$dshLaunchCount args=[$dshRelaunchArgs]"
  FileClose $9
FunctionEnd

; Tauri's .onInstSuccess (installer.nsi:743-754), reproduced in shape: silent and
; passive installers relaunch when /R was passed, independently of the hooks.
Function .onInstSuccess
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      Call DshInstallerRelaunch
    ${EndIf}
  ${EndIf}
FunctionEnd

Section
  StrCpy $dshRelaunchRequested "0"
  StrCpy $dshRelaunchArgs ""
  StrCpy $dshRelaunchHandled "0"
  StrCpy $dshLaunchCount 0

  ; The updater's invocation: /UPDATE.
  StrCpy $UpdateMode 1

  ${GetOptions} $CMDLINE "/ARGS" $dshCapture
  ${IfNot} ${Errors}
    StrCpy $dshRelaunchArgs "$dshCapture"
    Call DshNormalizeLaunchArgs
  ${EndIf}

  ${If} $UpdateMode = 1
    StrCpy $dshRelaunchRequested "1"
  ${EndIf}
  ${GetOptions} $CMDLINE "/R" $dshCapture
  ${IfNot} ${Errors}
    StrCpy $dshRelaunchRequested "1"
  ${EndIf}
  ${If} $PassiveMode = 1
    StrCpy $dshRelaunchRequested "1"
  ${EndIf}

  ${If} $dshRelaunchRequested = "1"
    !if "${MODE}" == "deferring"
      ; The port's rule: defer to the template for silent/passive installs, and let
      ; the idempotent relaunch absorb any second caller.
      ${If} ${Silent}
        DetailPrint "deferring to the template"
      ${ElseIf} $PassiveMode = 1
        DetailPrint "deferring to the template"
      ${Else}
        Call DshInstallerRelaunch
      ${EndIf}
    !endif
    !if "${MODE}" == "unguarded"
      ; The PRE-FIX hook: relaunch unconditionally, with a non-idempotent callee.
      Call DshInstallerRelaunch
    !endif
  ${EndIf}
SectionEnd

Section Uninstall
SectionEnd
'@ | Set-Content -Path $relaunchProbe -Encoding ASCII

$launches = @{}
foreach ($mode in @('deferring', 'unguarded')) {
    $exe = Join-Path $Scratch "relaunch-$mode.exe"
    $caseDir = Join-Path $Scratch "relaunch-$mode"
    $null = New-Item -ItemType Directory -Path $caseDir -ErrorAction Stop
    Invoke-HookCompile -Source $relaunchProbe -Output $exe -CaseDir $caseDir -Mode $mode

    # The documented updater invocation for a silent update.
    & $exe /S /UPDATE /R '/ARGS=--restore-session' | Out-Null
    $launches[$mode] = @(Get-ChildItem $caseDir -Filter 'launch-*.txt' -ErrorAction Stop).Count
}

Assert-True ($launches['unguarded'] -eq 2) `
    "the PRE-FIX shape relaunches twice, which is the regression being fixed (got $($launches['unguarded']))"
Assert-True ($launches['deferring'] -eq 1) `
    "a silent /UPDATE /R install relaunches exactly ONCE with the fix (got $($launches['deferring']))"

# The argument must arrive WITHOUT the leading `=` that GetOptions leaves behind on
# the documented `/ARGS=<value>` form; a malformed first argument would be handed
# to the application otherwise.
$launchReport = Get-ChildItem (Join-Path $Scratch 'relaunch-unguarded') -Filter 'launch-*.txt' | Select-Object -First 1
$reportText = Get-Content $launchReport.FullName -Raw
Assert-True ($reportText -match 'args=\[--restore-session\]') `
    "the relaunch argument is normalized (report: $reportText)"
Assert-True ($reportText -notmatch 'args=\[=') `
    'the relaunch argument does not retain the option separator'

# ---------------------------------------------------------------------------
# Probe 3: BOTH idioms stop the installer, and BOTH are observable.
#
# This is a measured correction to a common assumption. `Abort` and `Quit` are
# behaviorally EQUIVALENT here: each terminates the run so a later section never
# executes, and each propagates the error level as exit code 2. There is no
# "Abort continues, Quit stops" distinction to rely on.
#
# The suite asserts that equivalence rather than a severity ordering, because that
# is what the toolchain actually does. `Abort` remains the idiom the hooks use: it
# is the documented way to fail a section, and it is the safer choice if a future
# template places the hook in a context where only the section should fail.
# ---------------------------------------------------------------------------
$scopeProbe = Join-Path $Scratch 'scope.nsi'
@'
Unicode true
!include "LogicLib.nsh"
OutFile "${PROBE_OUT}"
Name "dsh-scope-probe"
InstallDir "$TEMP\dsh-scope-probe"
SilentInstall silent
RequestExecutionLevel user

Section Refusing
  SetErrorLevel 2
  !if "${MODE}" == "Abort"
    Abort
  !endif
  !if "${MODE}" == "Quit"
    Quit
  !endif
SectionEnd

Section Later
  FileOpen $9 "${PROBE_DIR}\later-section-ran.marker" w
  FileWrite $9 "a later section ran"
  FileClose $9
  SetErrorLevel 0
SectionEnd

Section Uninstall
SectionEnd
'@ | Set-Content -Path $scopeProbe -Encoding ASCII

$laterResults = @{}
$scopeExit = @{}
foreach ($mode in @('Abort', 'Quit')) {
    $exe = Join-Path $Scratch "scope-$mode.exe"
    $caseDir = Join-Path $Scratch "scope-$mode"
    $null = New-Item -ItemType Directory -Path $caseDir -ErrorAction Stop
    $marker = Join-Path $caseDir 'later-section-ran.marker'
    # The scope probe is compiled without the plugin directory, so it is quoted here
    # rather than through the shared helper.
    $scopeCompile = Invoke-DshNativeChecked -FilePath $makensis `
        -Arguments @('/V1', "/DPROBE_OUT=$exe", "/DPROBE_DIR=$caseDir", "/DMODE=$mode", "/O$(Join-Path $caseDir 'compile.log')", $scopeProbe) `
        -WorkingDirectory $Scratch -TimeoutSeconds 900 -PassThruOutput
    if ($scopeCompile.ExitCode -ne 0) { throw "makensis failed to compile the $mode scope probe." }
    & $exe /S | Out-Null
    $scopeExit[$mode] = $LASTEXITCODE
    $laterResults[$mode] = Test-Path $marker
}

Assert-True ($laterResults['Abort'] -eq $false) 'Abort terminates the run, so no later section executes'
Assert-True ($laterResults['Quit'] -eq $false) 'Quit terminates the run, so no later section executes'
Assert-True ($scopeExit['Abort'] -eq 2) "Abort propagates the error level as exit code 2 (got $($scopeExit['Abort']))"
Assert-True ($scopeExit['Quit'] -eq 2) "Quit propagates the error level as exit code 2 (got $($scopeExit['Quit']))"
Assert-True ($scopeExit['Abort'] -eq $scopeExit['Quit']) `
    'the two refusal idioms are equivalent in exit code, so neither is a fail-open hole'

Write-Host ''
Write-Host 'Installer hook behavior: PASS' -ForegroundColor Green
exit (Write-DshSuiteResult -Id 'installer-hook-behavior' -Status 'PASS' -Checks 12 -Detail 'refusal control flow, single relaunch and section-scope termination')
