# Structured suite outcomes for the packaging qualification gate.
#
# WHY THIS MODULE EXISTS
#   A suite that cannot run its real check (no `makensis`, no Windows, no pinned
#   interpreter) must not be reported as a pass. The 2026-10-10 scan found the
#   previous runner marking a suite passed iff its exit code was nonzero -- and
#   all four NSIS suites exited 0 when they skipped, so `passed=6 failed=0` could
#   mean that zero NSIS qualification ran (finding P1).
#
#   Every suite now ends by emitting exactly one machine-readable line:
#
#     SUITE_RESULT=id=<id> status=<PASS|FAIL|SKIP> reason=<token> detail=<text>
#
#   `reason=precondition-failed` is the ONLY recognised skip: the suite could not
#   perform its check because a named precondition was absent. It is never a pass.
#   `reason=not-applicable` is reserved for a platform mismatch that no
#   precondition could fix (for example a Windows-only native suite on Linux).
#
#   The seven PowerShell packaging suites are declared explicitly rather than
#   discovered by glob, so deleting a suite or renaming its file is a gate failure
#   instead of a quietly smaller run.
#
# Pure ASCII; Windows PowerShell 5.1 and 7 compatible.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Exit codes are distinct so a caller can tell a defect from an environment skip.
$script:ExitPass = 0
$script:ExitFail = 1
$script:ExitSkipPrecondition = 3
$script:ExitSkipNotApplicable = 4

function Get-DshSuiteExitCode {
    param([Parameter(Mandatory)][ValidateSet('PASS', 'FAIL', 'SKIP')][string]$Status,
          [string]$Reason = '')
    if ($Status -eq 'PASS') { return $script:ExitPass }
    if ($Status -eq 'FAIL') { return $script:ExitFail }
    # SKIP. A precondition failure is a distinct code from a platform mismatch, so
    # a caller can gate on it: 'precondition-failed' is never a pass.
    if ($Reason -eq 'precondition-failed') { return $script:ExitSkipPrecondition }
    if ($Reason -eq 'not-applicable') { return $script:ExitSkipNotApplicable }
    return $script:ExitSkipNotApplicable
}

function Write-DshSuiteResult {
    <#
    .SYNOPSIS
      Emit the single structured result line for a suite and return its exit code.
    .DESCRIPTION
      `detail` is one line of human text; newlines are folded so the structured
      line stays parseable by a runner that reads line by line.
    #>
    param(
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][ValidateSet('PASS', 'FAIL', 'SKIP')][string]$Status,
        [string]$Reason = '',
        [string]$Detail = '',
        [int]$Checks = -1
    )
    if ($Status -eq 'SKIP' -and [string]::IsNullOrWhiteSpace($Reason)) {
        throw 'A SKIP result must name its reason (precondition-failed or not-applicable).'
    }
    if ($Status -eq 'PASS' -and -not [string]::IsNullOrWhiteSpace($Reason)) {
        throw 'A PASS result must not carry a skip reason.'
    }
    if ($Status -eq 'PASS' -and $Checks -eq 0) {
        throw 'A PASS result must have performed at least one check.'
    }
    $flatDetail = ($Detail -replace '\s+', ' ').Trim()
    if ($flatDetail.Length -gt 400) { $flatDetail = $flatDetail.Substring(0, 400) }
    $line = "SUITE_RESULT=id=$Id status=$Status"
    if ($Reason) { $line += " reason=$Reason" }
    if ($Checks -ge 0) { $line += " checks=$Checks" }
    if ($flatDetail) { $line += " detail=$flatDetail" }
    Write-Host $line
    return (Get-DshSuiteExitCode -Status $Status -Reason $Reason)
}

