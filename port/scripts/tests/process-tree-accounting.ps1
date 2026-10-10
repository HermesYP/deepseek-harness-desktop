<#
.SYNOPSIS
  Pure deterministic process accounting regressions. No process is launched,
  stopped, or inspected; synthetic fixtures are not product measurements.
#>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '../lib/process-tree.psm1') -Force
Import-Module (Join-Path $PSScriptRoot '../lib/desktop-tree-fixtures.psm1') -Force
$script:Assertions = 0
function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -ne $Expected) { throw "$Message : expected '$Expected', got '$Actual'" }
    $script:Assertions++
}
function Assert-Member($Membership, [int]$ProcessId, [bool]$Present, [string]$Message) {
    Assert-Equal (@($Membership.Counted | Where-Object { $_.Pid -eq $ProcessId }).Count -eq 1) $Present $Message
}
function New-ModelRow([int]$ProcessId, $ParentId, [int]$Born, [string]$Role = 'Tool') {
    New-ProcessTreeFixtureRow -Pid $ProcessId -ParentPid $ParentId -Name 'node' -Role $Role `
        -WorkingSetBytes 100 -CommitBytes 80 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds $Born)
}
function New-Counter([string]$Instance, [string]$Name, [long]$Value) {
    [pscustomobject]@{ InstanceName = $Instance; Path = "\\host\process($Instance)\$Name"; CookedValue = $Value; Timestamp = [datetime]'2026-01-01T00:00:00Z' }
}

# CIM timestamps are compared at their own precision, retained identities are not.
$ticks = [long]'638000000000000000'
Assert-Equal (Test-ProcessCreationObservation -ExpectedTicks ($ticks + 9) -ObservedTicks $ticks) $true 'CIM sub-microsecond normalization'
Assert-Equal (Test-ProcessCreationObservation -ExpectedTicks ($ticks + 10) -ObservedTicks $ticks) $false 'different CIM creation observation rejected'
Assert-Equal (Test-ProcessCreationObservation -ExpectedTicks $null -ObservedTicks $ticks) $false 'unknown creation observation rejected'

# Parameter aliases must remain compatible without binding read-only $PID.
$id = New-ProcessIdentity -Pid 123 -StartTimeTicks 456
Assert-Equal $id.Pid 123 'identity alias'
Assert-Equal (Resolve-AmbiguousRole -Role NodeHost -Pid 123 -HostPid 123) 'NodeHost' 'role alias'
$healthy = New-ProcessTreeFixtureHealthy
$membership = Get-ProcessTreeMembership -Snapshot $healthy -RootPid 1000
$totals = Measure-ProcessTreeTotals -Counted $membership.Counted
Assert-Equal $totals.ProcessCount 8 'all process families counted'
Assert-Equal $totals.CommitBytes 545259520 'private commit exact sum'
Assert-Equal $totals.WorkingSetBytes 775946240 'working set exact sum, not unique resident pages'
Assert-Equal $totals.WorkingSetComplete $true 'healthy working set complete'
Assert-Equal ((Get-ProcessTreeClaim -Totals $totals -Membership $membership).Claimable) 'full' 'healthy fixture claim'
Assert-Equal (@($membership.Counted | Where-Object Role -eq WebView2).Count) 4 'WebView2 family'
Assert-Equal (@($membership.Counted | Where-Object Role -eq Tool).Count) 2 'tool family'

# Known descendants survive exited parents, reparenting, and even root exit.
$history = @{}
$rootTicks = $healthy.Processes[0].StartTimeUtc.Ticks
$first = Get-ProcessTreeSeriesMembership -Snapshot $healthy -RootPid 1000 -RootStartTimeTicks $rootTicks -History $history
$survivors = @($healthy.Processes | Where-Object { $_.Pid -notin @(1000, 1005) })
$survivors | Where-Object Pid -eq 1006 | ForEach-Object { $_.ParentPid = 9999 }
$survivors | Where-Object Pid -eq 1007 | ForEach-Object { $_.ParentPid = $null }
$later = New-ProcessTreeFixtureSnapshot -RootPid 1000 -Rows $survivors
$tracked = Get-ProcessTreeSeriesMembership -Snapshot $later -RootPid 1000 -RootStartTimeTicks $rootTicks -History $history
Assert-Equal $tracked.RootResolved $false 'root exit remains an explicit qualification failure'
Assert-Equal $tracked.Counted.Count 6 'surviving known identities still counted'
Assert-Member $tracked 1006 $true 'reparented tool retained'
Assert-Member $tracked 1007 $true 'orphaned tool retained'
Assert-Equal (@($tracked.Counted | Where-Object Pid -eq 1006)[0].Basis) 'retained-identity' 'retained attribution visible'
$newChild = New-ModelRow -ProcessId 1010 -ParentId 1006 -Born 10
$later.Processes += $newChild
$tracked = Get-ProcessTreeSeriesMembership -Snapshot $later -RootPid 1000 -RootStartTimeTicks $rootTicks -History $history
Assert-Member $tracked 1010 $true 'new descendant of retained parent counted'

# A replacement root cannot bring its unrelated children into the old launch.
$replacement = New-ModelRow -ProcessId 1000 -ParentId $null -Born 100 -Role Root
$foreign = New-ModelRow -ProcessId 1999 -ParentId 1000 -Born 101
$later.Processes += @($replacement, $foreign)
$tracked = Get-ProcessTreeSeriesMembership -Snapshot $later -RootPid 1000 -RootStartTimeTicks $rootTicks -History $history
Assert-Member $tracked 1000 $false 'reused root excluded'
Assert-Member $tracked 1999 $false 'replacement root descendants excluded'
Assert-Member $tracked 1006 $true 'old launch survivor retained despite root PID reuse'

# Reusing an individual descendant PID must not inherit its retained identity.
$pair = New-ProcessTreeFixturePidReusePair
$history = @{}
$first = Get-ProcessTreeSeriesMembership -Snapshot $pair.First -RootPid 5000 -History $history
$second = Get-ProcessTreeSeriesMembership -Snapshot $pair.Second -RootPid 5000 -History $history
Assert-Member $second 5010 $false 'reused orphan PID not retained'
Assert-Equal ((Compare-ProcessTreeSnapshot -Previous $pair.First -Current $pair.Second).PidReused.Count) 1 'reuse reported'

# Stale parent IDs and unreadable creation times must fail closed.
$root = New-ModelRow -ProcessId 1 -ParentId $null -Born 0 -Role Root
$parent = New-ModelRow -ProcessId 2 -ParentId 1 -Born 10 -Role NodeHost
$oldChild = New-ModelRow -ProcessId 3 -ParentId 2 -Born 5
$unknownChild = New-ModelRow -ProcessId 4 -ParentId 2 -Born 11
$unknownChild.StartTimeUtc = $null
$unknownChild.StartTimeReadable = $false
$snapshot = New-ProcessTreeFixtureSnapshot -RootPid 1 -Rows @($oldChild, $unknownChild, $parent, $root)
$membership = Get-ProcessTreeMembership -Snapshot $snapshot -RootPid 1
Assert-Member $membership 2 $true 'valid parent belongs'
Assert-Member $membership 3 $false 'child older than reused parent rejected'
Assert-Member $membership 4 $false 'unknown creation edge rejected'
Assert-Equal ($snapshot.Limits.Count -gt 0) $true 'unverified parent edges reported'

# Identity seeds expand in any enumeration order, and explicit exclusions win.
$reattach = New-ProcessTreeFixtureIdentityReattach
$reattach.Processes = @($reattach.Processes | Sort-Object Pid -Descending)
$membership = Get-ProcessTreeMembership -Snapshot $reattach -RootPid 8000
Assert-Member $membership 8050 $true 'identity matched seed'
Assert-Member $membership 8051 $true 'identity seed descendant regardless of row order'
Assert-Equal (@($membership.Excluded | Where-Object { $_.Pid -in @(8050,8051) }).Count) 0 'counted rows not also excluded'
$reattach.Processes | Where-Object Pid -eq 8051 | ForEach-Object { $_.IdentityMatched = $true }
$baseExcluded = Get-ProcessTreeMembership -Snapshot $reattach -RootPid 8000 -ExcludedRoots @(8050)
Assert-Member $baseExcluded 8050 $false 'base exclusion wins over identity seed'
Assert-Member $baseExcluded 8051 $false 'base descendant exclusion wins over identity match'
$history = @{}
$first = Get-ProcessTreeSeriesMembership -Snapshot $reattach -RootPid 8000 -History $history
$excluded = Get-ProcessTreeSeriesMembership -Snapshot $reattach -RootPid 8000 -ExcludedRoots @(8050) -History $history
Assert-Member $excluded 8050 $false 'explicit exclusion beats retained identity'
Assert-Member $excluded 8051 $false 'explicit exclusion covers descendants'

# A newer excluded PID cannot claim an older, independently proven identity.
$oldChild.IdentityMatched = $true
$staleExcluded = Get-ProcessTreeMembership -Snapshot $snapshot -RootPid 1 -ExcludedRoots @(2)
Assert-Member $staleExcluded 2 $false 'distinct new parent explicitly excluded'
Assert-Member $staleExcluded 3 $true 'stale excluded edge cannot override independent identity'

# Missing root metrics must degrade totals instead of silently omitting it.
$unreadableRoot = New-ProcessTreeFixtureHealthy
$unreadableRoot.Processes[0].WorkingSetBytes = $null
$unreadableRoot.Processes[0].CommitBytes = $null
$unreadableRoot.Processes[0].PrivateWorkingSetBytes = $null
$unreadableRoot.Processes[0].MetricsReadable = $false
$membership = Get-ProcessTreeMembership -Snapshot $unreadableRoot -RootPid 1000
$totals = Measure-ProcessTreeTotals -Counted $membership.Counted
Assert-Equal $totals.ProcessCount 8 'unreadable root still counted'
Assert-Equal $totals.WorkingSetComplete $false 'unreadable root degrades working set'
Assert-Equal $totals.CommitComplete $false 'unreadable root degrades commit'
Assert-Equal ((Get-ProcessTreeClaim -Totals $totals -Membership $membership).Claimable) 'partial' 'unreadable root cannot claim full'
$unreadable = New-ProcessTreeFixtureUnreadableMetrics
$membership = Get-ProcessTreeMembership -Snapshot $unreadable -RootPid 7000
$totals = Measure-ProcessTreeTotals -Counted $membership.Counted
Assert-Equal $totals.ProcessCount 3 'unreadable child still counted'
Assert-Equal $totals.CommitComplete $false 'unreadable child degrades totals'

$missingAuxiliary = New-ProcessTreeFixtureHealthy
$missingAuxiliary.Processes[0].PrivateWorkingSetBytes = $null
$missingAuxiliary.Processes[0].CpuSeconds = $null
$membership = Get-ProcessTreeMembership -Snapshot $missingAuxiliary -RootPid 1000
$totals = Measure-ProcessTreeTotals -Counted $membership.Counted
Assert-Equal $totals.PrivateWorkingSetComplete $false 'missing private WS completeness'
Assert-Equal $totals.CpuComplete $false 'missing CPU completeness'
Assert-Equal ((Get-ProcessTreeClaim -Totals $totals -Membership $membership).Claimable) 'partial' 'all advertised aggregate gaps prevent full claim'

# An earlier gap cannot disappear behind a complete final sample.
$full = [pscustomobject]@{ Claim = [pscustomobject]@{ Claimable = 'full' } }
$partial = [pscustomobject]@{ Claim = [pscustomobject]@{ Claimable = 'partial' } }
$none = [pscustomobject]@{ Claim = [pscustomobject]@{ Claimable = 'none' } }
Assert-Equal ((Get-ProcessTreeRunClaim -Samples @($partial,$full)).Claimable) 'partial' 'early partial preserved'
Assert-Equal ((Get-ProcessTreeRunClaim -Samples @($none,$full)).Claimable) 'none' 'early missing root preserved'
Assert-Equal ((Get-ProcessTreeRunClaim -Samples @($full,$full)).Claimable) 'full' 'all snapshots complete'
Assert-Equal ((Get-ProcessTreeRunClaim -Samples @()).Claimable) 'none' 'empty run not claimable'

# Same-name private WS counters must pair to ID Process, never sorted values.
$counters = @(
    (New-Counter 'node#1' 'Working Set - Private' 900)
    (New-Counter 'node' 'ID Process' 12)
    (New-Counter 'node#1' 'ID Process' 11)
    (New-Counter 'node' 'Working Set - Private' 100)
)
$map = ConvertTo-PrivateWorkingSetCounterMap -CounterSamples $counters
Assert-Equal $map[11].Bytes 900 'same-name PID 11 retains its own counter'
Assert-Equal $map[12].Bytes 100 'same-name PID 12 retains its own counter'
Assert-Equal $map.Count 2 'counter map keyed by PID'
$counters += @((New-Counter 'node#2' 'ID Process' 11), (New-Counter 'node#2' 'Working Set - Private' 700))
$map = ConvertTo-PrivateWorkingSetCounterMap -CounterSamples $counters
Assert-Equal $map.ContainsKey(11) $false 'ambiguous counter identity rejected'
Assert-Equal $map.ContainsKey(12) $true 'unambiguous counter identity preserved'

Write-Host "PASS: $script:Assertions deterministic accounting assertions (synthetic, not product evidence)."
