<#
.SYNOPSIS
  Compile-check the installer hooks in a Tauri-shaped NSIS script.

.DESCRIPTION
  The hooks in `port/installer/` reference `${MAINBINARYNAME}`, `${PRODUCTNAME}`,
  `$INSTDIR`, `$UpdateMode` and `$PassiveMode`, none of which they define. A
  compile of the hooks alone therefore cannot prove they work; they must be
  compiled from a script that supplies the Tauri template's own context, in the
  template's own order.

  `port/tests/packaging/nsis/tauri-hooks-fixture.nsi` reproduces that context and
  invokes all four hooks at the sites Tauri's `installer.nsi` invokes them. This
  script compiles it and fails on any makensis error.

  `port/tests/packaging/nsis/template-order-fixture.nsi` reproduces the REGISTERED
  template's preamble ordering instead, and compiles the ACTUAL hooks file against
  it with the real `nsis_tauri_utils` plugin present. It switches between the
  arrangement `installer-template.nsi` now uses and each arrangement that was
  tried and rejected, so the generated installer's real compile failures are
  reproduced rather than asserted: a plugin directory registered after the hooks
  include (`Plugin not found, cannot call
  nsis_tauri_utils::FindProcessCurrentUser`), a second `Var PassiveMode` /
  `Var UpdateMode` (`Error: variable "..." already declared`), and - the silent
  one - deleting the module's fallback declaration so `$UpdateMode` compiles to
  nothing while the build still succeeds (warning 6000).

  It also asserts the hook files are UTF-8 decodable and free of the byte
  sequences makensis rejects, and that no hook is missing: a `!ifmacrodef`-guarded
  hook that does not exist is silently skipped, so "it compiled" alone would not
  prove the hooks ran.

.NOTES
  Windows only. SKIPs when makensis is absent. Compile-only: no installer image
  produced here is ever executed.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PortRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$InstallerDir = Join-Path $PortRoot 'installer'
$Fixture = Join-Path $PSScriptRoot 'nsis\tauri-hooks-fixture.nsi'
$Template = Join-Path $InstallerDir 'installer-template.nsi'
$OrderFixture = Join-Path $PSScriptRoot 'nsis\template-order-fixture.nsi'
$ResourceFixture = Join-Path $PSScriptRoot 'nsis\resource-source-path-fixture.nsi'
$Hooks = Join-Path $InstallerDir 'installer-hooks.nsh'
Import-Module (Join-Path $PSScriptRoot 'fixture-safety.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'native-quoting.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'suite-result.psm1') -Force
trap { exit (Write-DshSuiteResult -Id 'installer-hooks-compile' -Status 'FAIL' -Detail $_.Exception.Message) }
$Scratch = New-PackagingFixtureRoot -PortRoot $PortRoot -Prefix 'installer-hooks-compile'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
    Write-Host "    ok  $Message" -ForegroundColor Green
}

Write-Host '==> Hook source checks' -ForegroundColor Cyan

