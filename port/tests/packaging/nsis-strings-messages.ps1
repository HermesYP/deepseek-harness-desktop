<#
.SYNOPSIS
  Prove the installer guard messages are actually localized, per language.

.DESCRIPTION
  `installer-strings.nsh` declares three guard messages for English and
  SimpChinese. This suite compiles and RUNS the guard's own message references in
  Tauri's real include order and asserts, per selected language, which text the
  guard would report.

  What it proves that a compile check cannot:

    1. `installer-process.nsh` really includes `installer-strings.nsh`, so the
       messages cannot be forgotten by a caller.
    2. Both languages are compiled into SEPARATE string tables - warning 7025
       ("not a valid language id") must be absent, because that warning means both
       languages were collapsed onto id 1033 and the translation is unreachable.
    3. Every string is present in BOTH language tables (warning 6040 absent).
    4. At run time, English selects the English text and SimpChinese selects the
       Chinese text - asserted by comparing `$(...)` against the value DECLARED IN
       THE STRINGS FILE, so the test cannot agree with a wrong translation.
    5. No message resolves to the empty string. An undefined LangString is empty,
       and the guard reads an empty error as "nothing was wrong", so an empty
       message is a FAIL-OPEN default rather than a cosmetic gap.

  HOW THE EXPECTED TEXT REACHES THE PROBE

  The expected strings are parsed out of `installer-strings.nsh` and passed to
  makensis as `/D` defines. MEASURED: a CJK literal inside a BOM-less UTF-8
  top-level `.nsi` is misdecoded by makensis, while the same text passed as a `/D`
  define arrives intact. Putting the expectations in defines therefore removes the
  fixture's own encoding from the question, and keeps this suite the thing that
  decides what the correct text is - not a copy pasted into the probe.

  It also asserts the FAIL-CLOSED fallback: compiling the guard with no strings
  module at all must still produce a NON-EMPTY English message rather than an
  empty one.

.NOTES
  Windows only. SKIPs when makensis is absent, like the other NSIS suites.
  Nothing is installed; the probes only write a verdict file under port\.scratch\.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PortRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$InstallerDir = Join-Path $PortRoot 'installer'
$StringsFile = Join-Path $InstallerDir 'installer-strings.nsh'
$ProcessFile = Join-Path $InstallerDir 'installer-process.nsh'
$ProbeSource = Join-Path $PSScriptRoot 'nsis\strings-message-probe.nsi'
Import-Module (Join-Path $PSScriptRoot 'fixture-safety.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'native-quoting.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'suite-result.psm1') -Force
trap { exit (Write-DshSuiteResult -Id 'installer-strings-messages' -Status 'FAIL' -Detail $_.Exception.Message) }
$Scratch = New-PackagingFixtureRoot -PortRoot $PortRoot -Prefix 'installer-strings-messages'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
    Write-Host "    ok  $Message" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# Source-level properties, before any compilation.
# ---------------------------------------------------------------------------
Write-Host '==> installer-process.nsh genuinely includes the strings module' -ForegroundColor Cyan

# Read as UTF-8 explicitly. Windows PowerShell 5.1's `Get-Content -Raw` defaults to
# the ANSI codepage for a BOM-less file, which turns every CJK character into
# mojibake - and a mojibake comparison would still "pass" while proving nothing
# about the bytes that actually reach makensis.
function Read-Utf8 {
    param([Parameter(Mandatory)][string]$Path)
    return [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false)))
}

$processText = Read-Utf8 -Path $ProcessFile

# `Set-Content -Encoding UTF8` writes a BOM on Windows PowerShell 5.1, and a BOM in
# an included .nsh is what the port's compile check exists to prevent. The copies
# made below keep the original bytes' convention: BOM-less UTF-8.
function Write-Utf8NoBom {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}
Assert-True ($processText -match '(?m)^\s*!include\s+"\$\{DSH_INSTALLER_STRINGS_FILE\}"') `
    'installer-process.nsh !includes installer-strings.nsh itself'
Assert-True ($processText -match 'DSH_INSTALLER_STRINGS_FILE') `
    'the include path is a define, so a caller can override it but cannot omit it'

