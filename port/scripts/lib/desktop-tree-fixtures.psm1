<#
.SYNOPSIS
  Deterministic process-tree fixtures for the whole-tree accounting in
  `process-tree.psm1`.

.DESCRIPTION
  The accounting rules that matter - PID reuse, an exited parent, an orphan, a
  sibling from another instance, a WebView2 browser process re-parented onto a
  shared environment - cannot be exercised by a live measurement on demand.
  Racing a real process tree to observe a PID reuse is not a test.

  So the fixtures here are MODEL snapshots: plain objects with exactly the
  fields `Get-ProcessTreeSnapshot` produces, including a synthetic
  `(PID, start time)` identity. They are fed to the same
  `Get-ProcessTreeMembership` and `Measure-ProcessTreeTotals` the live path uses,
  so a rule proved here is the rule that runs against a real tree. No fixture
  touches the operating system: nothing is started, stopped or inspected.

  A fixture tree is a CAST, and CASTS ARE NOT EVIDENCE ABOUT THE PRODUCT. The
  shape below (a shell, one WebView2 browser process with renderer/GPU/utility
  children, a Node Host with a tool child) models the real application's
  documented topology so the numbers are comparable in structure; it does not
  claim any particular measured value. Only `-RootPid` against a real launch
  produces a product measurement.

.NOTES
  Windows PowerShell 5.1 and PowerShell 7 compatible. Pure ASCII.
#>

Set-StrictMode -Version Latest

<#
  One synthetic process row.

  @param Pid - the process id.
  @param ParentPid - the parent, or `$null` for an unknown/exited parent.
  @param Name - executable base name without extension.
  @param Role - Root, WebView2, NodeHost, Tool or Unknown.
  @param WorkingSetBytes - the synthetic working set.
  @param CommitBytes - the synthetic private committed bytes.
  @param StartTimeTicks - the synthetic creation time. Two rows may share a PID
    with different ticks to express a PID reuse.
  @param ParentExited - `$true` when the parent exited before the sample. The
    row then reports `Orphaned` from the membership walk.
  @param PrivateWorkingSetBytes - the synthetic private working set; defaults to
    a value strictly below the working set, because shared pages make the
    private figure smaller.
  @returns A row shaped like a real snapshot row.
#>
function New-ProcessTreeFixtureRow {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][Alias('Pid')][int]$MeasuredPid,
        [Nullable[int]]$ParentPid = $null,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][ValidateSet('Root', 'WebView2', 'NodeHost', 'Tool', 'Unknown')][string]$Role,
        [Parameter(Mandatory)][long]$WorkingSetBytes,
        [Parameter(Mandatory)][long]$CommitBytes,
        [Parameter(Mandatory)][long]$StartTimeTicks,
        [switch]$ParentExited,
        [Nullable[long]]$PrivateWorkingSetBytes = $null,
        [Nullable[double]]$CpuSeconds = 0.0
    )

    if ($null -eq $PrivateWorkingSetBytes) {
        # Deliberately strictly smaller than the working set: if a fixture set
        # them equal, a test could not tell the two figures apart and the
        # double-count warning would be untestable.
        $PrivateWorkingSetBytes = [long]([math]::Round($WorkingSetBytes * 0.72))
    }

    return [pscustomobject]@{
        Pid                    = $MeasuredPid
        ParentPid              = $ParentPid
        Name                   = $Name
        Role                   = $Role
        StartTimeUtc           = [datetime]::new($StartTimeTicks, [System.DateTimeKind]::Utc)
        StartTimeReadable      = $true
        WorkingSetBytes        = $WorkingSetBytes
        CommitBytes            = $CommitBytes
        PagedBytes             = [long]($CommitBytes + 4096)
        PrivateWorkingSetBytes = [long]$PrivateWorkingSetBytes
        CpuSeconds             = $CpuSeconds
        HandleCount            = 100
        ThreadCount            = 8
        IdentityMatched        = $null
        MetricsReadable        = $true
        ParentExited           = [bool]$ParentExited
    }
}