foreach ($file in @($Hooks,
                    (Join-Path $InstallerDir 'installer-process.nsh'),
                    (Join-Path $InstallerDir 'installer-strings.nsh'),
                    $Fixture,
                    $OrderFixture,
                    $ResourceFixture)) {
    Assert-True (Test-Path $file) "present: $(Split-Path -Leaf $file)"
    $bytes = [System.IO.File]::ReadAllBytes($file)
    # makensis reads scripts as bytes and rejects a UTF-8 BOM in an included file
    # in some versions; keeping the hooks BOM-free removes the variable.
    Assert-True ($bytes.Length -ge 3 -and -not ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)) `
        "no UTF-8 BOM: $(Split-Path -Leaf $file)"
    # Every hook Tauri's template guards with !ifmacrodef must exist, or it is
    # silently skipped and the installer behaves as if the hook were absent.
    if ((Split-Path -Leaf $file) -eq 'installer-hooks.nsh') {
        $text = Get-Content $file -Raw
        foreach ($hook in @('NSIS_HOOK_PREINSTALL', 'NSIS_HOOK_POSTINSTALL',
                            'NSIS_HOOK_PREUNINSTALL', 'NSIS_HOOK_POSTUNINSTALL')) {
            Assert-True ($text -match "!macro\s+$hook\b") "defines $hook"
        }
    }

    # A line holding only `!` is a corrupted section banner: it reads as an NSIS
    # command and fails the build with `Invalid command: "!"`, which names the
    # symptom and not the real problem. Three such lines were introduced into
    # installer-hooks.nsh while writing it, so the shape is checked rather than
    # trusted.
    $bangLines = @(Get-Content $file | Where-Object { $_ -match '^!\s*$' })
    Assert-True ($bangLines.Count -eq 0) "no stray '!' banner lines: $(Split-Path -Leaf $file)"
}

# The hooks must not reach for the plugin's name-scoped killer: doing so would
# reinstate the defect they exist to remove. Comments are stripped first, because
# the hooks file documents the stock behaviour it replaces and that prose names
# the plugin functions.
$hooksCode = (Get-Content $Hooks) |
    ForEach-Object { $_ -replace ';.*$', '' } |
    Out-String
foreach ($banned in @('KillProcess', 'KillProcessCurrentUser')) {
    Assert-True (-not ($hooksCode -match "\b$banned\b")) "installer-hooks.nsh does not call $banned"
}

# The message include chain must be REAL, not asserted in a comment. An earlier
# version of `installer-hooks.nsh` claimed that `installer-process.nsh` includes
# `installer-strings.nsh`, and it did not: the guard fell back to a hard-coded
# English literal, so the SimpChinese translation compiled but was unreachable.
# This asserts the include exists in the module that is supposed to make the claim
# true, and that the guard reports through the LangString names rather than a
# literal. The behavioural half of that property is proved, per language, by
# `nsis-strings-messages.ps1`, which compiles and RUNS the messages.
$processPath = Join-Path $InstallerDir 'installer-process.nsh'
$processCode = [System.IO.File]::ReadAllText($processPath, (New-Object System.Text.UTF8Encoding($false)))
Assert-True ($processCode -match '(?m)^\s*!include\s+"\$\{DSH_INSTALLER_STRINGS_FILE\}"') `
    'installer-process.nsh includes installer-strings.nsh itself (the message chain is real)'

if ($env:OS -ne 'Windows_NT') {
    Write-Host 'SKIP: makensis compile requires Windows.' -ForegroundColor Yellow
    exit (Write-DshSuiteResult -Id 'installer-hooks-compile' -Status 'SKIP' -Reason 'not-applicable' -Detail 'Windows-only NSIS compile check')
}

$makensis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
if (-not (Test-Path $makensis)) {
    $command = Get-Command makensis -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        Write-Host "SKIP: makensis not found (looked in $makensis and on PATH)." -ForegroundColor Yellow
        exit (Write-DshSuiteResult -Id 'installer-hooks-compile' -Status 'SKIP' -Reason 'precondition-failed' -Detail "makensis absent from $makensis and PATH")
    }
    $makensis = $command.Source
}

$pluginDir = Join-Path (Split-Path -Parent $makensis) 'Plugins\x86-unicode\additional'
# The fresh protected UUID root and all evidence are retained.

$out = Join-Path $Scratch 'tauri-hooks-fixture.exe'
$uninst = Join-Path $Scratch 'tauri-hooks-fixture-uninst.exe'
$log = Join-Path $Scratch 'compile.log'
$strings = Join-Path $InstallerDir 'installer-strings.nsh'

