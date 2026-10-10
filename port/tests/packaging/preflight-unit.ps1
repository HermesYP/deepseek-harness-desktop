<#
.SYNOPSIS
  Unit checks for the qualification preflight, structured results and native
  quoting helpers. Read-only: no fixture process is started, nothing is written
  outside an owned qualification root.

.DESCRIPTION
  These are the checks that can be made without running a native suite, so they
  are the ones that must hold even on a host where `makensis` or a Medium
  interpreter is absent:

    * the MSVCRT quoting rules (spaces, embedded quotes, trailing backslash and
      the empty argument), because a silently truncated makensis define is a
      false PASS (finding P2);
    * the integrity readers answer with either a known level or a known refusal,
      and never with a guess;
    * the preflight module never contains a relabel / ACL-reset call, asserted
      against its own source text;
    * structured results: SKIP needs a reason, PASS needs at least one check, and
      the exit codes distinguish FAIL from precondition-failed;
    * the Node lane count parser refuses an empty run.

.NOTES
  Windows PowerShell 5.1 and 7 compatible. Read-only.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$here = $PSScriptRoot
Import-Module (Join-Path $here 'native-quoting.psm1') -Force
Import-Module (Join-Path $here 'suite-result.psm1') -Force
Import-Module (Join-Path $here 'qualification-preflight.psm1') -Force

$script:Passed = 0
$script:Failed = 0
function Assert-True([bool]$Condition, [string]$Message) {
    if ($Condition) { $script:Passed++; Write-Host "    ok  $Message" -ForegroundColor Green }
    else { $script:Failed++; Write-Host "    FAIL $Message" -ForegroundColor Red }
}
function Assert-Throws([scriptblock]$Block, [string]$MessagePattern, [string]$Message) {
    $threw = $false
    try { & $Block } catch { $threw = $true; if ($MessagePattern -and $_.Exception.Message -notmatch $MessagePattern) {
        $script:Failed++; Write-Host "    FAIL $Message (message was: $($_.Exception.Message))" -ForegroundColor Red; return } }
    if ($threw) { $script:Passed++; Write-Host "    ok  $Message" -ForegroundColor Green }
    else { $script:Failed++; Write-Host "    FAIL $Message (nothing was thrown)" -ForegroundColor Red }
}

Write-Host '==> native-quoting.psm1' -ForegroundColor Cyan
$plain = ConvertTo-DshNativeArgument -Argument 'plain'
Assert-True ($plain -eq 'plain') 'an argument without whitespace is passed unchanged'
$spaced = ConvertTo-DshNativeArgument -Argument 'C:\Program Files\NSIS'
Assert-True ($spaced -eq '"C:\Program Files\NSIS"') 'an argument with a space is quoted'
$quoted = ConvertTo-DshNativeArgument -Argument '/DDSH="a b"'
Assert-True ($quoted -eq '"/DDSH=\"a b\""') "an embedded quote is escaped (got $quoted)"
$trailing = ConvertTo-DshNativeArgument -Argument 'root with space\'
Assert-True ($trailing -eq '"root with space\\"') "a trailing backslash is doubled so the closing quote survives (got $trailing)"
$empty = ConvertTo-DshNativeArgument -Argument ''
Assert-True ($empty -eq '""') 'an empty argument is preserved as an empty argv element rather than vanishing'
$line = ConvertTo-DshNativeArgumentList -Arguments @('/V2', 'C:\Program Files\NSIS\makensis.exe', '/DDSH_PROBE_OUT=C:\a b\probe.exe')
Assert-True ($line -eq '/V2 "C:\Program Files\NSIS\makensis.exe" "/DDSH_PROBE_OUT=C:\a b\probe.exe"') "one verbatim command line is produced (got $line)"
Assert-True ((Get-DshNativeQuotingMode) -in @('msvcrt-fallback', 'pwsh-array')) 'the quoting mode names the rule in use'

