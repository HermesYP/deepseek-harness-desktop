<#
.SYNOPSIS
  Measure the whole process tree of the Rust/Tauri desktop port: Rust shell,
  WebView2, Node Host and tool/subagent descendants.

.DESCRIPTION
  This is the collector `docs/implementation-plan.md` Milestone 6 needs ("whole
  process tree private memory ... Rust shell + WebView2 + Node + tool children")
  and that no existing script in this port provided. `benchmark.ps1` measures the
  static HTTP handler and PLANS the process-tree lane without running it;
  `verify-installed.ps1` checks installed behaviour, not memory;
  `dev-e2e.ps1` drives a launch but reports no tree accounting. Nothing here
  duplicates them.

  MODES

    plan      Print the measurement design, the comparison procedure for a
              pinned reference versus the Rust port on the same workload, the
              reproducibility metadata this tool records, the stuck-agent log
              criteria and the unavailable native prerequisites. Measures and
              touches nothing. This is the default.

    model     Run the deterministic fixture trees through the real accounting
              code and print every expected value. No operating-system access of
              any kind. This is what makes the accounting testable without
              racing a live tree.

    list      Enumerate live processes and print what a snapshot CAN read on this
              host: which parent-PID source works, whether creation times and
              performance counters are available, and every limit that applies.
              Reads process metadata only.

    collect   Attribute a deep snapshot of the process tree rooted at -RootPid,
              print the per-role breakdown, the whole-tree figures and the
              completeness of each, and optionally write JSON. Requires -RootPid:
              there is no default, because the default would be some other
              application's tree.

  IT IS READ-ONLY. It never starts, stops, suspends or modifies a process, never
  installs anything and never opens a network connection. It also never collects
  command lines, environment blocks, URLs, credentials or request contents; see
  the limits section of `plan`.

  THE TWO FIGURES ARE NOT INTERCHANGEABLE

    WorkingSetBytes  the sum of working sets. Shared pages mapped in several
                     processes are counted once per holder, so this is an UPPER
                     BOUND, not an additive total.
    CommitBytes      private committed bytes, charged to exactly one process, so
                     it sums soundly. "Private memory" means THIS figure.

  Some children of the tree escape a naive parent walk: WebView2 browser
  processes may be shared and re-parented outside the shell, and guest webviews
  use their own WebView2 data directory, hence their own environment and browser
  process. Exact PID/creation identities observed earlier in this run are
  retained after reparenting or ancestor exit. Never-observed off-tree processes
  remain unqualified. `-IdentityToken` alone cannot enable reattachment: this CLI
  deliberately has no command-line provider and records that collection limit.

.PARAMETER Mode
  plan | model | list | collect. Default plan.

.PARAMETER RootPid
  The root of the tree to measure, normally the `dsh-desktop.exe` process. There
  is deliberately no default. Required by `collect`.

.PARAMETER RootStartTimeUtc
  The root's creation time as recorded when it was launched, ISO-8601. When
  supplied, `collect` asserts that the live process holding `-RootPid` still has
  that creation time; a mismatch means the PID slot changed owner and the run is
  refused rather than measured against a stranger. If omitted, the first sample
  pins the root's readable creation time for every later sample.

.PARAMETER IdentityToken
  A public string that identifies this application instance's processes, for
  example the WebView2 user-data directory passed at launch. This CLI cannot
  resolve it without a command-line provider; supplying it records a limit, not
  successful reattachment. Never a credential and never a URL.

.PARAMETER ExcludeRootPid
  Additional root PIDs known to belong to other application instances. Their
  descendants are excluded and reported, so a second running copy cannot inflate
  the number.

.PARAMETER OutputDir
  Where a `collect` result is written. Defaults to `port\.scratch\measure-desktop-tree`.

.PARAMETER Format
  console | json | both (default both). `json` writes the file and prints only
  the path; `console` prints and writes nothing.

.PARAMETER StartupMs
  An ALREADY OBSERVED startup figure, in milliseconds, from process create to
  first usable UI. Carried into the record as supplied evidence. This tool does
  not observe it and never estimates it.

.PARAMETER IdleCpuPercent
  An already measured idle CPU percentage over a stated quiet window.

.PARAMETER BusyMarker
  Zero or more `name=value` pairs of already measured busy-phase latencies in
  milliseconds, for example `send=180`. Recorded verbatim as supplied.

.EXAMPLE
  .\port\scripts\measure-desktop-tree.ps1 -Mode plan

.EXAMPLE
  .\port\scripts\measure-desktop-tree.ps1 -Mode model

.EXAMPLE
  .\port\scripts\measure-desktop-tree.ps1 -Mode list

.EXAMPLE
  .\port\scripts\measure-desktop-tree.ps1 -Mode collect -RootPid 12345 `
      -IdentityToken 'C:\Users\me\AppData\Local\DeepSeek Harness\webview-data'

.NOTES
  Windows PowerShell 5.1 and PowerShell 7 compatible. Pure ASCII.
#>
[CmdletBinding()]
param(
    [ValidateSet('plan', 'model', 'list', 'collect')]
    [string]$Mode = 'plan',

    [int]$RootPid = 0,

    [string]$RootStartTimeUtc,

    [string]$IdentityToken,

    [int[]]$ExcludeRootPid = @(),

    [string]$OutputDir,

    [ValidateSet('console', 'json', 'both')]
    [string]$Format = 'both',

    [double]$StartupMs = -1,

    [double]$IdleCpuPercent = -1,

    [string[]]$BusyMarker = @(),

    [int]$SampleCount = 1,

    [int]$SampleIntervalMs = 0
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PortRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $PortRoot
$LibDir = Join-Path $PSScriptRoot 'lib'
if (-not $OutputDir) { $OutputDir = Join-Path $PortRoot '.scratch\measure-desktop-tree' }

Import-Module (Join-Path $LibDir 'process-tree.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $LibDir 'desktop-tree-fixtures.psm1') -Force -DisableNameChecking

function Write-Section([string]$Title) {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor DarkGray
    Write-Host $Title -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor DarkGray
}

function Write-Line([string]$Text, [string]$Colour = 'Gray') {
    Write-Host $Text -ForegroundColor $Colour
}

# ---------------------------------------------------------------------------
# plan
# ---------------------------------------------------------------------------

<#
  Prints the measurement design. Every rule below exists because leaving it out
  produced, or would produce, a number nobody can defend.
#>
function Show-Plan {
    Write-Section 'Whole-tree desktop measurement: design'

    Write-Host @'
WHAT IS MEASURED
  One observation of every process that belongs to ONE application instance:
    Root      the Rust shell, dsh-desktop.exe
    WebView2  every msedgewebview2.exe in the instance, including the browser
              process, each renderer, the GPU process and utility processes
    NodeHost  the supervised Node Host (node.exe running adapter.mjs)
    Tool      tool, subagent, workflow and background-job children of the Host
    Unknown   attributed to the tree but not classifiable from safe evidence

  Both of these are produced for every role and for the tree:
    WorkingSetBytes          the SUM of working sets - not unique resident pages;
                             pages mapped in several processes are counted in
                             each of them (a browser process and its renderers
                             share a great deal)
    CommitBytes              private committed bytes - charged to exactly one
                             process, sums soundly; THIS is "private memory"
    PrivateWorkingSetBytes   the performance counter figure, when it maps

  Quote the exact metric. Working-set SUM can double-count shared resident
  pages; private commit is neither resident memory nor the physical footprint.
  Partial sums do not bound the full application's unique physical memory.
'@

    Write-Host ''
    Write-Line 'MEMBERSHIP RULES' 'Green'
    Write-Host @'
  M1  Lineage. Every live parent edge must have readable creation identities
      and a parent no newer than the child; stale PID links are rejected.
  M2  Retained identity. A previously observed exact PID/creation pair survives
      reparenting or ancestor exit, and seeds new verified descendants. New
      off-tree strangers remain unqualified. Token-based identity exists in the
      module for explicitly supplied providers, but THIS CLI has no provider.
  M3  Exclusion. A process descending from a distinct root passed as
      -ExcludeRootPid is EXCLUDED with a reason. A second running copy of the
      application must not inflate the number, and it must not be dropped
      silently either.
  M4  Orphans. A process whose parent is absent from the snapshot and which does
      not match the identity token is reported as ORPHANED with its parent pid
      and the reason. It is never attached to the root on the assumption that it
      "looks like" part of the tree.
  M5  Unknowns. Anything attributed to the tree but unclassifiable lands in
      Unknown. It is still counted, because dropping it would understate the
      tree, but it is visible in the breakdown.
  M6  Identity is (PID, creation time). A PID is a reusable slot. A PID observed
      in two snapshots is the same process only when the creation time matches
      exactly; otherwise one process exited and another took the slot, and the
      diff reports a reuse.
'@

    Write-Host ''
    Write-Line 'COMPLETENESS' 'Green'
    Write-Host @'
  A figure is reported as "full" only when every counted process yielded the
  figure and no collection limit applied. Otherwise it is reported as "partial"
  with the reason, or refused as "none". The rules:
    C1  Metrics refused for one counted process  -> partial, reason named.
    C2  Any orphan that could not be attributed  -> partial: the true tree is at
        least this large, so the number is a LOWER bound on membership.
    C3  A COMPLETE working-set sum can overcount the observed processes'
        shared resident pages. A partial sum cannot bound the full footprint.
    C4  One-process snapshot when a Host was expected -> partial, reason named.
    C5  Root absent, or its creation time not matching the recorded launch
        identity -> "none". Surviving known descendants may still be recorded,
        but cannot upgrade root failure to a whole-tree claim.
    C6  Every sample qualifies the RUN. A complete last sample cannot erase an
        earlier missing root, unreadable metric, or collection limit.
'@

    Write-Host ''
    Write-Line 'WHAT THIS TOOL REFUSES TO COLLECT' 'Yellow'
    Write-Host @'
  Command lines, environment blocks, window titles, URLs, credentials, tokens,
  request or response contents, file contents. This CLI has no command-line
  provider: a PUBLIC -IdentityToken by itself does not enable matching, and that
  limitation is recorded. Only previously observed exact PID/creation identities
  are retained after reparenting or ancestor exit; strangers are not guessed in.
'@

    Write-Host ''
    Write-Line 'SAMPLING LIMITS' 'Yellow'
    Write-Host @'
  S1  A snapshot is one instant. A short-lived tool child can start and exit
      between two samples and never appear in either. Use -SampleCount with
      -SampleIntervalMs for a series; report the series, not the best sample.
  S2  Enumeration itself takes time (DurationMs is recorded). A tree changing
      during enumeration can be seen half-updated.
  S3  Peak values are not captured. PeakWorkingSet is a lifetime maximum, not a
      peak of the measured interval, so it is not reported here.
  S4  Working-set figures move with system memory pressure: the same process can
      report a much smaller working set after the OS trims it. Compare runs on
      one machine, under one load, close in time.
  S5  The performance counter is sampled separately from the process list, so a
      process that exits in between can leave a counter value unmapped. That is
      reported, not guessed.
'@

    Write-Host ''
    Write-Line 'RESPONSIVENESS MARKERS' 'Yellow'
    Write-Host @'
  Startup, idle CPU and busy-phase latencies are recorded ONLY when supplied on
  the command line (-StartupMs, -IdleCpuPercent, -BusyMarker). This tool does not
  launch the application, does not synthesize input, does not read a trace, and
  therefore never invents one of these numbers. A marker with no supplied value
  is present in the record with status "not-measured", so the gap travels with
  the result instead of disappearing.
'@

    Write-Host ''
    Write-Line 'REFERENCE vs PORT COMPARISON PROCEDURE' 'Green'
    Write-Host @'
  Pin every one of these; a comparison that moves one of them measures the
  difference between two setups, not between two builds.

  1.  The reference is the pinned revision recorded in docs/implementation-plan.md
      and docs/reference-environment.md. Record its commit and the port's build
      identity with every number.
  2.  Release builds on BOTH sides. A debug build is not a comparison.
  3.  One machine, one OS build, one power plan, one DPI scale, one viewport, one
      locale, one theme, the same background load. Interleave the runs; never
      batch one side and then the other.
  4.  The SAME workload, driven by the same fixture: the same session fixture, the
      same message count, the same interaction sequence, the same settled
      checkpoint. A session written by one build and read by the other is a
      compatibility test, not a benchmark.
  5.  The SAME window state: same size, same visibility, same number of open
      guest webviews. A hidden guest webview and a visible one do not cost the
      same.
  6.  State whether the WebView2 user-data directory was preserved or reset. That
      single choice moves warm-start and memory more than any port change.
  7.  Sample the tree at named checkpoints - startup settled, idle 60 s, after a
      defined workload, after a long conversation - and report each checkpoint
      separately. A single end-point figure cannot tell a leak from a large
      steady state.
  8.  Discard the first run of each lane; report every repetition and the median.
      A best-of-N is not a result.
  9.  This tool must observe the SAME topology on both sides before any number is
      compared. If the reference is Electron-shaped and the port is
      WebView2-shaped, the per-role breakdown differs by construction, and the
      only comparable figure is a whole-tree private total at a matched
      checkpoint with the difference named.
  10. If only one side ran, report the lane as INCOMPLETE. Never publish a
      cross-machine, cross-build or simulated comparison.
  11. Whole-tree figures only. A shell-only or WebView-only number must never be
      presented as the application's memory. Use -Mode collect so the role
      breakdown is attached to the total.
  12. Native prerequisites that this host cannot satisfy are listed below; a
      comparison that needs one of them is BLOCKED, not approximated.
'@

    Write-Host ''
    Write-Line 'NEVER DO THIS FROM SOURCE TESTS' 'Red'
    Write-Host @'
  Do not claim the port is faster or uses less memory because unit tests, a
  fixture model or a successful compile say so. `-Mode model` exercises
  ACCOUNTING against synthetic trees; it is evidence about this tool, and about
  nothing the product does. A product performance claim requires a real launch
  that this tool did not perform.
'@

    Write-Host ''
    Write-Line 'STUCK-AGENT EVIDENCE CRITERIA' 'Green'
    Write-Host @'
  Memory alone does not show an agent is stuck, and an agent stall does not prove
  a memory defect. To attribute a stall, record, with timestamps from ONE clock:

  L1  The Host's own state transitions from the diagnostic log: the last
      completed stage (boot, DI, transport, provider/tool, approval, renderer
      wait) before the stall. A stall with no logged stage change is a stall in
      the stage that was running.
  L2  The session log's last durable event and its sequence number, plus whether
      the turn is open. An open turn with no new event for a stated interval is
      the observable form of "stuck"; state the interval.
  L3  Whether the tool child that was running still exists at the checkpoint, and
      its (PID, creation time). A tool child that exited while the Host still
      waits is a lifecycle defect, not a memory defect.
  L4  The tree's per-role private bytes at stall time versus at the last healthy
      checkpoint. A stall with flat private bytes is not a memory-pressure stall.
  L5  Idle CPU over a stated window at stall time. A stalled-but-spinning Host
      and a stalled-and-blocked Host have different causes.
  L6  Request-side evidence, if and only if the operator is authorized to
      collect it. This tool never collects it; record that it was absent rather
      than inferring a provider problem.

  Any single line above is not a diagnosis. Report which lines were collected and
  which were not.
'@

    Write-Host ''
    Write-Line 'UNAVAILABLE NATIVE PREREQUISITES' 'Yellow'
    Write-Host @'
  N1  A real launch of the desktop application. It needs an isolated DSH_HOME
      under port\.scratch\, a port above 3084, and the lead's approval. This tool
      refuses to start an application tree.
  N2  A "first usable UI" predicate for -StartupMs: an observed launch plus an
      input that responds. Not obtainable from this process.
  N3  Peaks, allocation rates and residency per process beyond what the .NET
      process object and the performance counters expose. A profiler or ETW
      session would be needed; neither is run here.
  N4  GPU/compositor memory: it is not attributable to a process by these APIs.
      A GPU total would omit it; say so rather than implying completeness.
  N5  Cross-machine comparison: meaningless for every figure in this design.
  N6  WMI/CIM under the DSH file sandbox: `Get-CimInstance` is refused with
      HRESULT 0x80041003 on this host, so the CPU model, OS caption and total RAM
      are recorded as unavailable, and parent PIDs come from
      NtQueryInformationProcess. Pass -UseCim only where CIM is permitted.
'@

    Write-Host ''
    Write-Line 'COMMANDS' 'Green'
    Write-Host @'
  .\port\scripts\measure-desktop-tree.ps1 -Mode list
  .\port\scripts\measure-desktop-tree.ps1 -Mode collect -RootPid <pid> -Format both
  .\port\scripts\tests\process-tree-accounting.ps1
'@
}

# ---------------------------------------------------------------------------
# model
# ---------------------------------------------------------------------------

<#
  Runs one fixture snapshot through the real membership walk and the real totals
  and returns the numbers a test asserts on.

  @param Fixture - a fixture snapshot.
  @returns RootResolved, CountedPids, Roles, TotalCommitBytes, TotalWorkingSetBytes,
    Claimable, OrphanedPids, ExcludedPids, Basis.
#>
function Invoke-FixtureModel {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Fixture)

    $membership = Get-ProcessTreeMembership -Snapshot $Fixture -RootPid $Fixture.RootPid
    $totals = Measure-ProcessTreeTotals -Counted $membership.Counted
    $claim = Get-ProcessTreeClaim -Totals $totals -Membership $membership -Limits $Fixture.Limits

    $roles = @{}
    foreach ($roleRow in $totals.ByRole) { $roles[$roleRow.Role] = $roleRow.Count }

    $basis = @{}
    foreach ($row in $membership.Counted) {
        if (-not $basis.ContainsKey($row.Basis)) { $basis[$row.Basis] = 0 }
        $basis[$row.Basis] = $basis[$row.Basis] + 1
    }

    return [pscustomobject]@{
        Fixture               = $Fixture
        RootResolved          = $membership.RootResolved
        RootReason            = $membership.RootReason
        Counted               = $membership.Counted
        CountedPids           = @($membership.Counted | ForEach-Object { $_.Pid })
        OrphanedPids          = @($membership.Orphaned | ForEach-Object { $_.Pid })
        ExcludedPids          = @($membership.Excluded | ForEach-Object { $_.Pid })
        Roles                 = $roles
        Basis                 = $basis
        TotalCommitBytes      = $totals.CommitBytes
        TotalWorkingSetBytes  = $totals.WorkingSetBytes
        CommitComplete        = $totals.CommitComplete
        WorkingSetComplete    = $totals.WorkingSetComplete
        Claimable             = $claim.Claimable
        ClaimReason           = $claim.Reason
        Totals                = $totals
    }
}

function Show-Model {
    Write-Section 'Fixture model: deterministic process trees through the real accounting code'

    Write-Host @'
Every tree below is SYNTHETIC. It exercises the accounting rules this tool runs
against a live tree; it is not a measurement of the product, and no number here
may be quoted as one. Nothing below touches the operating system.
'@ -ForegroundColor Yellow

    $cases = @(
        @{ Name = 'healthy'; Factory = { New-ProcessTreeFixtureHealthy }; Expect = 'root + WebView2 browser/renderer/gpu/utility + Node Host + 1 Node tool + 1 shell tool = 8 processes' }
        @{ Name = 'siblings'; Factory = { New-ProcessTreeFixtureSiblings }; Expect = 'rooted at 2000: 3 processes; 2050/2101/2102 excluded as another instance' }
        @{ Name = 'root-exited'; Factory = { New-ProcessTreeFixtureRootExited }; Expect = 'no whole-tree number: the root is absent' }
        @{ Name = 'orphaned-tool'; Factory = { New-ProcessTreeFixtureOrphanedTool }; Expect = 'the 300 MiB orphan is reported, not counted' }
        @{ Name = 'equal-figures'; Factory = { New-ProcessTreeFixtureEqualFigures }; Expect = 'working set and private commit stay distinct figures' }
        @{ Name = 'unreadable-metrics'; Factory = { New-ProcessTreeFixtureUnreadableMetrics }; Expect = 'totals are partial, not silently complete' }
        @{ Name = 'identity-reattach'; Factory = { New-ProcessTreeFixtureIdentityReattach }; Expect = 'the re-parented browser process is counted with basis identity' }
    )

    foreach ($case in $cases) {
        $fixture = & $case.Factory
        $model = Invoke-FixtureModel -Fixture $fixture
        Write-Host ''
        Write-Host ("CASE {0}" -f $case.Name) -ForegroundColor Green
        Write-Host ("  expectation  {0}" -f $case.Expect) -ForegroundColor DarkGray
        Write-Host ("  root resolved {0}" -f $model.RootResolved)
        Write-Host ("  counted      {0} process(es): {1}" -f $model.Counted.Count, ($model.CountedPids -join ', '))
        foreach ($roleRow in $model.Totals.ByRole) {
            if ($roleRow.Count -eq 0) { continue }
            Write-Host ("    {0,-9} n={1,-2} ws={2,-12} commit={3}" -f `
                $roleRow.Role, $roleRow.Count, (Format-ByteCount $roleRow.WorkingSetBytes), (Format-ByteCount $roleRow.CommitBytes))
        }
        Write-Host ("  working set sum   {0} (sum, not unique resident pages; complete={1})" -f (Format-ByteCount $model.TotalWorkingSetBytes), $model.WorkingSetComplete)
        Write-Host ("  private committed   {0} (sums soundly; complete={1})" -f (Format-ByteCount $model.TotalCommitBytes), $model.CommitComplete)
        if ($model.OrphanedPids.Count -gt 0) {
            Write-Host ("  orphaned     {0}" -f ($model.OrphanedPids -join ', ')) -ForegroundColor Yellow
        }
        if ($model.ExcludedPids.Count -gt 0) {
            Write-Host ("  excluded     {0}" -f ($model.ExcludedPids -join ', ')) -ForegroundColor Yellow
        }
        Write-Host ("  claim        {0}" -f $model.Claimable) -ForegroundColor $(if ($model.Claimable -eq 'full') { 'Green' } else { 'Yellow' })
        Write-Host ("  reason       {0}" -f $model.ClaimReason) -ForegroundColor DarkGray
    }

    Write-Host ''
    $pair = New-ProcessTreeFixturePidReusePair
    $comparison = Compare-ProcessTreeSnapshot -Previous $pair.First -Current $pair.Second
    Write-Host 'CASE pid-reuse (two snapshots)' -ForegroundColor Green
    Write-Host ("  exited       {0}" -f (@($comparison.Exited | ForEach-Object { $_.Pid }) -join ', '))
    Write-Host ("  started      {0}" -f (@($comparison.Started | ForEach-Object { $_.Pid }) -join ', '))
    Write-Host ("  pid reused   {0}" -f (@($comparison.PidReused | ForEach-Object { $_.Pid }) -join ', ')) -ForegroundColor Yellow
    Write-Host '  expectation  pid 5010 appears as one exit AND one start, and as a reuse' -ForegroundColor DarkGray

    Write-Host ''
    Write-Host 'Evidence limit: this mode validates the accounting only. It says' -ForegroundColor DarkYellow
    Write-Host 'nothing about the port own runtime cost, and it launched nothing.' -ForegroundColor DarkYellow
}