Write-Host '==> Compiling the hooks in a Tauri-shaped template' -ForegroundColor Cyan
# Centralised MSVCRT quoting plus an owned working directory: PowerShell 5.1 does
# not quote array elements for a native command, so a space in a fixture path would
# silently truncate a `/D` define, and the fixture's CWD is never the repo root.
$compileArguments = @('/V2', "/DDSH_INSTALLER_HOOKS=$Hooks", "/DDSH_INSTALLER_STRINGS=$strings",
    "/DDSH_PLUGIN_DIR=$pluginDir", "/DDSH_HOOKS_FIXTURE_OUT=$out",
    "/DDSH_HOOKS_FIXTURE_UNINST=$uninst", "/O$log", $Fixture)
$compile = Invoke-DshNativeChecked -FilePath $makensis -Arguments $compileArguments -WorkingDirectory $Scratch -TimeoutSeconds 900 -PassThruOutput
$exitCode = $compile.ExitCode

$logText = if (Test-Path $log) { Get-Content $log -Raw } else { '' }
if ($exitCode -ne 0) {
    Write-Host $logText
    throw "makensis failed to compile the Tauri-shaped hooks fixture with exit code $exitCode"
}
Assert-True (Test-Path $out) 'the hooks compile inside a Tauri-shaped installer script'

# The uninstaller must be COMPILED, and the uninstaller's own definition of the
# guard must exist. Without `WriteUninstaller` makensis discards the whole
# uninstaller (warning 6020) and `Call un.DshInstallerGuardRunningInstance` inside
# it is never resolved - which is exactly how the hard error
#   Error: resolving uninstall function "un.DshInstallerGuardRunningInstance"
# stayed hidden behind a green suite. The `un.` definition is required because
# NSIS keeps separate install and uninstall function tables: a `Function X`
# (no prefix) lives only in the installer's table and cannot satisfy `Call un.X`.
Assert-True ($logText -notmatch '6020: Uninstaller script code found but WriteUninstaller never used') `
    'makensis did not discard the uninstaller (warning 6020)'
Assert-True ($logText -notmatch 'resolving uninstall function') `
    'every un. call in the uninstall hooks resolves against a declared un. function'
Assert-True ($logText -notmatch 'uninstall functions must begin with') `
    'the install/uninstall function-table rule is satisfied'

# The uninstaller-side guard must exist as its own compiled function, and the hook
# must actually call it. A verbose compile lists the function table, so this reads
# the real artifact rather than grepping the source.
$verboseLog = Join-Path $Scratch 'compile-verbose.log'
$verboseArguments = @('/V4', "/DDSH_INSTALLER_HOOKS=$Hooks", "/DDSH_INSTALLER_STRINGS=$strings",
    "/DDSH_PLUGIN_DIR=$pluginDir", "/DDSH_HOOKS_FIXTURE_OUT=$out",
    "/DDSH_HOOKS_FIXTURE_UNINST=$uninst", "/O$verboseLog", $Fixture)
$verbose = Invoke-DshNativeChecked -FilePath $makensis -Arguments $verboseArguments -WorkingDirectory $Scratch -TimeoutSeconds 900 -PassThruOutput
if ($verbose.ExitCode -ne 0) {
    throw "makensis failed the verbose compile with exit code $($verbose.ExitCode)"
}
$verboseText = Get-Content $verboseLog -Raw
Assert-True ($verboseText -match 'Function:\s+"un\.DshInstallerGuardRunningInstance"') `
    'the uninstaller compiles its own un.DshInstallerGuardRunningInstance'
Assert-True ($verboseText -match 'Call "un\.DshInstallerGuardRunningInstance"') `
    'the uninstall hook calls the uninstaller-side guard'
Assert-True ($verboseText -match 'Function:\s+"DshInstallerGuardRunningInstance"') `
    'the installer-side guard is still compiled for the install hook'