<#
  Wraps fixture rows into a snapshot object with the same surface as
  `Get-ProcessTreeSnapshot`.

  @param Rows - the rows.
  @param RootPid - the root pid recorded on the snapshot.
  @param Limits - collection limits to report with the fixture.
  @returns A fixture snapshot.
#>
function New-ProcessTreeFixtureSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Rows,
        [Parameter(Mandatory)][int]$RootPid,
        [AllowEmptyCollection()][string[]]$Limits = @()
    )
    return [pscustomobject]@{
        RootPid         = $RootPid
        StartedAtUtc    = [datetime]::new(0, [System.DateTimeKind]::Utc)
        DurationMs      = 1.0
        Processes       = $Rows
        Limits          = $Limits
        ReaderErrors    = @()
        CounterMapped   = @($Rows | Where-Object { $null -ne $_.PrivateWorkingSetBytes }).Count
        CounterUnmapped = @()
        NativeReader    = $true
        IdentityMode    = 'unavailable'
        Synthetic       = $true
    }
}

<#
  A starting creation time, so every fixture row's start time is a fixed,
  reproducible instant rather than "now".

  @param OffsetSeconds - seconds added to the base instant.
  @returns Ticks.
#>
function Get-ProcessTreeFixtureStartTicks {
    [CmdletBinding()]
    [OutputType([long])]
    param([int]$OffsetSeconds = 0)
    $base = [datetime]::new(2026, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)
    return [long]($base.Ticks + ([long]$OffsetSeconds * [long]10000000))
}

<#
  THE HEALTHY TREE. One application instance, complete and unambiguous:

    1000 Root          dsh-desktop.exe
    1001 +- WebView2    msedgewebview2.exe   (browser)
    1002 |  +- WebView2 msedgewebview2.exe   (renderer)
    1003 |  +- WebView2 msedgewebview2.exe   (gpu)
    1004 |  +- WebView2 msedgewebview2.exe   (utility)
    1005 +- NodeHost    node.exe             (adapter.mjs)
    1006    +- Tool     node.exe             (a tool/subagent child)
    1007    +- Tool     pwsh.exe             (a shell tool)

  @returns A fixture snapshot.
#>
function New-ProcessTreeFixtureHealthy {
    [CmdletBinding()]
    param()

    $rows = @(
        (New-ProcessTreeFixtureRow -Pid 1000 -ParentPid $null -Name 'dsh-desktop' -Role 'Root' `
            -WorkingSetBytes 41943040 -CommitBytes 31457280 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 0))
        (New-ProcessTreeFixtureRow -Pid 1001 -ParentPid 1000 -Name 'msedgewebview2' -Role 'WebView2' `
            -WorkingSetBytes 104857600 -CommitBytes 62914560 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 1))
        (New-ProcessTreeFixtureRow -Pid 1002 -ParentPid 1001 -Name 'msedgewebview2' -Role 'WebView2' `
            -WorkingSetBytes 209715200 -CommitBytes 136314880 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 2))
        (New-ProcessTreeFixtureRow -Pid 1003 -ParentPid 1001 -Name 'msedgewebview2' -Role 'WebView2' `
            -WorkingSetBytes 73400320 -CommitBytes 41943040 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 3))
        (New-ProcessTreeFixtureRow -Pid 1004 -ParentPid 1001 -Name 'msedgewebview2' -Role 'WebView2' `
            -WorkingSetBytes 31457280 -CommitBytes 20971520 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 4))
        (New-ProcessTreeFixtureRow -Pid 1005 -ParentPid 1000 -Name 'node' -Role 'NodeHost' `
            -WorkingSetBytes 157286400 -CommitBytes 125829120 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 5))
        (New-ProcessTreeFixtureRow -Pid 1006 -ParentPid 1005 -Name 'node' -Role 'Tool' `
            -WorkingSetBytes 62914560 -CommitBytes 52428800 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 6))
        (New-ProcessTreeFixtureRow -Pid 1007 -ParentPid 1005 -Name 'pwsh' -Role 'Tool' `
            -WorkingSetBytes 94371840 -CommitBytes 73400320 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 7))
    )
    return New-ProcessTreeFixtureSnapshot -Rows $rows -RootPid 1000
}