# ---------------------------------------------------------------------------
# list
# ---------------------------------------------------------------------------

<#
  Prints what a snapshot can actually read on this host. This exists so a
  limitation is discovered by the operator before a measurement, and recorded
  with the measurement, rather than being noticed by a reviewer afterwards.
#>
function Show-List {
    Write-Section 'Snapshot capability probe (read-only)'

    $fingerprint = Get-ProcessTreeFingerprint
    Write-Host 'Machine fingerprint (attach this to every quoted number):' -ForegroundColor Yellow
    $fingerprint.PSObject.Properties | ForEach-Object {
        Write-Host ("  {0,-20} {1}" -f $_.Name, $_.Value)
    }

    Write-Host ''
    Write-Host 'Reading one snapshot...' -ForegroundColor DarkGray
    $snapshot = Get-ProcessTreeSnapshot

    Write-Host ''
    Write-Host ("processes observed   {0}" -f $snapshot.Processes.Count)
    Write-Host ("snapshot duration    {0} ms" -f $snapshot.DurationMs)
    Write-Host ("parent pids readable {0}" -f @($snapshot.Processes | Where-Object { $null -ne $_.ParentPid }).Count)
    Write-Host ("start times readable {0}" -f @($snapshot.Processes | Where-Object { $_.StartTimeReadable }).Count)
    Write-Host ("working sets read    {0}" -f @($snapshot.Processes | Where-Object { $null -ne $_.WorkingSetBytes }).Count)
    Write-Host ("private commits read {0}" -f @($snapshot.Processes | Where-Object { $null -ne $_.CommitBytes }).Count)
    Write-Host ("private ws counter   {0} mapped, {1} instance(s) unmapped" -f $snapshot.CounterMapped, $snapshot.CounterUnmapped.Count)

    Write-Host ''
    if ($snapshot.Limits.Count -eq 0) {
        Write-Host 'No collection limits were recorded on this host.' -ForegroundColor Green
    } else {
        Write-Host 'Collection limits that apply to every number this tool produces here:' -ForegroundColor Yellow
        foreach ($limit in $snapshot.Limits) { Write-Host "  - $limit" -ForegroundColor Yellow }
    }
    if ($snapshot.ReaderErrors.Count -gt 0) {
        Write-Host ''
        Write-Host 'Per-process read failures:' -ForegroundColor Yellow
        foreach ($errorText in $snapshot.ReaderErrors) { Write-Host "  - $errorText" -ForegroundColor Yellow }
    }

    Write-Host ''
    Write-Host 'Identity sample (PID / creation time / role guess from safe evidence only):' -ForegroundColor DarkGray
    $sample = $snapshot.Processes | Sort-Object -Property WorkingSetBytes -Descending | Select-Object -First 10
    foreach ($row in $sample) {
        $role = Get-ProcessRole -Row $row -RootPid 0
        Write-Host ("  {0,-8} {1,-22} {2,-10} ws={3}" -f `
            $row.Pid, $row.Name, $role, (Format-ByteCount $row.WorkingSetBytes))
    }

    Write-Host ''
    Write-Host 'Listing proves READABILITY only. It is not a measurement of any' -ForegroundColor DarkYellow
    Write-Host 'application, and -Mode collect with a real -RootPid is the only path' -ForegroundColor DarkYellow
    Write-Host 'that produces a whole-tree figure for one.' -ForegroundColor DarkYellow
}

# ---------------------------------------------------------------------------
# collect
# ---------------------------------------------------------------------------

<#
  Parses `name=value` busy markers into a hashtable.

  @param Markers - the raw strings.
  @returns A hashtable, or throws on a malformed pair.
#>
function ConvertTo-BusyMarkerTable {
    [CmdletBinding()]
    param([AllowEmptyCollection()][string[]]$Markers = @())
    $table = @{}
    foreach ($marker in $Markers) {
        $pair = $marker.Split('=', 2)
        if ($pair.Count -ne 2 -or [string]::IsNullOrWhiteSpace($pair[0])) {
            throw "-BusyMarker '$marker' is not of the form name=milliseconds"
        }
        $value = 0.0
        if (-not [double]::TryParse($pair[1], [ref]$value)) {
            throw "-BusyMarker '$marker' has a non-numeric value"
        }
        $table[$pair[0].Trim()] = $value
    }
    return $table
}

<#
  Collects one sample (or a series) and returns a result record.

  @param RootPid - the tree root.
  @param RootStartTimeTicks - optional recorded launch identity of the root.
  @param IdentityToken - optional public instance token.
  @param ExcludedRoots - roots belonging to other instances.
  @param SampleCount - how many observations.
  @param SampleIntervalMs - the interval between them.
  @returns A record with Samples, Totals (last sample), Membership (last sample),
    Markers, Fingerprint and Limits.
#>
function Invoke-Collect {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int]$RootPid,
        [Nullable[long]]$RootStartTimeTicks = $null,
        [string]$IdentityToken,
        [int[]]$ExcludedRoots = @(),
        [int]$SampleCount = 1,
        [int]$SampleIntervalMs = 0,
        [hashtable]$BusyMarkers,
        [Nullable[double]]$StartupMs = $null,
        [Nullable[double]]$IdleCpuPercent = $null
    )

    if ($SampleCount -lt 1) { throw '-SampleCount must be at least 1' }
    if ($SampleCount -gt 1 -and $SampleIntervalMs -le 0) {
        throw '-SampleIntervalMs must be positive when -SampleCount is greater than 1'
    }

    $samples = New-Object 'System.Collections.Generic.List[object]'
    $history = @{}
    $rootIdentitySource = $(if ($null -ne $RootStartTimeTicks) { 'provided' } else { 'first-sample' })
    for ($index = 1; $index -le $SampleCount; $index++) {
        if ($index -gt 1) { Start-Sleep -Milliseconds $SampleIntervalMs }

        $snapshot = Get-ProcessTreeSnapshot -RootPid $RootPid -IdentityToken $IdentityToken
        if ($index -eq 1 -and $null -eq $RootStartTimeTicks) {
            $rootRows = @($snapshot.Processes | Where-Object { [int]$_.Pid -eq $RootPid })
            if ($rootRows.Count -ne 1) { throw 'first-sample root identity is absent or ambiguous; collection refused' }
            $rootIdentity = Get-ProcessIdentityFromRow $rootRows[0]
            if ($null -eq $rootIdentity.StartTimeTicks) { throw 'first-sample root creation time is unreadable; collection refused' }
            $RootStartTimeTicks = [long]$rootIdentity.StartTimeTicks
        }
        $membership = Get-ProcessTreeSeriesMembership -Snapshot $snapshot -RootPid $RootPid `
            -RootStartTimeTicks $RootStartTimeTicks -ExcludedRoots $ExcludedRoots -History $history
        $totals = Measure-ProcessTreeTotals -Counted $membership.Counted
        $claim = Get-ProcessTreeClaim -Totals $totals -Membership $membership -Limits $snapshot.Limits

        $samples.Add([pscustomobject]@{
            Index       = $index
            AtUtc       = $snapshot.StartedAtUtc.ToString('o')
            DurationMs  = $snapshot.DurationMs
            Membership  = $membership
            Totals      = $totals
            Claim       = $claim
            Limits      = $snapshot.Limits
            ReaderErrors = $snapshot.ReaderErrors
            IdentityMode = $snapshot.IdentityMode
        })
    }

    $last = $samples[$samples.Count - 1]
    $source = 'supplied-on-command-line'
    $markers = New-ResponsivenessMarkers -StartupMs $StartupMs -IdleCpuPercent $IdleCpuPercent `
        -BusyMarkers $BusyMarkers -Source $source

    return [pscustomobject]@{
        Tool          = 'measure-desktop-tree.ps1'
        ToolVersion   = '1.1'
        RootIdentitySource = $rootIdentitySource
        RunClaim      = Get-ProcessTreeRunClaim -Samples $samples.ToArray()
        Mode          = 'collect'
        RootPid       = $RootPid
        RootStartTimeUtc = $(if ($null -ne $RootStartTimeTicks) { ([datetime]::new([long]$RootStartTimeTicks, [System.DateTimeKind]::Utc)).ToString('o') } else { $null })
        IdentityTokenSupplied = [bool]$IdentityToken
        ExcludedRootPids = $ExcludedRoots
        SampleCount   = $SampleCount
        SampleIntervalMs = $SampleIntervalMs
        Fingerprint   = Get-ProcessTreeFingerprint
        Markers       = $markers
        Samples       = $samples.ToArray()
        FinalMembership = $last.Membership
        FinalTotals   = $last.Totals
        FinalClaim    = $last.Claim
        Limits        = @($samples.ToArray() | ForEach-Object { $_.Limits } | Sort-Object -Unique)
    }
}

<#
  Prints one collect result plus the verbatim claim and limits.
#>
function Show-CollectResult($Result) {
    Write-Section 'Whole process tree - per-role breakdown'

    Write-Host ("root pid              {0}" -f $Result.RootPid)
    if ($Result.RootStartTimeUtc) { Write-Host ("root start time       {0}" -f $Result.RootStartTimeUtc) }
    Write-Host ("identity token        {0}" -f $(if ($Result.IdentityTokenSupplied) { 'supplied' } else { 'not supplied (identity reattachment unavailable)' }))
    Write-Host ("excluded roots        {0}" -f $(if ($Result.ExcludedRootPids.Count -eq 0) { 'none' } else { $Result.ExcludedRootPids -join ', ' }))
    Write-Host ("samples               {0} (interval {1} ms)" -f $Result.SampleCount, $Result.SampleIntervalMs)
    Write-Host ("final sample duration {0} ms" -f $Result.Samples[$Result.Samples.Count - 1].DurationMs)

    Write-Host ''
    Write-Host ('{0,-10} {1,5} {2,14} {3,14} {4,14}' -f 'role', 'count', 'working set', 'private commit', 'private ws') -ForegroundColor Yellow
    Write-Host ('-' * 62) -ForegroundColor DarkGray
    foreach ($roleRow in $Result.FinalTotals.ByRole) {
        Write-Host ('{0,-10} {1,5} {2,14} {3,14} {4,14}' -f `
            $roleRow.Role, $roleRow.Count, (Format-ByteCount $roleRow.WorkingSetBytes), `
            (Format-ByteCount $roleRow.CommitBytes), (Format-ByteCount $roleRow.PrivateWorkingSetBytes))
    }
    Write-Host ('-' * 62) -ForegroundColor DarkGray
    Write-Host ('{0,-10} {1,5} {2,14} {3,14} {4,14}' -f `
        'TOTAL', $Result.FinalTotals.ProcessCount, (Format-ByteCount $Result.FinalTotals.WorkingSetBytes), `
        (Format-ByteCount $Result.FinalTotals.CommitBytes), (Format-ByteCount $Result.FinalTotals.PrivateWorkingSetBytes))

    Write-Host ''
    Write-Host 'Working-set SUM is not unique resident memory: shared pages count per' -ForegroundColor Yellow
    Write-Host 'holding process, and a WebView2 browser process shares a great deal with' -ForegroundColor Yellow
    Write-Host 'its renderers. Private committed bytes are charged to one process only' -ForegroundColor Yellow
    Write-Host 'and sum soundly. Quote which one you mean. GPU/compositor memory is not' -ForegroundColor Yellow
    Write-Host 'attributable to a process through these APIs and is NOT in either figure.' -ForegroundColor Yellow

    Write-Host ''
    Write-Host 'Processes counted:' -ForegroundColor DarkGray
    foreach ($row in $Result.FinalMembership.Counted) {
        Write-Host ("  {0,-8} {1,-22} {2,-10} depth={3} basis={4} commit={5}" -f `
            $row.Pid, $row.Name, $row.Role, $row.Depth, $row.Basis, (Format-ByteCount $row.CommitBytes))
    }

    if (@($Result.FinalMembership.Excluded).Count -gt 0) {
        Write-Host ''
        Write-Host 'Excluded (another application instance):' -ForegroundColor Yellow
        foreach ($row in $Result.FinalMembership.Excluded) {
            Write-Host ("  {0,-8} {1,-22} {2}" -f $row.Pid, $row.Name, $row.Reason) -ForegroundColor Yellow
        }
    }
    if (@($Result.FinalMembership.Orphaned).Count -gt 0) {
        Write-Host ''
        Write-Host 'Orphaned (parent absent, identity token did not match):' -ForegroundColor Yellow
        foreach ($row in $Result.FinalMembership.Orphaned) {
            Write-Host ("  {0,-8} {1,-22} parent={2} {3}" -f $row.Pid, $row.Name, $row.ParentPid, $row.Reason) -ForegroundColor Yellow
        }
    }

    Write-Host ''
    Write-Host 'Responsiveness markers:' -ForegroundColor DarkGray
    foreach ($marker in $Result.Markers.Markers) {
        $rendered = if ($null -eq $marker.Value) { 'not-measured' } else { "$($marker.Value) $($marker.Unit)" }
        Write-Host ("  {0,-22} {1,-16} {2}" -f $marker.Marker, $rendered, $marker.Note)
    }

    Write-Host ''
    Write-Host 'Claim:' -ForegroundColor $(if ($Result.RunClaim.Claimable -eq 'full') { 'Green' } else { 'Yellow' })
    Write-Host ("  {0}" -f $Result.RunClaim.Reason) -ForegroundColor $(if ($Result.RunClaim.Claimable -eq 'full') { 'Green' } else { 'Yellow' })

    if ($Result.Limits.Count -gt 0) {
        Write-Host ''
        Write-Host 'Collection limits recorded with this result:' -ForegroundColor Yellow
        foreach ($limit in $Result.Limits) { Write-Host "  - $limit" -ForegroundColor Yellow }
    }
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