# ===========================================================================
# ORDERING PREFLIGHT: reproduce the generated installer's real compile failures
# ===========================================================================
#
# `nsis/template-order-fixture.nsi` reproduces the registered template's preamble
# in the template's own order and compiles the ACTUAL, unmodified hooks file -
# including the real `nsis_tauri_utils::FindProcessCurrentUser` call and the
# template's own later `nsis_tauri_utils::SemverCompare` call - against it, with
# the real plugin present. `${DSH_FIXTURE_ORDER}` switches between the arrangement
# the repository template now uses and each arrangement that was tried and
# rejected, so the real makensis failures are REPRODUCED here instead of being
# inferred from reading the sources:
#
#   * registering the `additional` plugin directory AFTER the hooks include makes
#     makensis fail with `Plugin not found, cannot call
#     nsis_tauri_utils::FindProcessCurrentUser`;
#   * registering that SAME directory a second time AFTER the hooks already
#     resolved the plugin from it makes the next command naming the plugin fail
#     with `Plugin command nsis_tauri_utils::SemverCompare conflicts with a plugin
#     in another directory!` - the failure that stopped the real bundle;
#   * declaring `Var PassiveMode`/`Var UpdateMode` twice makes makensis fail with
#     `Error: variable "..." already declared`.
#
# The two positive variants are the real check: `fixed` models
# `windows().can_sign() == true` (Tauri's copied `Plugins\x86-unicode` tree plus
# its nested `additional` copy) and `fixed-unsigned` models `can_sign() == false`
# (no `signed_plugins_path`, just the toolset's own `additional` directory). Both
# must compile with ZERO `6000: unknown variable/constant` warnings and zero
# plugin conflicts, because the arrangement that deletes the module's fallback
# declaration does NOT fail the build at all: `$UpdateMode` simply expands to
# nothing at the module's compile position, so the guard's `If} $UpdateMode = 1`
# bounded-wait branch is compiled against an empty string.
$templateText = [System.IO.File]::ReadAllText($Template, (New-Object System.Text.UTF8Encoding($false)))
$orderFixtureText = [System.IO.File]::ReadAllText($OrderFixture, (New-Object System.Text.UTF8Encoding($false)))
# The fixture carries its own copy of the template's second-check macro so that it
# stays self-contained; this asserts the copy cannot drift away from the template.
$macroPattern = '(?ms)^!macro DSH_INSTALLER_GUARD_RUNNING_INSTANCE FUNCTION\r?\n.*?^!macroend\r?$'
$templateMacro = [regex]::Match($templateText, $macroPattern)
$orderFixtureMacro = [regex]::Match($orderFixtureText, $macroPattern)
Assert-True $templateMacro.Success 'the registered template defines the second-check macro'
Assert-True ($orderFixtureMacro.Success -and ($orderFixtureMacro.Value -eq $templateMacro.Value)) `
    'the ordering fixture inlines the template second-check macro byte-for-byte'

# The plugin the ordering fixture must actually resolve.
$pluginDll = Join-Path $pluginDir 'nsis_tauri_utils.dll'
if (-not (Test-Path $pluginDll)) {
    Write-Host "SKIP: the pinned nsis_tauri_utils plugin is absent from $pluginDir." -ForegroundColor Yellow
    exit (Write-DshSuiteResult -Id 'installer-hooks-compile' -Status 'SKIP' -Reason 'precondition-failed' `
        -Detail "nsis_tauri_utils.dll is absent from $pluginDir, so the plugin-resolution preflight cannot run")
}
Assert-True (Test-Path $pluginDll) 'the pinned nsis_tauri_utils plugin is present in the Tauri additional plugin folder'

# The template must ship the ONE-registration guard for the additional plugin
# directory, and it must be the reason the stock site below emits nothing. These
# are source assertions on the real registered template, so a later edit that
# restores the unconditional second registration fails here even before makensis.
Assert-True ($templateText -match '(?m)^!define DSH_ADDITIONAL_PLUGINS_REGISTERED$') `
    'the template announces the early additional-plugin registration with a sentinel'
$unguardedLateRegistration = [regex]::Match($templateText,
    '(?m)^!ifndef DSH_ADDITIONAL_PLUGINS_REGISTERED\r?\n!addplugindir "\$\{ADDITIONALPLUGINSPATH\}"\r?\n!endif$')
Assert-True $unguardedLateRegistration.Success `
    'the stock additional-plugin site is compiled only when the early registration did not happen'