<#
  SIBLING INSTANCES. Two application instances are alive at once:

    instance A: root 2000, WebView2 2001, Node Host 2002
    instance B: root 2100, WebView2 2101 (re-parented onto a SHARED browser
                process 2050 that belongs to neither root)

  A measurement rooted at 2000 must count A only. 2050 and 2101 are excluded
  with a reason; counting them is the "another app's WebView2" error, and
  dropping them without a word is the same error told the other way.

  @returns A fixture snapshot.
#>
function New-ProcessTreeFixtureSiblings {
    [CmdletBinding()]
    param()

    $rows = @(
        (New-ProcessTreeFixtureRow -Pid 2000 -ParentPid $null -Name 'dsh-desktop' -Role 'Root' `
            -WorkingSetBytes 41943040 -CommitBytes 31457280 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 0))
        (New-ProcessTreeFixtureRow -Pid 2001 -ParentPid 2000 -Name 'msedgewebview2' -Role 'WebView2' `
            -WorkingSetBytes 104857600 -CommitBytes 62914560 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 1))
        (New-ProcessTreeFixtureRow -Pid 2002 -ParentPid 2000 -Name 'node' -Role 'NodeHost' `
            -WorkingSetBytes 134217728 -CommitBytes 104857600 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 2))
        (New-ProcessTreeFixtureRow -Pid 2050 -ParentPid $null -Name 'msedgewebview2' -Role 'WebView2' `
            -WorkingSetBytes 125829120 -CommitBytes 83886080 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 3) -ParentExited)
        (New-ProcessTreeFixtureRow -Pid 2100 -ParentPid $null -Name 'dsh-desktop' -Role 'Root' `
            -WorkingSetBytes 41943040 -CommitBytes 31457280 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 4))
        (New-ProcessTreeFixtureRow -Pid 2101 -ParentPid 2050 -Name 'msedgewebview2' -Role 'WebView2' `
            -WorkingSetBytes 178257920 -CommitBytes 115343360 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 5))
        (New-ProcessTreeFixtureRow -Pid 2102 -ParentPid 2100 -Name 'node' -Role 'NodeHost' `
            -WorkingSetBytes 142606336 -CommitBytes 115343360 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 6))
    )
    return New-ProcessTreeFixtureSnapshot -Rows $rows -RootPid 2000
}

<#
  ROOT EXIT. The root is gone: the snapshot still contains the Host and the tool
  children, whose parent links now point at a pid that is not present. A
  measurement must refuse to invent a total.

  @returns A fixture snapshot whose root pid 3000 is absent.
#>
function New-ProcessTreeFixtureRootExited {
    [CmdletBinding()]
    param()

    $rows = @(
        (New-ProcessTreeFixtureRow -Pid 3001 -ParentPid 3000 -Name 'node' -Role 'NodeHost' `
            -WorkingSetBytes 157286400 -CommitBytes 125829120 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 1) -ParentExited)
        (New-ProcessTreeFixtureRow -Pid 3002 -ParentPid 3001 -Name 'node' -Role 'Tool' `
            -WorkingSetBytes 62914560 -CommitBytes 52428800 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 2))
    )
    return New-ProcessTreeFixtureSnapshot -Rows $rows -RootPid 3000
}

<#
  ORPHANED TOOL. The Host exited; a tool child survives and is re-parented by
  Windows onto another live process (pid 4000, which is NOT in this snapshot's
  tree). The orphan carries large figures, so a walk that silently counted every
  Node process would be visibly wrong.

  @returns A fixture snapshot.
#>
function New-ProcessTreeFixtureOrphanedTool {
    [CmdletBinding()]
    param()

    $rows = @(
        (New-ProcessTreeFixtureRow -Pid 3100 -ParentPid $null -Name 'dsh-desktop' -Role 'Root' `
            -WorkingSetBytes 41943040 -CommitBytes 31457280 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 0))
        (New-ProcessTreeFixtureRow -Pid 3101 -ParentPid 3100 -Name 'msedgewebview2' -Role 'WebView2' `
            -WorkingSetBytes 104857600 -CommitBytes 62914560 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 1))
        (New-ProcessTreeFixtureRow -Pid 3102 -ParentPid 3100 -Name 'node' -Role 'NodeHost' `
            -WorkingSetBytes 157286400 -CommitBytes 125829120 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 2))
        (New-ProcessTreeFixtureRow -Pid 3105 -ParentPid 4000 -Name 'node' -Role 'Tool' `
            -WorkingSetBytes 314572800 -CommitBytes 268435456 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 3) -ParentExited)
    )
    return New-ProcessTreeFixtureSnapshot -Rows $rows -RootPid 3100
}

<#
  PID REUSE ACROSS TWO SNAPSHOTS.

    snapshot 1: pid 5000 is a Tool with start time T+10
    snapshot 2: pid 5000 is an UNRELATED process (a stranger) with start T+900

  The comparison must report one exit and one start, and must report pid 5000 as
  reused. A pid-only diff would report pid 5000 as continuously alive.

  @returns A hashtable with `First` and `Second` snapshots.
#>
function New-ProcessTreeFixturePidReusePair {
    [CmdletBinding()]
    param()

    $first = New-ProcessTreeFixtureSnapshot -RootPid 5000 -Rows @(
        (New-ProcessTreeFixtureRow -Pid 5000 -ParentPid $null -Name 'dsh-desktop' -Role 'Root' `
            -WorkingSetBytes 41943040 -CommitBytes 31457280 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 0))
        (New-ProcessTreeFixtureRow -Pid 5005 -ParentPid 5000 -Name 'node' -Role 'NodeHost' `
            -WorkingSetBytes 157286400 -CommitBytes 125829120 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 5))
        (New-ProcessTreeFixtureRow -Pid 5010 -ParentPid 5005 -Name 'node' -Role 'Tool' `
            -WorkingSetBytes 62914560 -CommitBytes 52428800 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 10))
    )
    $second = New-ProcessTreeFixtureSnapshot -RootPid 5000 -Rows @(
        (New-ProcessTreeFixtureRow -Pid 5000 -ParentPid $null -Name 'dsh-desktop' -Role 'Root' `
            -WorkingSetBytes 41943040 -CommitBytes 31457280 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 0))
        (New-ProcessTreeFixtureRow -Pid 5005 -ParentPid 5000 -Name 'node' -Role 'NodeHost' `
            -WorkingSetBytes 159383552 -CommitBytes 127926272 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 5))
        (New-ProcessTreeFixtureRow -Pid 5010 -ParentPid $null -Name 'chrome' -Role 'Unknown' `
            -WorkingSetBytes 734003200 -CommitBytes 671088640 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 900) -ParentExited)
    )
    return @{ First = $first; Second = $second }
}

<#
  EQUAL-FIGURE TRAP. One root whose working set equals its private committed
  bytes. Used to prove the two figures are kept distinct in the report and in the
  role table; if a code path ever aliases them, this fixture makes it visible.

  @returns A fixture snapshot.
#>
function New-ProcessTreeFixtureEqualFigures {
    [CmdletBinding()]
    param()
    return New-ProcessTreeFixtureSnapshot -RootPid 6000 -Rows @(
        (New-ProcessTreeFixtureRow -Pid 6000 -ParentPid $null -Name 'dsh-desktop' -Role 'Root' `
            -WorkingSetBytes 1048576 -CommitBytes 1048576 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 0) -PrivateWorkingSetBytes 1048576)
        (New-ProcessTreeFixtureRow -Pid 6001 -ParentPid 6000 -Name 'node' -Role 'NodeHost' `
            -WorkingSetBytes 2097152 -CommitBytes 2097152 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 1) -PrivateWorkingSetBytes 2097152)
    )
}

<#
  UNREADABLE METRICS. A counted process whose memory could not be read. The
  totals must still be produced for the readable processes, and the completeness
  flag must be `$false` so the claim degrades to `partial`.

  @returns A fixture snapshot.
#>
function New-ProcessTreeFixtureUnreadableMetrics {
    [CmdletBinding()]
    param()

    $rows = @(
        (New-ProcessTreeFixtureRow -Pid 7000 -ParentPid $null -Name 'dsh-desktop' -Role 'Root' `
            -WorkingSetBytes 41943040 -CommitBytes 31457280 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 0))
        (New-ProcessTreeFixtureRow -Pid 7001 -ParentPid 7000 -Name 'node' -Role 'NodeHost' `
            -WorkingSetBytes 157286400 -CommitBytes 125829120 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 1))
        (New-ProcessTreeFixtureRow -Pid 7002 -ParentPid 7001 -Name 'node' -Role 'Tool' `
            -WorkingSetBytes 62914560 -CommitBytes 52428800 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 2))
    )
    # Simulate a denied read on one process: Present but with null figures.
    $rows[2].WorkingSetBytes = $null
    $rows[2].CommitBytes = $null
    $rows[2].PrivateWorkingSetBytes = $null
    $rows[2].MetricsReadable = $false
    return New-ProcessTreeFixtureSnapshot -Rows $rows -RootPid 7000 -Limits @('metrics refused for pid 7002')
}