switch ($Mode) {
    'plan' {
        Write-Host 'DeepSeek Harness desktop port - whole process tree measurement' -ForegroundColor Cyan
        Write-Host 'This mode measures nothing and touches nothing.' -ForegroundColor Gray
        Show-Plan
    }
    'model' { Show-Model }
    'list' { Show-List }
    'collect' {
        if ($RootPid -le 0) {
            throw '-Mode collect requires -RootPid. There is no default root: it would be another application tree.'
        }

        $rootStartTicks = $null
        if ($RootStartTimeUtc) {
            $parsed = [datetime]::MinValue
            if (-not [datetime]::TryParse($RootStartTimeUtc, [ref]$parsed)) {
                throw "-RootStartTimeUtc '$RootStartTimeUtc' is not a parseable timestamp"
            }
            $rootStartTicks = [long]$parsed.ToUniversalTime().Ticks
        }

        $busy = ConvertTo-BusyMarkerTable -Markers $BusyMarker

        $startup = $null
        if ($StartupMs -ge 0) { $startup = [double]$StartupMs }
        $idleCpu = $null
        if ($IdleCpuPercent -ge 0) { $idleCpu = [double]$IdleCpuPercent }

        $result = Invoke-Collect -RootPid $RootPid -RootStartTimeTicks $rootStartTicks `
            -IdentityToken $IdentityToken -ExcludedRoots $ExcludeRootPid `
            -SampleCount $SampleCount -SampleIntervalMs $SampleIntervalMs `
            -BusyMarkers $busy -StartupMs $startup -IdleCpuPercent $idleCpu

        if ($Format -eq 'console' -or $Format -eq 'both') { Show-CollectResult $result }

        if ($Format -eq 'json' -or $Format -eq 'both') {
            New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
            $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
            $path = Join-Path $OutputDir "desktop-tree-$RootPid-$stamp.json"
            # Depth 12 keeps the per-process breakdown; the default depth of 2
            # would silently truncate it and produce an unauditable file.
            $result | ConvertTo-Json -Depth 12 | Set-Content -Path $path -Encoding utf8
            Write-Host ''
            Write-Host "Result written to $path" -ForegroundColor DarkGray
        }

        $unresolved = @($result.Samples | Where-Object { -not $_.Membership.RootResolved })
        if ($unresolved.Count -gt 0) {
            Write-Host ''
            Write-Host 'RESULT: no whole-tree figure is claimable for this run.' -ForegroundColor Red
            foreach ($sample in $unresolved) { Write-Host "  sample $($sample.Index): $($sample.Membership.RootReason)" -ForegroundColor Red }
            exit 1
        }
        if ($result.RunClaim.Claimable -ne 'full') {
            Write-Host ''
            Write-Host 'RESULT: PARTIAL observations - quote each metric and its gaps; no complete application-footprint claim is permitted.' -ForegroundColor Yellow
            exit 0
        }
        Write-Host ''
        Write-Host 'RESULT: complete observed live snapshots under the recorded limits; periodic sampling can miss short-lived processes.' -ForegroundColor Green
        exit 0
    }
}