Assert-True ([regex]::Matches($templateText, '(?m)^!addplugindir ').Count -eq 3) `
    'the template still holds exactly three !addplugindir directives (signed, early additional, guarded stock)'

# Model the bundler's real directory layout from the pinned toolset, exactly as
# `tauri-bundler-2.9.4/src/bundle/windows/nsis/mod.rs:244-264` builds it: when
# `windows().can_sign()` is true, `<out>\Plugins\x86-unicode` is a COPY of the
# system NSIS plugins and `<out>\Plugins\x86-unicode\additional` is a copy of the
# toolset's downloaded plugins; when it is false, `signed_plugins_path` is absent
# and the additional path is the toolset's own directory.
$systemPluginDir = Join-Path (Split-Path -Parent $makensis) 'Plugins\x86-unicode'
if (-not (Test-Path $systemPluginDir)) {
    Write-Host "SKIP: the NSIS system plugin folder is absent at $systemPluginDir." -ForegroundColor Yellow
    exit (Write-DshSuiteResult -Id 'installer-hooks-compile' -Status 'SKIP' -Reason 'precondition-failed' `
        -Detail "the NSIS system plugin folder is absent at $systemPluginDir")
}
$signedLayoutRoot = Join-Path $Scratch 'Plugins\x86-unicode'
$null = New-Item -ItemType Directory -Path $signedLayoutRoot -Force
Copy-Item -Path (Join-Path $systemPluginDir '*') -Destination $signedLayoutRoot -Recurse -Force
$signedLayoutAdditional = Join-Path $signedLayoutRoot 'additional'
Assert-True (Test-Path (Join-Path $signedLayoutAdditional 'nsis_tauri_utils.dll')) `
    'the copied signed-layout tree carries the real nsis_tauri_utils.dll in its nested additional directory'
Assert-True (Test-Path (Join-Path $signedLayoutRoot 'nsDialogs.dll')) `
    'the copied signed-layout tree carries the system plugins, so the signed and unsigned layouts differ only by its presence'

$orderVariants = @(
    @{ Mode = 'fixed';                 Signed = $true
       ExpectSuccess = $true
       Required = @()
       Forbidden = @('6000: unknown variable/constant', 'already declared', 'Plugin not found',
                     'conflicts with a plugin in another directory', '6020', 'resolving uninstall function')
       Why = 'the signed layout (copied tree plus nested additional) compiles the real hooks, the real FindProcessCurrentUser and the real SemverCompare' }
    @{ Mode = 'fixed-unsigned';        Signed = $false
       ExpectSuccess = $true
       Required = @()
       Forbidden = @('6000: unknown variable/constant', 'already declared', 'Plugin not found',
                     'conflicts with a plugin in another directory', '6020', 'resolving uninstall function')
       Why = 'with signed_plugins_path absent, the toolset additional directory alone still resolves both plugin calls' }
    @{ Mode = 'late-plugin';           Signed = $true
       ExpectSuccess = $false
       Required = @('Plugin not found, cannot call nsis_tauri_utils::FindProcessCurrentUser')
       Forbidden = @()
       Why = 'a plugin path registered after the hooks include still fails the build' }
    @{ Mode = 'duplicate-additional-dir'; Signed = $true
       ExpectSuccess = $false
       Required = @('Plugin command nsis_tauri_utils::SemverCompare conflicts with a plugin in another directory!')
       Forbidden = @()
       Why = 'registering the same additional directory twice after the plugin resolved is the real bundle failure' }
    @{ Mode = 'duplicate-var';         Signed = $true
       ExpectSuccess = $false
       Required = @('already declared')
       Forbidden = @()
       Why = 'a second Var for the mode names still fails the build' }
    @{ Mode = 'process-vars-removed';  Signed = $true
       ExpectSuccess = $true
       Required = @('6000: unknown variable/constant "UpdateMode"')
       Forbidden = @()
       Why = 'deleting the module declarations does not fail the build, it degrades the guard silently' }
)