<#
  IDENTITY REATTACHMENT. A WebView2 renderer whose parent is NOT in the snapshot
  (the shared browser process lives outside this observation) but which carries
  the root's identity token. It must be counted with basis `identity`, not
  dropped as an orphan.

  @returns A fixture snapshot.
#>
function New-ProcessTreeFixtureIdentityReattach {
    [CmdletBinding()]
    param()

    $rows = @(
        (New-ProcessTreeFixtureRow -Pid 8000 -ParentPid $null -Name 'dsh-desktop' -Role 'Root' `
            -WorkingSetBytes 41943040 -CommitBytes 31457280 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 0))
        (New-ProcessTreeFixtureRow -Pid 8001 -ParentPid 8000 -Name 'node' -Role 'NodeHost' `
            -WorkingSetBytes 157286400 -CommitBytes 125829120 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 1))
        (New-ProcessTreeFixtureRow -Pid 8050 -ParentPid 9999 -Name 'msedgewebview2' -Role 'WebView2' `
            -WorkingSetBytes 209715200 -CommitBytes 136314880 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 2) -ParentExited)
        (New-ProcessTreeFixtureRow -Pid 8051 -ParentPid 8050 -Name 'msedgewebview2' -Role 'WebView2' `
            -WorkingSetBytes 104857600 -CommitBytes 62914560 -StartTimeTicks (Get-ProcessTreeFixtureStartTicks -OffsetSeconds 3))
    )
    $rows[2].IdentityMatched = $true
    return New-ProcessTreeFixtureSnapshot -Rows $rows -RootPid 8000
}

Export-ModuleMember -Function @(
    'New-ProcessTreeFixtureRow'
    'New-ProcessTreeFixtureSnapshot'
    'Get-ProcessTreeFixtureStartTicks'
    'New-ProcessTreeFixtureHealthy'
    'New-ProcessTreeFixtureSiblings'
    'New-ProcessTreeFixtureRootExited'
    'New-ProcessTreeFixtureOrphanedTool'
    'New-ProcessTreeFixturePidReusePair'
    'New-ProcessTreeFixtureEqualFigures'
    'New-ProcessTreeFixtureUnreadableMetrics'
    'New-ProcessTreeFixtureIdentityReattach'
)