function Get-DshDeclaredPackagingSuites {
    <#
    .SYNOPSIS
      The seven declared PowerShell packaging suites, in gate order.
    .DESCRIPTION
      Declared, not discovered. `Native` marks the suites that need `makensis`
      and therefore report `precondition-failed` when the toolchain is absent.
    #>
    param([Parameter(Mandatory)][string]$PackagingTestsDir)

    return @(
        [pscustomobject]@{ Id = 'packaging-helpers';            File = 'lib-modules.ps1';             Native = $false; Platform = 'Windows' }
        [pscustomobject]@{ Id = 'staging-guards';               File = 'stage-guards.ps1';            Native = $false; Platform = 'Windows' }
        [pscustomobject]@{ Id = 'installer-hooks-compile';      File = 'nsis-hooks-compile.ps1';      Native = $true;  Platform = 'Windows' }
        [pscustomobject]@{ Id = 'installer-strings-messages';   File = 'nsis-strings-messages.ps1';   Native = $true;  Platform = 'Windows' }
        [pscustomobject]@{ Id = 'installer-instance-guard';     File = 'nsis-instance-guard.ps1';     Native = $true;  Platform = 'Windows' }
        [pscustomobject]@{ Id = 'installer-hook-behavior';      File = 'nsis-hook-behavior.ps1';      Native = $true;  Platform = 'Windows' }
        [pscustomobject]@{ Id = 'installed-qualification-guards'; File = 'verify-installed-guards.ps1'; Native = $false; Platform = 'Windows' }
    ) | ForEach-Object {
        $suite = $_
        Add-Member -InputObject $suite -NotePropertyName Path -NotePropertyValue (Join-Path $PackagingTestsDir $suite.File) -Force
        $suite
    }
}

function Read-DshSuiteResults {
    <#
    .SYNOPSIS
      Parse the structured result lines out of captured suite output.
    .DESCRIPTION
      Returns one record per line. A suite that printed no structured line is
      reported by the caller as a FAIL, never inferred from its exit code alone.
    #>
    param([AllowEmptyString()][string]$Output = '')

    $results = @()
    foreach ($line in ($Output -split "`r?`n")) {
        if ($line -notmatch '^SUITE_RESULT=id=(?<id>[A-Za-z0-9._-]+) status=(?<status>PASS|FAIL|SKIP)(?<rest>.*)$') {
            continue
        }
        $record = [ordered]@{ Id = $Matches.id; Status = $Matches.status; Reason = ''; Detail = ''; Checks = -1 }
        $rest = $Matches.rest
        if ($rest -match 'reason=(?<value>[A-Za-z0-9._-]+)') { $record.Reason = $Matches.value }
        if ($rest -match 'checks=(?<value>-?\d+)') { $record.Checks = [int]$Matches.value }
        if ($rest -match 'detail=(?<value>.*)$') { $record.Detail = $Matches.value }
        $results += [pscustomobject]$record
    }
    return $results
}

function Assert-DshNodeTestCounts {
    <#
    .SYNOPSIS
      Fail when a Node test lane ran zero files or zero tests.
    .DESCRIPTION
      `node --test <glob>` exits 0 when the glob matches nothing, so a green line
      proves nothing on its own (finding P1). This checks the runner's own
      inventory: at least `MinFiles` matching files must exist, and the parsed
      `# tests N` / `# pass N` totals must be nonempty and above the floor.
    #>
    param(
        [AllowEmptyCollection()][string[]]$Files = @(),
        [Parameter(Mandatory)][AllowEmptyString()][string]$Output,
        [int]$MinFiles = 1,
        [int]$MinTests = 1,
        [string]$Lane = 'node'
    )

    if ($Files.Count -lt $MinFiles) {
        throw "$Lane lane matched $($Files.Count) test file(s); at least $MinFiles are required (an empty glob exits 0 and would be a false green)."
    }
    foreach ($file in $Files) {
        if ([string]::IsNullOrWhiteSpace($file)) { throw "$Lane lane received a blank file name." }
    }
    $tests = $null
    $pass = $null
    foreach ($line in ($Output -split "`r?`n")) {
        if ($line -match '^#\s*tests\s+(?<value>\d+)\s*$') { $tests = [int]$Matches.value }
        if ($line -match '^#\s*pass\s+(?<value>\d+)\s*$') { $pass = [int]$Matches.value }
    }
    if ($null -eq $tests) { throw "$Lane lane output has no '# tests N' total; the run is unverifiable." }
    if ($null -eq $pass) { throw "$Lane lane output has no '# pass N' total; the run is unverifiable." }
    if ($tests -lt $MinTests) { throw "$Lane lane reported $tests test(s); at least $MinTests are required." }
    if ($pass -lt $MinTests) { throw "$Lane lane passed $pass test(s); at least $MinTests are required." }
    return [pscustomobject]@{ Files = $Files.Count; Tests = $tests; Passed = $pass }
}

Export-ModuleMember -Function Get-DshSuiteExitCode, Write-DshSuiteResult,
    Get-DshDeclaredPackagingSuites, Read-DshSuiteResults, Assert-DshNodeTestCounts