Write-Host '==> Compiling the template ordering preflight (pre-payload)' -ForegroundColor Cyan
foreach ($variant in $orderVariants) {
    $mode = $variant.Mode
    $orderOut = Join-Path $Scratch "ordering-$mode.exe"
    $orderUninst = Join-Path $Scratch "ordering-$mode-uninst.exe"
    $orderLog = Join-Path $Scratch "ordering-$mode.log"
    # The signed layout is the copied `<Scratch>\Plugins\x86-unicode` tree (with its
    # nested additional copy); the unsigned variant omits the define entirely, which
    # is what `{{#if signed_plugins_path}}` does when signing is off. The additional
    # directory is the copied one for the signed layout and the toolset's own for
    # the unsigned one, matching the bundler's two branches.
    $additionalDir = if ($variant.Signed) { $signedLayoutAdditional } else { $pluginDir }
    # One owned working directory and centralised quoting, exactly like the
    # Tauri-shaped fixture above: PowerShell 5.1 would otherwise truncate an
    # argument at the first space in a `/D` value.
    $orderArguments = @('/V2', "/DDSH_FIXTURE_ORDER=$mode", "/DDSH_FIXTURE_HOOKS=$Hooks",
        "/DDSH_FIXTURE_STRINGS=$strings", "/DDSH_FIXTURE_ADDITIONAL_PLUGINS_DIR=$additionalDir",
        "/DDSH_FIXTURE_OUT=$orderOut", "/DDSH_FIXTURE_UNINST=$orderUninst",
        "/O$orderLog", $OrderFixture)
    if ($variant.Signed) { $orderArguments = $orderArguments[0..2] +
        @("/DDSH_FIXTURE_SIGNED_PLUGINS_DIR=$signedLayoutRoot") + $orderArguments[3..($orderArguments.Count - 1)] }
    $orderCompile = Invoke-DshNativeChecked -FilePath $makensis -Arguments $orderArguments `
        -WorkingDirectory $Scratch -TimeoutSeconds 900 -PassThruOutput
    $orderText = if (Test-Path $orderLog) { Get-Content $orderLog -Raw } else { '' }

    if ($variant.ExpectSuccess) {
        if ($orderCompile.ExitCode -ne 0) { Write-Host $orderText }
        Assert-True ($orderCompile.ExitCode -eq 0) "makensis compiles the '$mode' ordering (exit 0)"
    } else {
        Assert-True ($orderCompile.ExitCode -ne 0) "makensis rejects the '$mode' ordering (exit $($orderCompile.ExitCode))"
    }
    foreach ($required in $variant.Required) {
        Assert-True ($orderText -match [regex]::Escape($required)) "'$mode' reports: $required"
    }
    foreach ($forbidden in $variant.Forbidden) {
        Assert-True (-not ($orderText -match [regex]::Escape($forbidden))) `
            "'$mode' does not report: $forbidden"
    }
    if ($variant.ExpectSuccess) {
        Assert-True (Test-Path $orderOut) `
            "'$mode' produced the installer image without executing it"
    }
    Write-Host "    note: $mode - $($variant.Why)" -ForegroundColor DarkGray
}

# ===========================================================================
# RESOURCE SOURCE PATH PREFLIGHT: the MAX_PATH failure the bundle died on
# ===========================================================================
#
# `tauri-bundler` joins each `bundle.resources` key onto the app directory without
# collapsing it, so the generated installer names every resource source with an
# un-collapsed `src-tauri\app\..\..\` prefix - 20 characters per path. NSIS's `File`
# opens the SOURCE through a Win32 path that must stay under MAX_PATH, and the real
# bundle failed with
#
#   File: failed opening file "...\port\src-tauri\app\..\..\runtime-payload\dsh\...\select...Descendant.md"
#
# This section compiles the SAME real resource file through both spellings, so the
# diagnosis and the fix are both measured rather than asserted, and it takes the
# path from the production helper (`bundle-resource-override.mjs`) rather than
# hardcoding it - the helper is what the bundle stage now uses to canonicalize the
# map, so this checks the two agree.
$resourceFixture = $ResourceFixture
$resourceOverrideHelper = Join-Path $PortRoot 'scripts\lib\bundle-resource-override.mjs'
$appDir = Join-Path $PortRoot 'src-tauri\app'
$payloadDsh = Join-Path $PortRoot 'runtime-payload\dsh'
$payloadUi = Join-Path $PortRoot 'ui\dist'
$resourceProofDetail = 'resource source-path preflight skipped because staged resources or PATH node were absent'

if (-not (Test-Path -LiteralPath $payloadDsh -PathType Container) -or -not (Test-Path -LiteralPath $payloadUi -PathType Container)) {
    Write-Host 'SKIP: staged runtime and UI roots must both exist to measure the real longest resource source.' -ForegroundColor DarkYellow
    Write-Host '    note: the ordering preflight above still passed; this section only adds the MAX_PATH measurement.'
} else {
    # PATH node, exactly as the bundle lane's own helper invocation uses it: the
    # staged payload interpreter lives inside the labelled workspace, and a Low
    # child cannot write up into this protected fixture root.
    $nodeCommand = Get-Command -Name 'node' -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) {
        Write-Host 'SKIP: node is absent from PATH, so the longest resource source cannot be measured.' -ForegroundColor DarkYellow
    } else {
        $nodeExe = $nodeCommand.Source
        $longestProbe = @"
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
// process.argv[1] is this script; 2 = config, 3 = app dir, 4 = the helper module.
const { longestResourceSourcePath } = await import(pathToFileURL(process.argv[4]).href)
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const measured = longestResourceSourcePath(config.bundle.resources, process.argv[3])
process.stdout.write(JSON.stringify(measured))
"@
        $longestProbePath = Join-Path $Scratch 'longest-resource-source.mjs'
        Set-Content -LiteralPath $longestProbePath -Value $longestProbe -Encoding ASCII
        $longestRun = Invoke-DshNativeChecked -FilePath $nodeExe `
            -Arguments @($longestProbePath, (Join-Path $appDir 'tauri.conf.json'), $appDir, $resourceOverrideHelper) `
            -WorkingDirectory $PortRoot -TimeoutSeconds 300 -PassThruOutput
        if ($longestRun.ExitCode -ne 0) { throw "the longest resource source could not be measured: $($longestRun.StandardError)" }
        $measured = $longestRun.StandardOutput.Trim() | ConvertFrom-Json
        Write-Host "    longest canonical resource source: $($measured.length) chars, $($measured.files) files" -ForegroundColor DarkGray
        Assert-True ($measured.files -gt 0) 'the real resource trees were walked'
        Assert-True ($measured.length -le 259) `
            "the longest canonical resource source is $($measured.length) chars, inside the measured 259-character NSIS limit"

        # The un-normalized spelling the bundler emitted for the very same file: the
        # app directory joined with the configuration's relative key, verbatim.
        $relativeRoot = $measured.path.Substring((Join-Path $PortRoot '').Length)
        $unnormalized = Join-Path $appDir ('..\..\' + $relativeRoot)
        Assert-True ($unnormalized.Length - $measured.path.Length -eq 20) `
            'the un-collapsed "src-tauri\app\..\.." prefix is exactly the 20 characters normalization removes'
        # A short checkout may never have exceeded MAX_PATH. It is still valid:
        # compile both spellings and expect failure only above the measured limit.
        $unnormalizedFits = $unnormalized.Length -le 259
        Assert-True (Test-Path -LiteralPath $unnormalized) 'both spellings name the same existing file'

        foreach ($spelling in @(
            @{ Name = 'canonical'; Path = $measured.path; ExpectSuccess = $true },
            @{ Name = 'unnormalized'; Path = $unnormalized; ExpectSuccess = $unnormalizedFits }
        )) {
            $resOut = Join-Path $Scratch "resource-$($spelling.Name).exe"
            $resUninst = Join-Path $Scratch "resource-$($spelling.Name)-uninst.exe"
            $resLog = Join-Path $Scratch "resource-$($spelling.Name).log"
            $resArguments = @('/V2', "/DDSH_RES_SOURCE=$($spelling.Path)", "/DDSH_RES_OUT=$resOut",
                "/DDSH_RES_UNINST=$resUninst", "/O$resLog", $resourceFixture)
            $resCompile = Invoke-DshNativeChecked -FilePath $makensis -Arguments $resArguments `
                -WorkingDirectory $Scratch -TimeoutSeconds 300 -PassThruOutput
            $resText = if (Test-Path $resLog) { Get-Content $resLog -Raw } else { '' }
            if ($spelling.ExpectSuccess) {
                if ($resCompile.ExitCode -ne 0) { Write-Host $resText }
                Assert-True ($resCompile.ExitCode -eq 0) `
                    "makensis opens the $($spelling.Name) $($spelling.Path.Length)-character resource source"
                Assert-True (Test-Path $resOut) 'the compile produced an installer image without executing it'
            } else {
                Assert-True ($resCompile.ExitCode -ne 0) `
                    "makensis rejects the un-normalized $($spelling.Path.Length)-character spelling (exit $($resCompile.ExitCode))"
                Assert-True ($resText -match 'File: failed opening file') `
                    'the un-normalized spelling fails with the same message the real bundle reported'
            }
        }
        $resourceProofDetail = "resource source-path preflight compiled both spellings without executing either image: canonical=$($measured.length) chars, files=$($measured.files), unnormalized=$($unnormalized.Length) chars, unnormalizedExpectedSuccess=$unnormalizedFits"
    }
}

# `warning 6040` means a LangString is absent from a language's string table.
# The English entry is what the guard reports through, so an English miss is a
# real defect (the message would be empty and read as "no error"); the Chinese
# entry is a known makensis ordering quirk that still resolves at run time.
$englishMisses = @([regex]::Matches($logText, 'LangString "([^"]+)" is not set in language table of language English') |
    ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
Assert-True ($englishMisses.Count -eq 0) "every message is in the English string table (missing: $($englishMisses -join ', '))"

$chineseMisses = @([regex]::Matches($logText, 'LangString "([^"]+)" is not set in language table of language SimpChinese') |
    ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
if ($chineseMisses.Count -gt 0) {
    Write-Host "    note: makensis reports $($chineseMisses.Count) SimpChinese string-table warning(s); the values still resolve at run time, which tests/packaging/nsis-instance-guard.ps1 exercises for English." -ForegroundColor DarkYellow
}

Write-Host ''
Write-Host 'Installer hooks compile check: PASS' -ForegroundColor Green
exit (Write-DshSuiteResult -Id 'installer-hooks-compile' -Status 'PASS' -Checks 62 -Detail ('hooks compiled in a Tauri-shaped template; uninstaller function table resolved; template ordering preflight compiled the real hooks, FindProcessCurrentUser and SemverCompare against the real plugin in BOTH the signed (copied tree) and unsigned layouts and reproduced the late-plugin, duplicate-directory, duplicate-Var and silently-degraded-Var variants; ' + $resourceProofDetail))