# The earlier defect: the messages were a compile-time literal chosen by an
# `!ifdef` that nothing ever set. The guard must now reference the LangString
# names, and the literal must be confined to the no-strings-module fallback.
$localizedBranch = [regex]::Match($processText,
    '!ifdef DSH_INSTALLER_STRINGS_MACROS_DEFINED(?<body>[\s\S]*?)!else')
Assert-True $localizedBranch.Success 'the guard has a requested-strings branch'
Assert-True ($localizedBranch.Groups['body'].Value -match '\$\(DSH_INSTALLER_RUNNING\)') `
    'the strings branch reports through $(DSH_INSTALLER_RUNNING), not a literal'
Assert-True ($localizedBranch.Groups['body'].Value -notmatch 'DeepSeek Harness is still running') `
    'the strings branch does NOT contain the English literal'

# The three message names the guard uses must exist in the strings file for BOTH
# languages, or one language silently falls back to the empty string.
$stringsText = Read-Utf8 -Path $StringsFile
foreach ($name in @('DSH_INSTALLER_RUNNING', 'DSH_INSTALLER_INDETERMINATE', 'DSH_INSTALLER_RELAUNCH_FAILED')) {
    $enCount = ([regex]::Matches($stringsText, "LangString $name \`$\{LANG_ENGLISH\}")).Count
    $zhCount = ([regex]::Matches($stringsText, "LangString $name \`$\{LANG_SIMPCHINESE\}")).Count
    Assert-True ($enCount -eq 1) "$name is declared exactly once for English (found $enCount)"
    Assert-True ($zhCount -eq 1) "$name is declared exactly once for SimpChinese (found $zhCount)"
}

# Parse the DECLARED text so the runtime expectations come from the file under
# test rather than from a copy in this suite.
function Get-DeclaredString {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Language)
    $pattern = "LangString\s+$Name\s+\`$\{$Language\}\s+""(?<value>[^""]*)"""
    $match = [regex]::Match($stringsText, $pattern)
    if (-not $match.Success) { throw "installer-strings.nsh does not declare $Name for $Language" }
    # NSIS writes `$\r$\n` as a real CRLF at run time.
    return ($match.Groups['value'].Value -replace '\$\\r\$\\n', "`r`n")
}

$expected = @{
    'PROBE_EN_RUNNING'            = Get-DeclaredString -Name 'DSH_INSTALLER_RUNNING' -Language 'LANG_ENGLISH'
    'PROBE_EN_INDETERMINATE'      = Get-DeclaredString -Name 'DSH_INSTALLER_INDETERMINATE' -Language 'LANG_ENGLISH'
    'PROBE_EN_RELAUNCH'           = Get-DeclaredString -Name 'DSH_INSTALLER_RELAUNCH_FAILED' -Language 'LANG_ENGLISH'
    'PROBE_ZH_RUNNING'            = Get-DeclaredString -Name 'DSH_INSTALLER_RUNNING' -Language 'LANG_SIMPCHINESE'
    'PROBE_ZH_INDETERMINATE'      = Get-DeclaredString -Name 'DSH_INSTALLER_INDETERMINATE' -Language 'LANG_SIMPCHINESE'
    'PROBE_ZH_RELAUNCH'           = Get-DeclaredString -Name 'DSH_INSTALLER_RELAUNCH_FAILED' -Language 'LANG_SIMPCHINESE'
}