Write-Host '==> qualification-preflight.psm1 (read-only)' -ForegroundColor Cyan
$moduleText = Get-Content -LiteralPath (Join-Path $here 'qualification-preflight.psm1') -Raw
# Comment-only lines are removed first, exactly as build-script.test.mjs does: the
# prose documents the calls this module deliberately does NOT make, and reading the
# prose as the defect is the failure mode that check exists to avoid.
$moduleCode = ($moduleText -split "`r?`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
foreach ($banned in @('/setintegritylevel', 'Set-Acl', 'SetSecurityInfo', 'icacls.exe', 'takeown')) {
    Assert-True (-not $moduleCode.Contains($banned)) "the preflight never calls $banned (no relabel, no ACL reset)"
}
$low = Get-DshIntegrityFromSid -Sid 'S-1-16-4096'
Assert-True ($low.Known -and $low.Level -eq 'low' -and $low.Rid -eq 0x1000) 'S-1-16-4096 is recognised as Low'
$medium = Get-DshIntegrityFromSid -Sid 'S-1-16-8192'
Assert-True ($medium.Known -and $medium.Level -eq 'medium') 'S-1-16-8192 is recognised as Medium'
$absent = Get-DshIntegrityFromSid -Sid $null
Assert-True (-not $absent.Known -and $absent.Level -eq 'absent') 'an absent label is reported as absent, not guessed'
$garbage = Get-DshIntegrityFromSid -Sid 'S-1-5-21'
Assert-True (-not $garbage.Known) 'a non-integrity SID is refused rather than coerced'
if ($env:OS -eq 'Windows_NT') {
    $self = Get-DshProcessIntegrity -ProcessId $PID
    Assert-True ($self.Known -or $self.Reason) 'the parent integrity query answers with a level or an explicit reason'
    if ($self.Known) { Write-Host "    note: this process runs at $($self.Level) integrity ($($self.Sid))" -ForegroundColor DarkGray }
    $label = Get-DshFileIntegrityLabel -Path (Join-Path $here 'qualification-preflight.psm1')
    Assert-True ($label.Known -or $label.Reason) 'the file label query answers with a level or an explicit reason'
    if ($label.Known) { Write-Host "    note: this module file carries label '$($label.Level)'" -ForegroundColor DarkGray }
    # A directory label is legitimate evidence: it decides what new children
    # inherit, so reading one must be allowed.
    $directoryLabel = Get-DshFileIntegrityLabel -Path $here
    Assert-True ($directoryLabel.Known -or $directoryLabel.Reason) 'the label of a directory can be read'
    $effective = Get-DshEffectiveIntegrity -Path (Join-Path $here 'qualification-preflight.psm1')
    Assert-True ($effective.Known -and $effective.Source) 'the effective label names its source (explicit, ancestor or unlabelled)'
    Write-Host "    note: effective label here is '$($effective.Level)' from '$($effective.Source)'" -ForegroundColor DarkGray
    Assert-Throws { Get-DshFileIntegrityLabel -Path (Join-Path $here 'no-such-file-xyz.psm1') } 'No file to label-read' 'label reading an absent file is refused'
}

Write-Host '==> suite-result.psm1' -ForegroundColor Cyan
Assert-True ((Get-DshSuiteExitCode -Status 'PASS') -eq 0) 'a pass exits 0'
Assert-True ((Get-DshSuiteExitCode -Status 'FAIL') -eq 1) 'a failure exits 1'
Assert-True ((Get-DshSuiteExitCode -Status 'SKIP' -Reason 'precondition-failed') -ne 0) 'a precondition skip is NOT a pass'
Assert-True ((Get-DshSuiteExitCode -Status 'SKIP' -Reason 'precondition-failed') -ne (Get-DshSuiteExitCode -Status 'SKIP' -Reason 'not-applicable')) 'a precondition skip is distinguishable from a platform skip'
Assert-Throws { Write-DshSuiteResult -Id 'x' -Status 'SKIP' -Detail 'no reason' } 'must name its reason' 'a SKIP without a reason is refused'
Assert-Throws { Write-DshSuiteResult -Id 'x' -Status 'PASS' -Checks 0 } 'at least one check' 'a PASS that performed no check is refused'
$declared = Get-DshDeclaredPackagingSuites -PackagingTestsDir (Join-Path $here '.')
Assert-True ($declared.Count -eq 7) "exactly seven packaging suites are declared (got $($declared.Count))"
foreach ($suite in $declared) { Assert-True (Test-Path -LiteralPath $suite.Path) "declared suite exists: $($suite.File)" }
Assert-True (@($declared | Where-Object { $_.Native }).Count -eq 4) 'four of the declared suites are NSIS-native and can precondition-skip'
$parsed = Read-DshSuiteResults -Output @'
noise
SUITE_RESULT=id=staging-guards status=PASS checks=12 detail=all good
SUITE_RESULT=id=installer-instance-guard status=SKIP reason=precondition-failed detail=makensis absent
'@
Assert-True ($parsed.Count -eq 2) 'structured result lines are parsed'
Assert-True ($parsed[0].Status -eq 'PASS' -and $parsed[0].Checks -eq 12) 'a pass result keeps its check count'
Assert-True ($parsed[1].Reason -eq 'precondition-failed') 'a skip result keeps its reason'
Assert-Throws { Assert-DshNodeTestCounts -Files @() -Output "# tests 0`n# pass 0" -Lane 'node' } 'at least 1' 'an empty Node file glob is refused'
Assert-Throws { Assert-DshNodeTestCounts -Files @('a.test.mjs') -Output 'no totals here' -Lane 'node' } 'unverifiable' 'Node output without a test total is refused'
Assert-Throws { Assert-DshNodeTestCounts -Files @('a.test.mjs') -Output "# tests 0`n# pass 0" -Lane 'node' } 'at least 1' 'a zero-test Node run is refused'
$counts = Assert-DshNodeTestCounts -Files @('a.test.mjs', 'b.test.mjs') -Output "# tests 230`n# pass 229" -Lane 'node'
Assert-True ($counts.Files -eq 2 -and $counts.Tests -eq 230 -and $counts.Passed -eq 229) 'a nonempty Node run reports its real counts'

Write-Host ''
if ($script:Failed -gt 0) {
    Write-Host "Preflight unit checks: $($script:Passed) passed, $($script:Failed) FAILED" -ForegroundColor Red
    exit 1
}
Write-Host "Preflight unit checks: $($script:Passed) passed, 0 failed" -ForegroundColor Green
exit 0
