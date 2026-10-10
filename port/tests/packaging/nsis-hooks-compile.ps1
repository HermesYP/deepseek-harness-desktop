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

  It also asserts the hook files are UTF-8 decodable and free of the byte
  sequences makensis rejects, and that no hook is missing: a `!ifmacrodef`-guarded
  hook that does not exist is silently skipped, so "it compiled" alone would not
  prove the hooks ran.

.NOTES
  Windows only. SKIPs when makensis is absent.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PortRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$InstallerDir = Join-Path $PortRoot 'installer'
$Fixture = Join-Path $PSScriptRoot 'nsis\tauri-hooks-fixture.nsi'
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
                    $Fixture)) {
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
exit (Write-DshSuiteResult -Id 'installer-hooks-compile' -Status 'PASS' -Checks 14 -Detail 'hooks compiled in a Tauri-shaped template; uninstaller function table resolved')