foreach ($key in @('PROBE_EN_RUNNING', 'PROBE_ZH_RUNNING')) {
    Assert-True (-not [string]::IsNullOrWhiteSpace($expected[$key])) "the declared $key text is non-empty"
}
# The translations must actually DIFFER, or "SimpChinese is reachable" would be
# satisfied by an English string compiled into both tables.
foreach ($pair in @(@('RUNNING'), @('INDETERMINATE'), @('RELAUNCH'))) {
    Assert-True ($expected["PROBE_EN_$($pair[0])"] -ne $expected["PROBE_ZH_$($pair[0])"]) `
        "$($pair[0]): the English and SimpChinese texts differ"
}
Assert-True ($expected['PROBE_ZH_RUNNING'] -match '[\u4e00-\u9fff]') `
    'the declared SimpChinese text contains CJK characters'
Assert-True ($expected['PROBE_EN_RUNNING'] -notmatch '[\u4e00-\u9fff]') `
    'the declared English text contains no CJK characters'

# The strings file must stay BOM-less UTF-8: the bundler supplies its own BOM for
# custom language files, and the port's compile check asserts this too.
$bytes = [System.IO.File]::ReadAllBytes($StringsFile)
Assert-True (-not ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)) `
    'installer-strings.nsh is BOM-less (the bundler adds its own BOM)'

# ---------------------------------------------------------------------------
# Compile and RUN.
# ---------------------------------------------------------------------------
if ($env:OS -ne 'Windows_NT') {
    Write-Host 'SKIP: the installer hooks are Windows/NSIS-specific.' -ForegroundColor Yellow
    exit (Write-DshSuiteResult -Id 'installer-strings-messages' -Status 'SKIP' -Reason 'not-applicable' -Detail 'Windows-only NSIS message check')
}

$makensis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
if (-not (Test-Path $makensis)) {
    $command = Get-Command makensis -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        Write-Host "SKIP: makensis not found (looked in $makensis and on PATH)." -ForegroundColor Yellow
        exit (Write-DshSuiteResult -Id 'installer-strings-messages' -Status 'SKIP' -Reason 'precondition-failed' -Detail "makensis absent from $makensis and PATH")
    }
    $makensis = $command.Source
}
$pluginDir = Join-Path (Split-Path -Parent $makensis) 'Plugins\x86-unicode\additional'
if (-not (Test-Path (Join-Path $pluginDir 'nsis_tauri_utils.dll'))) {
    Write-Host "SKIP: nsis_tauri_utils.dll not found at $pluginDir." -ForegroundColor Yellow
    exit (Write-DshSuiteResult -Id 'installer-strings-messages' -Status 'SKIP' -Reason 'precondition-failed' -Detail "nsis_tauri_utils.dll absent from $pluginDir")
}

# The fresh protected UUID root and all evidence are retained.

$hooks = Join-Path $InstallerDir 'installer-hooks.nsh'

function Invoke-MessageProbe {
    param(
        [Parameter(Mandatory)][int]$LanguageId,
        [Parameter(Mandatory)][string]$Label,
        [string]$StringsPath = $StringsFile,
        [switch]$ExpectNoStringsModule
    )

    $caseDir = Join-Path $Scratch "probe-$Label"
    $null = New-Item -ItemType Directory -Path $caseDir -ErrorAction Stop
    $verdictPath = Join-Path $caseDir 'verdict.txt'
    $exe = Join-Path $Scratch "probe-$Label.exe"
    $log = Join-Path $Scratch "probe-$Label.log"
    $arguments = @(
        '/V2'
        "/DPROBE_OUT=$exe"
        "/DPROBE_DIR=$caseDir"
        "/DPROBE_LANG=$LanguageId"
        "/DDSH_INSTALLER_HOOKS=$hooks"
        "/DDSH_INSTALLER_STRINGS=$StringsPath"
        "/DDSH_PLUGIN_DIR=$pluginDir"
        "/O$log"
        $ProbeSource
    )
    foreach ($key in $expected.Keys) {
        # A `/D` define carries the text intact; see the suite header.
        $arguments = @("/D$key=$($expected[$key])") + $arguments
    }

    # Centralised quoting: a fixture path with a space must not truncate a define.
    $compile = Invoke-DshNativeChecked -FilePath $makensis -Arguments $arguments -WorkingDirectory $Scratch -TimeoutSeconds 900 -PassThruOutput
    $exitCode = $compile.ExitCode
    $logText = if (Test-Path $log) { Get-Content $log -Raw } else { '' }
    if ($exitCode -ne 0) {
        Write-Host $logText
        throw "makensis failed to compile the message probe for '$Label' (exit $exitCode)"
    }

    & $exe /S | Out-Null
    Start-Sleep -Milliseconds 300
    if (-not (Test-Path $verdictPath)) {
        throw "the message probe for '$Label' produced no verdict file"
    }

    $verdict = @{}
    foreach ($line in (Get-Content $verdictPath)) {
        $parts = $line.Split('=', 2)
        if ($parts.Count -eq 2) { $verdict[$parts[0]] = $parts[1] }
    }
    return [pscustomobject]@{ Verdict = $verdict; Log = $logText; Label = $Label }
}

Write-Host '==> English: the compiled installer reports the declared English text' -ForegroundColor Cyan
$en = Invoke-MessageProbe -LanguageId 1033 -Label 'en'
Assert-True ($en.Verdict['LANGUAGE'] -eq '1033') "the probe ran as English (LANGUAGE=$($en.Verdict['LANGUAGE']))"
Assert-True ($en.Verdict['DSH_INSTALLER_RUNNING_MATCH'] -eq 'YES') 'English selects the English running-instance message'
Assert-True ($en.Verdict['DSH_INSTALLER_INDETERMINATE_MATCH'] -eq 'YES') 'English selects the English indeterminate message'
Assert-True ($en.Verdict['DSH_INSTALLER_RELAUNCH_FAILED_MATCH'] -eq 'YES') 'English selects the English relaunch message'
$enMisses = @([regex]::Matches($en.Log, '6040: LangString "([^"]+)" is not set in language table of language (\w+)') |
    ForEach-Object { "$($_.Groups[1].Value)/$($_.Groups[2].Value)" } | Sort-Object -Unique)
Assert-True ($enMisses.Count -eq 0) "no string is missing from a language table (missing: $($enMisses -join ', '))"
Assert-True ($en.Log -notmatch '7025') `
    'no language-id collapse (warning 7025), which is what makes a translation unreachable'

Write-Host '==> SimpChinese: the compiled installer reports the declared Chinese text' -ForegroundColor Cyan
$zh = Invoke-MessageProbe -LanguageId 2052 -Label 'zh'
Assert-True ($zh.Verdict['LANGUAGE'] -eq '2052') "the probe ran as SimpChinese (LANGUAGE=$($zh.Verdict['LANGUAGE']))"
Assert-True ($zh.Verdict['DSH_INSTALLER_RUNNING_MATCH'] -eq 'YES') `
    'SimpChinese selects the SimpChinese running-instance message (the P2 defect: it did not)'
Assert-True ($zh.Verdict['DSH_INSTALLER_INDETERMINATE_MATCH'] -eq 'YES') 'SimpChinese selects the SimpChinese indeterminate message'
Assert-True ($zh.Verdict['DSH_INSTALLER_RELAUNCH_FAILED_MATCH'] -eq 'YES') 'SimpChinese selects the SimpChinese relaunch message'
Assert-True ($zh.Log -notmatch '7025') 'the SimpChinese build does not collapse the language tables either'

Write-Host '==> neither language can resolve a message to the empty string' -ForegroundColor Cyan
foreach ($probe in @($en, $zh)) {
    foreach ($name in @('DSH_INSTALLER_RUNNING', 'DSH_INSTALLER_INDETERMINATE', 'DSH_INSTALLER_RELAUNCH_FAILED')) {
        Assert-True ($probe.Verdict["${name}_EMPTY"] -eq 'NO') `
            "$($probe.Label): $name is not empty (an empty guard error reads as 'nothing was wrong')"
    }
}

# ---------------------------------------------------------------------------
# The fail-closed fallback.
#
# A caller that compiles the guard with no strings module at all must still get a
# NON-EMPTY English message. This is the property the original `!ifdef` was
# protecting, and it must survive the fix.
# ---------------------------------------------------------------------------
Write-Host '==> the no-strings-module fallback is non-empty (fail-closed)' -ForegroundColor Cyan

$noStringsDir = Join-Path $Scratch 'nostrings'
$null = New-Item -ItemType Directory -Force -Path $noStringsDir
# A COPY of installer-process.nsh that resolves its include to nothing, so the
# guard compiles with the fallback branch. The copy is used so the real file is
# never modified.
$stubStrings = Join-Path $noStringsDir 'empty-strings.nsh'
Set-Content -Path $stubStrings -Value '; deliberately declares nothing' -Encoding ASCII
$processCopy = Join-Path $noStringsDir 'installer-process.nsh'
# Redirect the define before the include: point the strings file at the stub.
$copyText = (Read-Utf8 -Path $ProcessFile).Replace(
    '!define DSH_INSTALLER_STRINGS_FILE "${__FILEDIR__}\installer-strings.nsh"',
    "!define DSH_INSTALLER_STRINGS_FILE `"$stubStrings`"")
Write-Utf8NoBom -Path $processCopy -Text $copyText
Copy-Item (Join-Path $InstallerDir 'installer-hooks.nsh') (Join-Path $noStringsDir 'installer-hooks.nsh') -Force
$hooksCopy = Join-Path $noStringsDir 'installer-hooks.nsh'
# Point the hooks copy at the copied process module.
$hooksText = (Read-Utf8 -Path $hooksCopy).Replace(
    '!include "${DSH_INSTALLER_DIR}\installer-process.nsh"',
    "!include `"$processCopy`"")
Write-Utf8NoBom -Path $hooksCopy -Text $hooksText

$fallbackExe = Join-Path $Scratch 'fallback.exe'
$fallbackLog = Join-Path $Scratch 'fallback.log'
$fallbackProbe = Join-Path $noStringsDir 'fallback.nsi'
@"
Unicode true
!include "MUI2.nsh"
!addplugindir "${pluginDir}"
OutFile "${fallbackExe}"
Name "dsh-fallback-probe"
InstallDir "`$TEMP\dsh-fallback-probe"
SilentInstall silent
RequestExecutionLevel user
!include "$hooksCopy"
!insertmacro MUI_LANGUAGE "English"
Section
  FileOpen `$9 "${Scratch}\fallback.txt" w
  StrCpy `$8 "`${DSH_MSG_RUNNING}"
  `${If} `$8 == ""
    FileWrite `$9 "FALLBACK_EMPTY=YES`$\r`$\n"
  `${Else}
    FileWrite `$9 "FALLBACK_EMPTY=NO`$\r`$\n"
  `${EndIf}
  FileClose `$9
SectionEnd
Section Uninstall
SectionEnd
"@ | Set-Content -Path $fallbackProbe -Encoding UTF8

$fallbackCompile = Invoke-DshNativeChecked -FilePath $makensis `
    -Arguments @('/V1', "/DDSH_PLUGIN_DIR=$pluginDir", "/O$fallbackLog", $fallbackProbe) `
    -WorkingDirectory $Scratch -TimeoutSeconds 900 -PassThruOutput
if ($fallbackCompile.ExitCode -ne 0) {
    throw "makensis failed to compile the fallback probe (exit $($fallbackCompile.ExitCode))"
}$fallbackReport = Join-Path $Scratch 'fallback.txt'
& $fallbackExe /S | Out-Null
Start-Sleep -Milliseconds 300
$fallbackText = Get-Content $fallbackReport -Raw
Assert-True ($fallbackText -match 'FALLBACK_EMPTY=NO') `
    'with no strings module the guard still reports a non-empty message (no fail-open default)'

Write-Host ''
Write-Host 'Installer strings messages: PASS' -ForegroundColor Green
exit (Write-DshSuiteResult -Id 'installer-strings-messages' -Status 'PASS' -Checks 14 -Detail 'English and SimpChinese message selection plus the fail-closed fallback')
