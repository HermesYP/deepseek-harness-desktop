<#
.SYNOPSIS
  Whole-process-tree snapshots and memory accounting for the Rust/Tauri desktop
  port.

.DESCRIPTION
  `docs/implementation-plan.md` Milestone 6 requires "whole process tree private
  memory (Rust shell + WebView2 + Node + tool children)", and the definition of
  done requires that "performance/memory claims use complete process-tree
  measurements". This module is the accounting layer those two sentences need.

  THE PROBLEM IT SOLVES. A shell-only number, or a number produced by
  `Get-Process -Name dsh-desktop` plus one guessed child, is not the
  application's memory. The real tree fans out in ways that are invisible from
  the parent chain:

    * the Rust shell (`dsh-desktop.exe`) is the root;
    * WebView2 runs a separate `msedgewebview2.exe` browser process. For the
      main window it is normally a descendant of the shell (Edge creates it
      in-process), but under process reuse it can attach to an already-running
      WebView2 browser process whose parent is a DIFFERENT application;
    * guest child webviews are created with their own WebView2 data directory
      (`port/src-tauri/app/src/guests/partition.rs`), and each data directory
      implies a separate WebView2 ENVIRONMENT, so a guest browser process is
      NOT necessarily a descendant of the shell's browser process;
    * the Node Host (`node.exe` running the adapter) is a direct child, and it
      spawns tool children, subagents and background jobs of its own.

  Therefore membership is decided by a HYBRID predicate, in this order:

    1. lineage    - the process descends from the root with every link present
                    in the same snapshot;
    2. identity   - the process carries an instance token the caller supplied;
    3. exclusion  - a live process belonging to another application instance is
                    reported as excluded rather than silently counted or
                    silently dropped.

  IDENTITY, NOT PID. On Windows a PID is a reusable slot. Every attribution is
  keyed on the pair `(PID, start time)`. A PID observed at snapshot N and again
  at snapshot N+1 is the same process only when the creation time matches
  exactly; otherwise the first exited and a different process took the slot.
  PIDs alone are never compared.

  HONEST LIMITS. Every limit below is reported in the snapshot's `Limits`
  collection rather than left for the reader to infer:

    * shared pages. The sum of the working sets of N processes double-counts
      every page mapped in more than one of them: a browser process's working
      set already contains much of what its renderer has resident.
      `WorkingSetBytes` is a SUM, not unique resident pages. Complete readings
      can bound only observed resident union, never an incomplete footprint.
    * private committed bytes. `CommitBytes` (`PrivateMemorySize64`) is charged
      to one process only, so it sums without that double-count. "Private
      memory" in this repository means THIS figure, never the working set.
    * private working set. `PrivateWorkingSetBytes` comes from the
      performance counters, paired by full instance in the same sample and
      mapped through `ID Process`, never process-name order. Duplicate PID
      instances and counters older than the current creation identity are
      refused; missing values stay null.
    * parent PIDs and creation times. CIM observations must match the .NET
      creation identity at CIM's microsecond precision. The native fallback
      compares GetProcessTimes and NtQueryInformationProcess on the SAME handle
      against the exact .NET creation ticks. Refused/stale edges stay unknown.
    * command lines. This module never reads `Win32_Process.CommandLine` and
      never returns one. The lane that owns it forbids collecting command lines,
      environment blocks, URLs, credentials and request contents. The single
      exception is a caller-supplied PUBLIC identity token, given to
      `-IdentityToken`; the token is matched, never harvested.
    * exited parents. Previously observed exact identities may be retained by
      the series collector; new off-tree strangers cannot prove membership.
      They are reported as unattributed, not silently attached or discarded.
    * sampling. A snapshot is one observation. Processes that start and exit
      between observations are invisible; a total is only meaningful next to the
      sample count and the interval that produced it.

.NOTES
  Windows PowerShell 5.1 and PowerShell 7 compatible. Pure ASCII. Reads process
  metadata only; starts, stops and modifies nothing.

  IMPLEMENTATION NOTE. `[pscustomobject]` resolves as a RUNSPACE TYPE and is NOT
  available inside a script module on Windows PowerShell 5.1. Using it there does
  not fail loudly: the cast fails while the object is being built and the
  enclosing pipeline swallows the error, so the function returns nothing and a
  caller sees zero processes. Every object literal in this module therefore uses
  `New-Object PSObject -Property`, which is the same object without that trap.
#>

Set-StrictMode -Version Latest

$script:Seed32 = [uint32]2654435761
$script:Seed64 = [uint64]1469598103934665603
$script:Prime64 = [uint64]1099511628211

<#
  Builds an object with the given properties. See the implementation note above:
  this exists because `[pscustomobject]` is unusable from module scope under
  Windows PowerShell 5.1.

  @param Properties - the properties to attach.
  @returns The constructed object.
#>
function New-Row {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Properties)
    return New-Object PSObject -Property $Properties
}

<#
  Deterministic 32-bit PRNG (Numerical Recipes LCG). Fixture generation must be
  reproducible across runs and machines, so `Get-Random` is never used.
#>
function Get-DeterministicUInt32 {
    [CmdletBinding()]
    [OutputType([uint32])]
    param()
    $script:Seed32 = [uint32]((([uint64]$script:Seed32 * 1664525) + 1013904223) -band 0xFFFFFFFF)
    return $script:Seed32
}

<#
  Reseeds the deterministic generator so two generations in one session match.
#>
function Reset-DeterministicSeed {
    [CmdletBinding()]
    param()
    $script:Seed32 = [uint32]2654435761
}

<#
  64-bit FNV-1a over a string's UTF-16 code units. Not a security hash; it
  exists so a value can be identified in a log without a heavy dependency.
#>
function Get-StableHash64 {
    [CmdletBinding()]
    [OutputType([uint64])]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $hash = $script:Seed64
    foreach ($ch in $Text.ToCharArray()) {
        $hash = [uint64]($hash -bxor [uint64][int]$ch)
        $hash = [uint64](($hash * $script:Prime64) -band 0xFFFFFFFFFFFFFFFF)
    }
    return $hash
}

# ---------------------------------------------------------------------------
# Native reader
# ---------------------------------------------------------------------------

$script:NativeReaderAvailable = $false
$script:NativeReaderError = $null
$script:NativeReaderType = $null

<#
  Compiles the P/Invoke entry point the snapshot needs for parent PIDs.
  `Win32_Process` is denied under the sandbox, so the parent link comes from
  `NtQueryInformationProcess`, which needs only
  `PROCESS_QUERY_LIMITED_INFORMATION`. The type is compiled once per session; a
  failure is recorded rather than thrown, so a caller can distinguish "no native
  reader" from "no processes".

  @returns `$true` when the reader is available.
#>
function Initialize-ProcessTreeNativeReader {
    [CmdletBinding()]
    [OutputType([bool])]
    param()

    if ($script:NativeReaderType) { return $true }

    $source = @'
using System;
using System.Runtime.InteropServices;

public static class DshProcessTreeNative
{
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr handle, int infoClass,
        ref PROCESS_BASIC_INFORMATION info, int infoLength, out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int desiredAccess, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr handle, out long creation,
        out long exit, out long kernel, out long user);

    /// <summary>Parent id for the exact creation identity, or -1.</summary>
    public static int ParentProcessId(int processId, long expectedCreationTicks)
    {
        const int PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (handle == IntPtr.Zero)
        {
            return -1;
        }
        try
        {
            long creation, exit, kernel, user;
            if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)
                || DateTime.FromFileTimeUtc(creation).Ticks != expectedCreationTicks)
            {
                return -1;
            }
            PROCESS_BASIC_INFORMATION info = new PROCESS_BASIC_INFORMATION();
            int returnLength;
            int status = NtQueryInformationProcess(handle, 0, ref info,
                Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out returnLength);
            if (status != 0)
            {
                return -1;
            }
            return info.InheritedFromUniqueProcessId.ToInt32();
        }
        finally
        {
            CloseHandle(handle);
        }
    }
}
'@

    try {
        Add-Type -TypeDefinition $source -ErrorAction Stop | Out-Null
        $script:NativeReaderType = [DshProcessTreeNative]
        $script:NativeReaderAvailable = $true
        $script:NativeReaderError = $null
        return $true
    } catch {
        $script:NativeReaderAvailable = $false
        $script:NativeReaderType = $null
        $script:NativeReaderError = $_.Exception.Message
        return $false
    }
}

<#
  Whether the native parent-PID reader is available in this session.
#>
function Test-ProcessTreeNativeReader {
    [CmdletBinding()]
    [OutputType([bool])]
    param()
    if (-not $script:NativeReaderType) { Initialize-ProcessTreeNativeReader | Out-Null }
    return $script:NativeReaderAvailable
}

<#
  Why the native reader is unavailable, or `$null` when it works.
#>
function Get-ProcessTreeNativeReaderError {
    [CmdletBinding()]
    [OutputType([string])]
    param()
    if (-not $script:NativeReaderType) { Initialize-ProcessTreeNativeReader | Out-Null }
    return $script:NativeReaderError
}

# Pair counters from the SAME sample by full instance name, then key by ID
# Process. Same-name processes must never receive sorted/ordinal memory values.
function ConvertTo-PrivateWorkingSetCounterMap {
    param([AllowEmptyCollection()][object[]]$CounterSamples)
    $ids = @{}; $values = @{}; $map = @{}; $ambiguous = @{}
    foreach ($sample in $CounterSamples) {
        $instance = [string]$sample.InstanceName
        if ([string]::IsNullOrWhiteSpace($instance)) { continue }
        try {
            if ($sample.Path -match '\\id process$') { $ids[$instance] = [int]$sample.CookedValue }
            elseif ($sample.Path -match '\\working set - private$') {
                $values[$instance] = New-Row @{ Bytes = [long]$sample.CookedValue; SampledAtUtc = $sample.Timestamp.ToUniversalTime() }
            }
        } catch { continue }
    }
    foreach ($instance in $ids.Keys) {
        $processId = [int]$ids[$instance]
        if ($processId -le 0 -or -not $values.ContainsKey($instance) -or $values[$instance].Bytes -lt 0) { continue }
        if ($map.ContainsKey($processId)) { $ambiguous[$processId] = $true }
        $map[$processId] = $values[$instance]
    }
    foreach ($processId in $ambiguous.Keys) { $map.Remove($processId) }
    return $map
}

function Get-PrivateWorkingSetCounterMap {
    [CmdletBinding()]
    param()
    try {
        $sample = Get-Counter -Counter @('\Process(*)\ID Process', '\Process(*)\Working Set - Private') -ErrorAction Stop
        return ConvertTo-PrivateWorkingSetCounterMap -CounterSamples $sample.CounterSamples
    } catch { return @{} }
}

<#
  Takes one whole-process snapshot.

  @param RootPid - optional root to record on the snapshot. Membership is
    decided later, by `Get-ProcessTreeMembership`.
  @param IdentityToken - optional PUBLIC instance token. Matching requires
    `-CommandLineProvider`; without one, identity matching reports itself
    unavailable instead of this module reading command lines on its own.
  @param CommandLineProvider - optional callback invoked as `& $Provider $treeProcessId`
    returning a command line or `$null`. It exists because reading command lines
    is a deliberate, caller-owned decision.
  @param UseCim - opt-in `Get-CimInstance Win32_Process` for parent PIDs. Denied
    under the DSH file sandbox on this host, so it is off by default and its
    failure is recorded in `ReaderErrors`.
  @returns A snapshot: RootPid, StartedAtUtc, DurationMs, Processes, Limits,
    ReaderErrors, CounterMapped, CounterUnmapped, NativeReader, IdentityMode.
#>
function Get-ProcessTreeSnapshot {
    [CmdletBinding()]
    param(
        [int]$RootPid = 0,
        [string]$IdentityToken,
        [scriptblock]$CommandLineProvider,
        [switch]$UseCim
    )

    $startedAt = Get-Date
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $limits = New-Object 'System.Collections.Generic.List[string]'
    $readerErrors = New-Object 'System.Collections.Generic.List[string]'

    $nativeAvailable = Initialize-ProcessTreeNativeReader
    if (-not $nativeAvailable) {
        $limits.Add("parent PIDs unavailable: the native reader could not be compiled ($script:NativeReaderError)")
    }

    # Live .NET process objects are held so the handle is reused for the metrics.
    # A process that exits mid-enumeration is skipped, not counted as zero.
    $live = @{}
    foreach ($dotnetProcess in [System.Diagnostics.Process]::GetProcesses()) {
        try {
            $live[[int]$dotnetProcess.Id] = $dotnetProcess
        } catch {
            # A disposed or refused handle: the process is simply unobservable.
            continue
        }
    }

    $parentByPid = @{}
    if ($UseCim) {
        try {
            foreach ($row in @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)) {
                $creationTicks = $null
                try { if ($null -ne $row.CreationDate) { $creationTicks = ([datetime]$row.CreationDate).ToUniversalTime().Ticks } } catch { }
                $parentByPid[[int]$row.ProcessId] = New-Row @{ ParentPid = [int]$row.ParentProcessId; CreationTicks = $creationTicks }
            }
        } catch {
            $readerErrors.Add("Win32_Process (CIM) refused: $($_.Exception.Message)")
        }
    }

    $counterMap = Get-PrivateWorkingSetCounterMap
    $counterUsedPids = @{}

    $identityResolved = $false
    if ($IdentityToken) {
        if ($CommandLineProvider) {
            $identityResolved = $true
        } else {
            $limits.Add('identity token supplied but no command-line provider: identity matching not attempted (this module never reads command lines on its own)')
        }
    }

    $processes = New-Object 'System.Collections.Generic.List[object]'
    foreach ($processId in ($live.Keys | Sort-Object)) {
        $dotnetProcess = $live[$processId]
        $startTimeUtc = $null
        $startTimeReadable = $true
        try {
            $startTimeUtc = $dotnetProcess.StartTime.ToUniversalTime()
        } catch {
            $startTimeReadable = $false
        }

        $workingSet = $null; $commit = $null; $paged = $null
        $cpuSeconds = $null; $handleCount = $null; $threadCount = $null
        try {
            # Refreshed explicitly: values cached on an object obtained before the
            # process changed state are stale.
            $dotnetProcess.Refresh()
            $workingSet = [long]$dotnetProcess.WorkingSet64
            $commit = [long]$dotnetProcess.PrivateMemorySize64
            $paged = [long]$dotnetProcess.PagedMemorySize64
            $cpuSeconds = [double]$dotnetProcess.TotalProcessorTime.TotalSeconds
            $handleCount = [int]$dotnetProcess.HandleCount
            $threadCount = [int]$dotnetProcess.Threads.Count
            if ($dotnetProcess.HasExited) { throw 'process exited while metrics were being sampled' }
        } catch {
            $workingSet = $null; $commit = $null; $paged = $null
            $cpuSeconds = $null; $handleCount = $null; $threadCount = $null
            $readerErrors.Add("metrics refused for pid ${processId}: $($_.Exception.Message)")
        }

        $name = '<unknown>'
        try { $name = [string]$dotnetProcess.ProcessName } catch { }

        $privateWorkingSet = $null
        if ($counterMap.ContainsKey([int]$processId) -and $null -ne $startTimeUtc) {
            $counter = $counterMap[[int]$processId]
            # Reject a counter from before this PID's current creation time.
            if ($counter.SampledAtUtc -ge $startTimeUtc) {
                $privateWorkingSet = [long]$counter.Bytes
                $counterUsedPids[[int]$processId] = $true
            }
        }

        $parent = $null
        if ($parentByPid.ContainsKey($processId) -and $null -ne $startTimeUtc) {
            $observation = $parentByPid[$processId]
            if (Test-ProcessCreationObservation -ExpectedTicks $startTimeUtc.Ticks -ObservedTicks $observation.CreationTicks) {
                $parent = [int]$observation.ParentPid
            }
        }
        if ($null -eq $parent -and $nativeAvailable -and $null -ne $startTimeUtc) {
            try {
                $nativeParent = [DshProcessTreeNative]::ParentProcessId($processId, $startTimeUtc.Ticks)
                if ($nativeParent -ge 0) { $parent = $nativeParent }
            } catch { }
        }
        if ($null -eq $parent -and $processId -ne 0) {
            $limits.Add("parent observation for pid $processId could not be tied to its creation identity")
        }

        $identityMatch = $null
        if ($identityResolved) {
            $identityMatch = $false
            if ($processId -eq $RootPid) {
                $identityMatch = $true
            } else {
                $commandLine = $null
                try { $commandLine = & $CommandLineProvider $processId } catch { $commandLine = $null }
                if ($commandLine -and $commandLine.Contains($IdentityToken)) { $identityMatch = $true }
            }
        }

        $processes.Add((New-Row @{
            Pid                    = $processId
            ParentPid              = $parent
            Name                   = $name
            StartTimeUtc           = $startTimeUtc
            StartTimeReadable      = $startTimeReadable
            WorkingSetBytes        = $workingSet
            CommitBytes            = $commit
            PagedBytes             = $paged
            PrivateWorkingSetBytes = $privateWorkingSet
            CpuSeconds             = $cpuSeconds
            HandleCount            = $handleCount
            ThreadCount            = $threadCount
            IdentityMatched        = $identityMatch
            # A process whose metrics could not be read cannot be identity
            # compared either, and its figures must not be summed as zero.
            MetricsReadable        = ($null -ne $workingSet)
        }))
    }

    foreach ($processObject in $live.Values) { $processObject.Dispose() }
    $stopwatch.Stop()

    $counterUnmapped = New-Object 'System.Collections.Generic.List[string]'
    foreach ($processId in $counterMap.Keys) {
        if (-not $counterUsedPids.ContainsKey([int]$processId)) {
            $counterUnmapped.Add("pid $processId (no matching creation-verified process)")
        }
    }
    if ($counterUnmapped.Count -gt 0) {
        $limits.Add("private working set unmapped for: $($counterUnmapped -join ', ')")
    }
    if (@($processes | Where-Object { $null -eq $_.PrivateWorkingSetBytes }).Count -gt 0) {
        $limits.Add('private working set is null for at least one process: the performance counter is unavailable, mismatched or refused')
    }
    $restricted = @($processes | Where-Object { -not $_.StartTimeReadable })
    if ($restricted.Count -gt 0) {
        $limits.Add("start time refused for $($restricted.Count) process(es): identity is (pid, start time) and those processes cannot be identity-compared")
    }

    return New-Row @{
        RootPid         = $RootPid
        StartedAtUtc    = $startedAt.ToUniversalTime()
        DurationMs      = [math]::Round($stopwatch.Elapsed.TotalMilliseconds, 3)
        Processes       = $processes.ToArray()
        Limits          = $limits.ToArray()
        ReaderErrors    = $readerErrors.ToArray()
        CounterMapped   = @($processes | Where-Object { $null -ne $_.PrivateWorkingSetBytes }).Count
        CounterUnmapped = $counterUnmapped.ToArray()
        NativeReader    = $nativeAvailable
        IdentityMode    = $(if ($identityResolved) { 'available' } else { 'unavailable' })
    }
}

# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------

<#
  The identity of one process observation: `(PID, start time)`.

  @param Pid - the process id.
  @param StartTimeTicks - the creation time in ticks, when readable.
  @param Name - the executable base name, for readable diagnostics only; it is
    deliberately NOT part of the comparison.
  @returns An identity object.
#>
function New-ProcessIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][Alias('Pid')][int]$MeasuredPid,
        [Nullable[long]]$StartTimeTicks = $null,
        [string]$Name = ''
    )
    return New-Row @{
        Pid            = $MeasuredPid
        StartTimeTicks = $StartTimeTicks
        Name           = $Name
    }
}

<#
  Identity of a snapshot row.

  @param Row - a snapshot row.
  @returns `(PID, start time ticks)`, with a null start time when unreadable.
#>
function Get-ProcessIdentityFromRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Row)
    $ticks = $null
    if ($Row.StartTimeUtc -and $Row.StartTimeReadable) {
        $ticks = [long]([datetime]$Row.StartTimeUtc).Ticks
    }
    return New-ProcessIdentity -Pid ([int]$Row.Pid) -StartTimeTicks $ticks -Name ([string]$Row.Name)
}

<#
  Whether two identities denote the same process.

  A missing start time on either side makes the pair NOT the same process. That
  is the safe direction: a PID reuse is then reported as an exit plus a start
  instead of being mistaken for one process that never exited.

  @param Left - one identity.
  @param Right - the other identity.
  @returns `$true` only for an exact `(PID, start time)` match.
#>
function Test-ProcessIdentityEqual {
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]$Left,
        [Parameter(Mandatory)]$Right
    )
    if ([int]$Left.Pid -ne [int]$Right.Pid) { return $false }
    if ($null -eq $Left.StartTimeTicks -or $null -eq $Right.StartTimeTicks) { return $false }
    return ([long]$Left.StartTimeTicks -eq [long]$Right.StartTimeTicks)
}

<#
  A stable, sortable key for an identity, used to compare two snapshots.
#>
function Get-ProcessIdentityKey {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)]$Identity)
    if ($null -eq $Identity.StartTimeTicks) { return "$([int]$Identity.Pid)/?" }
    return "$([int]$Identity.Pid)/$([long]$Identity.StartTimeTicks)"
}

<#
  Diffs two snapshots by identity.

  @param Previous - the earlier snapshot.
  @param Current - the later snapshot.
  @returns Exited, Started and PidReused. PidReused is the observable proof that
    a PID slot changed owner, and it is reported separately so a monitor never
    counts a reused slot as a live descendant.
#>
function Compare-ProcessTreeSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Previous,
        [Parameter(Mandatory)]$Current
    )

    $previousByKey = @{}
    foreach ($row in $Previous.Processes) {
        $previousByKey[(Get-ProcessIdentityKey (Get-ProcessIdentityFromRow $row))] = $row
    }
    $currentByKey = @{}
    foreach ($row in $Current.Processes) {
        $currentByKey[(Get-ProcessIdentityKey (Get-ProcessIdentityFromRow $row))] = $row
    }

    $exited = New-Object 'System.Collections.Generic.List[object]'
    foreach ($key in $previousByKey.Keys) {
        if (-not $currentByKey.ContainsKey($key)) { $exited.Add($previousByKey[$key]) }
    }
    $started = New-Object 'System.Collections.Generic.List[object]'
    foreach ($key in $currentByKey.Keys) {
        if (-not $previousByKey.ContainsKey($key)) { $started.Add($currentByKey[$key]) }
    }

    $previousPidToKey = @{}
    foreach ($key in $previousByKey.Keys) {
        $previousPidToKey[[string]([int]$previousByKey[$key].Pid)] = $key
    }
    $reused = New-Object 'System.Collections.Generic.List[object]'
    foreach ($key in $currentByKey.Keys) {
        $treeProcessIdKey = [string]([int]$currentByKey[$key].Pid)
        if (-not $previousPidToKey.ContainsKey($treeProcessIdKey)) { continue }
        if ($previousPidToKey[$treeProcessIdKey] -ne $key) {
            $reused.Add((New-Row @{
                Pid      = [int]$currentByKey[$key].Pid
                Previous = $previousByKey[$previousPidToKey[$treeProcessIdKey]]
                Current  = $currentByKey[$key]
            }))
        }
    }

    return New-Row @{
        Exited    = $exited.ToArray()
        Started   = $started.ToArray()
        PidReused = $reused.ToArray()
    }
}

# ---------------------------------------------------------------------------
# Roles
# ---------------------------------------------------------------------------

<#
  The process families this qualification counts, per milestone 6.

  @returns The role names, in reporting order.
#>
function Get-ProcessRoleTable {
    [CmdletBinding()]
    param()
    return @('Root', 'WebView2', 'NodeHost', 'Tool', 'Unknown')
}

<#
  Classifies one process row from evidence that is safe to read: an explicit
  `Role` the caller or a fixture already knows, the executable name, and the
  image path when a provider reports it. Command lines are never read.

  @param Row - a process row (`Name`, optional `ImagePath`, optional `Role`).
    A row carrying its own `Role` wins, which is how the deterministic fixtures
    express a topology without any command-line inference.
  @param RootPid - the tree root, which is always `Root` (`0` to disable).
  @param CommandLineHint - an optional caller-supplied classification hint, e.g.
    an image path the caller already knows.
  @returns One of Root, WebView2, NodeHost, Tool, Unknown.
#>
function Get-ProcessRole {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]$Row,
        [int]$RootPid = 0,
        [string]$CommandLineHint
    )

    if ($Row.PSObject.Properties.Name -contains 'Role' -and -not [string]::IsNullOrWhiteSpace([string]$Row.Role)) {
        return [string]$Row.Role
    }
    if ($RootPid -ne 0 -and [int]$Row.Pid -eq $RootPid) { return 'Root' }

    $name = ([string]$Row.Name).ToLowerInvariant()
    $hint = ''
    if ($Row.PSObject.Properties.Name -contains 'ImagePath' -and $Row.ImagePath) {
        $hint = ([string]$Row.ImagePath).ToLowerInvariant()
    }
    if ($CommandLineHint) { $hint = "$hint $($CommandLineHint.ToLowerInvariant())" }

    if ($name -eq 'msedgewebview2' -or $name -eq 'msedgewebview2.exe') { return 'WebView2' }
    if ($name -eq 'node' -or $name -eq 'node.exe') { return 'NodeHost' }
    if ($hint -match 'msedgewebview2') { return 'WebView2' }
    if ($hint -match 'node\.exe') { return 'NodeHost' }
    return 'Unknown'
}

<#
  Separates the Node Host from Node tool children.

  Node is deliberately ambiguous: the Host itself is Node, and so are tool,
  subagent and workflow children. This module never guesses from a command line,
  so the distinction is lineage - a direct child of the Host is a tool child, and
  anything deeper is a tool descendant too. A row carrying its own `Role` (a
  fixture model) has already short-circuited this function in
  `Get-ProcessRole`.

  @param Role - the role from `Get-ProcessRole`.
  @param Depth - the process's depth in the tree.
  @param HostPid - the pid identified as the Node Host, or 0.
  @param Pid - this process.
  @param ParentPid - this process's parent.
  @returns NodeHost or Tool.
#>
function Resolve-AmbiguousRole {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][string]$Role,
        [int]$Depth = 0,
        [int]$HostPid = 0,
        [Alias('Pid')][int]$MeasuredPid = 0,
        [int]$ParentPid = 0
    )
    if ($Role -ne 'NodeHost') { return $Role }
    if ($HostPid -ne 0 -and $MeasuredPid -eq $HostPid) { return 'NodeHost' }
    if ($HostPid -ne 0 -and $ParentPid -eq $HostPid) { return 'Tool' }
    if ($Depth -ge 2) { return 'Tool' }
    return 'NodeHost'
}

# ---------------------------------------------------------------------------
# Tree walk
# ---------------------------------------------------------------------------

<#
  Walks the process tree rooted at `RootPid` and returns every counted process
  with its depth, role and attribution basis.

  Membership rule, in order:
    1. the root itself;
    2. a process whose ancestor chain reaches the root through processes present
       in the same snapshot - basis `lineage`;
    3. a process that matched the instance identity token - basis `identity`;
    4. a process descending from an excluded root, or whose live parent is
       outside the measured tree - excluded with a reason;
    5. anything else with an absent parent - orphaned with a reason.

  @param Snapshot - the snapshot to walk.
  @param RootPid - the root. `$null` or 0 means "not supplied" and the walk
    refuses rather than inventing a tree.
  @param RootStartTimeTicks - optional check of the root's `(PID, start time)`:
    when supplied and the live PID's start time differs, the walk refuses rather
    than walking a stranger that took the PID slot.
  @param ExcludedRoots - additional root PIDs belonging to other application
    instances; their descendants are excluded, not counted.
  @returns Counted, Excluded, Orphaned, RootResolved, RootReason.
#>
function Get-ProcessTreeMembership {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Snapshot,
        [Nullable[int]]$RootPid = $null,
        [Nullable[long]]$RootStartTimeTicks = $null,
        [int[]]$ExcludedRoots = @()
    )

    $counted = New-Object 'System.Collections.Generic.List[object]'
    $excluded = New-Object 'System.Collections.Generic.List[object]'
    $orphaned = New-Object 'System.Collections.Generic.List[object]'

    if ($null -eq $RootPid -or [int]$RootPid -le 0) {
        return New-Row @{
            Counted      = @()
            Excluded     = @()
            Orphaned     = @()
            RootResolved = $false
            RootReason   = 'no root pid supplied: a whole-tree sum cannot be produced without one'
        }
    }

    $rowsByPid = @{}
    foreach ($row in $Snapshot.Processes) { $rowsByPid[[int]$row.Pid] = $row }

    if (-not $rowsByPid.ContainsKey([int]$RootPid)) {
        return New-Row @{
            Counted      = @()
            Excluded     = @()
            Orphaned     = @()
            RootResolved = $false
            RootReason   = "root pid $RootPid is not present in this snapshot: it exited before or during the sample"
        }
    }
    $rootRow = $rowsByPid[[int]$RootPid]

    if ($null -ne $RootStartTimeTicks) {
        $rootIdentity = Get-ProcessIdentityFromRow $rootRow
        if ($null -eq $rootIdentity.StartTimeTicks -or [long]$rootIdentity.StartTimeTicks -ne [long]$RootStartTimeTicks) {
            return New-Row @{
                Counted      = @()
                Excluded     = @()
                Orphaned     = @()
                RootResolved = $false
                RootReason   = "root pid $RootPid exists but its start time does not match the recorded launch identity: the pid slot was reused"
            }
        }
    }

    $depthByPid = @{}
    $basisByPid = @{}
    $depthByPid[[int]$RootPid] = 0
    $basisByPid[[int]$RootPid] = 'root'

    # Every pid descending from an excluded root is excluded as well, and
    # recorded with a reason, so a second running instance is visible in the
    # report rather than silently absent from it.
    $excludedPidSet = @{}
    foreach ($excludedRoot in $ExcludedRoots) {
        if ([int]$excludedRoot -le 0) { continue }
        $excludedPidSet[[int]$excludedRoot] = $true
        $stack = New-Object 'System.Collections.Generic.Stack[int]'
        $stack.Push([int]$excludedRoot)
        $seen = @{}
        while ($stack.Count -gt 0) {
            $current = $stack.Pop()
            if ($seen.ContainsKey($current)) { continue }
            $excludedPidSet[$current] = $true
            $row = $null
            if ($rowsByPid.ContainsKey($current)) { $row = $rowsByPid[$current] }
            if (-not $seen.ContainsKey($current)) {
                $excluded.Add((New-Row @{
                    Pid                    = $current
                    Name                   = $(if ($row) { $row.Name } else { '<exited>' })
                    Role                   = 'Excluded'
                    Depth                  = $null
                    Basis                  = 'excluded'
                    Reason                 = 'descends from an excluded root (a distinct application instance)'
                    Identity               = $(if ($row) { Get-ProcessIdentityFromRow $row } else { $null })
                    WorkingSetBytes        = $(if ($row) { $row.WorkingSetBytes } else { $null })
                    CommitBytes            = $(if ($row) { $row.CommitBytes } else { $null })
                    PrivateWorkingSetBytes = $(if ($row) { $row.PrivateWorkingSetBytes } else { $null })
                }))
            }
            $seen[$current] = $true
            foreach ($child in $Snapshot.Processes) {
                if ($null -eq $child.ParentPid -or [int]$child.ParentPid -ne $current) { continue }
                if ($null -ne $row -and (Test-ProcessParentChronology -Parent $row -Child $child)) {
                    $stack.Push([int]$child.Pid)
                } else {
                    $Snapshot.Limits = @($Snapshot.Limits) + "unverified excluded-root parent edge $current -> $($child.Pid) (creation times absent or stale parent PID)"
                }
            }
        }
    }

    # Parent IDs alone are not evidence: an older child cannot belong to a
    # newer process that reused its parent's PID slot. Unknown times fail closed.
    # Breadth-first from the root through live parent links. A queue rather than
    # recursion: a deep tree must not depend on the PowerShell call stack.
    $queue = New-Object 'System.Collections.Generic.Queue[int]'
    $queue.Enqueue([int]$RootPid)
    $visited = @{}
    $cyclePids = New-Object 'System.Collections.Generic.List[int]'
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        if ($visited.ContainsKey($current)) {
            $cyclePids.Add($current)
            continue
        }
        $visited[$current] = $true
        foreach ($child in $Snapshot.Processes) {
            if ($null -eq $child.ParentPid) { continue }
            if ([int]$child.ParentPid -ne $current) { continue }
            $childPid = [int]$child.Pid
            if ($childPid -eq [int]$RootPid) { continue }
            if ($excludedPidSet.ContainsKey($childPid)) { continue }
            if ($depthByPid.ContainsKey($childPid)) { continue }
            if (-not (Test-ProcessParentChronology -Parent $rowsByPid[$current] -Child $child)) { continue }
            $depthByPid[$childPid] = [int]$depthByPid[$current] + 1
            $basisByPid[$childPid] = 'lineage'
            $queue.Enqueue($childPid)
        }
    }

    # Identity reattachment and orphan reporting: everything not reached by
    # lineage, classified by why.
    foreach ($row in $Snapshot.Processes) {
        $treeProcessId = [int]$row.Pid
        if ($depthByPid.ContainsKey($treeProcessId)) { continue }
        if ($excludedPidSet.ContainsKey($treeProcessId)) { continue }

        $parentPresent = $false
        if ($null -ne $row.ParentPid -and $rowsByPid.ContainsKey([int]$row.ParentPid)) { $parentPresent = $true }
        $parentInTree = $false
        if ($parentPresent -and $depthByPid.ContainsKey([int]$row.ParentPid)) { $parentInTree = $true }

        if ($row.IdentityMatched -eq $true) {
            $parentDepth = 1
            if ($parentInTree) { $parentDepth = [int]$depthByPid[[int]$row.ParentPid] + 1 }
            $depthByPid[$treeProcessId] = $parentDepth
            $basisByPid[$treeProcessId] = 'identity'
            continue
        }

        if ($parentPresent -and -not $parentInTree) {
            # The parent is alive but belongs to another instance, or was excluded.
            $excluded.Add((New-Row @{
                Pid                    = $treeProcessId
                Name                   = $row.Name
                Role                   = 'Excluded'
                Depth                  = $null
                Basis                  = 'excluded'
                Reason                 = "parent pid $($row.ParentPid) is outside the measured tree"
                Identity               = Get-ProcessIdentityFromRow $row
                WorkingSetBytes        = $row.WorkingSetBytes
                CommitBytes            = $row.CommitBytes
                PrivateWorkingSetBytes = $row.PrivateWorkingSetBytes
            }))
            continue
        }

        $orphaned.Add((New-Row @{
            Pid             = $treeProcessId
            Name            = $row.Name
            ParentPid       = $(if ($null -ne $row.ParentPid) { [int]$row.ParentPid } else { $null })
            Reason          = 'parent is not present in this snapshot (it exited before or during the sample) and the instance identity token did not match'
            Identity        = Get-ProcessIdentityFromRow $row
            StartTimeUtc    = $row.StartTimeUtc
            ParentExited    = $true
            WorkingSetBytes = $row.WorkingSetBytes
            CommitBytes     = $row.CommitBytes
        }))
    }

    if ($cyclePids.Count -gt 0) {
        # A malformed parent graph. Recorded, never silently followed.
        $Snapshot.Limits += "parent links form a cycle through pid(s) $($cyclePids -join ', '): the walk terminated"
    }

    # Expand from identity reattachments too, after all seeds are known.
    # Without this pass, their children depended on snapshot enumeration order.
    $queue.Clear()
    foreach ($seed in $depthByPid.Keys) { $queue.Enqueue([int]$seed) }
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        foreach ($child in $Snapshot.Processes) {
            if ($null -eq $child.ParentPid -or [int]$child.ParentPid -ne $current) { continue }
            $childId = [int]$child.Pid
            if ($depthByPid.ContainsKey($childId) -or $excludedPidSet.ContainsKey($childId)) { continue }
            if (-not (Test-ProcessParentChronology -Parent $rowsByPid[$current] -Child $child)) {
                $Snapshot.Limits += "unverified creation-time parent edge $current -> $childId; not attributed"
                continue
            }
            $depthByPid[$childId] = [int]$depthByPid[$current] + 1
            $basisByPid[$childId] = 'lineage'
            $queue.Enqueue($childId)
        }
    }

    # The Host is the depth-1 Node process. Every other Node process is a tool child.
    $hostPid = 0
    foreach ($treeProcessId in $depthByPid.Keys) {
        if ($depthByPid[$treeProcessId] -ne 1) { continue }
        if (-not $rowsByPid.ContainsKey($treeProcessId)) { continue }
        if ((Get-ProcessRole -Row $rowsByPid[$treeProcessId] -RootPid ([int]$RootPid)) -eq 'NodeHost') {
            $hostPid = $treeProcessId
            break
        }
    }

    foreach ($treeProcessId in $depthByPid.Keys) {
        if ($treeProcessId -eq [int]$RootPid) { continue }
        if (-not $rowsByPid.ContainsKey($treeProcessId)) { continue }
        $row = $rowsByPid[$treeProcessId]
        $role = Get-ProcessRole -Row $row -RootPid ([int]$RootPid)
        $role = Resolve-AmbiguousRole -Role $role -Depth ([int]$depthByPid[$treeProcessId]) `
            -HostPid $hostPid -Pid $treeProcessId -ParentPid ([int]$row.ParentPid)
        $counted.Add((New-Row @{
            Pid                    = $treeProcessId
            Name                   = $row.Name
            ParentPid              = $(if ($null -ne $row.ParentPid) { [int]$row.ParentPid } else { $null })
            Role                   = $role
            Depth                  = [int]$depthByPid[$treeProcessId]
            Basis                  = [string]$basisByPid[$treeProcessId]
            StartTimeUtc           = $row.StartTimeUtc
            WorkingSetBytes        = $row.WorkingSetBytes
            CommitBytes            = $row.CommitBytes
            PrivateWorkingSetBytes = $row.PrivateWorkingSetBytes
            CpuSeconds             = $row.CpuSeconds
            Identity               = Get-ProcessIdentityFromRow $row
        }))
    }

    # An unreadable root is still a member. Null metrics must degrade the sum,
    # not remove the root and accidentally make its children look complete.
    $counted.Add((New-Row @{
            Pid                    = [int]$RootPid
            Name                   = $rootRow.Name
            ParentPid              = $(if ($null -ne $rootRow.ParentPid) { [int]$rootRow.ParentPid } else { $null })
            Role                   = 'Root'
            Depth                  = 0
            Basis                  = 'root'
            StartTimeUtc           = $rootRow.StartTimeUtc
            WorkingSetBytes        = $rootRow.WorkingSetBytes
            CommitBytes            = $rootRow.CommitBytes
            PrivateWorkingSetBytes = $rootRow.PrivateWorkingSetBytes
            CpuSeconds             = $rootRow.CpuSeconds
            Identity               = Get-ProcessIdentityFromRow $rootRow
        }))

    return New-Row @{
        Counted      = @($counted | Sort-Object -Property @{ Expression = { $_.Depth } }, @{ Expression = { $_.Pid } })
        Excluded     = @($excluded.ToArray() | Where-Object { -not $depthByPid.ContainsKey([int]$_.Pid) })
        Orphaned     = @($orphaned.ToArray() | Where-Object { -not $depthByPid.ContainsKey([int]$_.Pid) })
        RootResolved = $true
        RootReason   = 'root present in this snapshot'
    }
}

# ---------------------------------------------------------------------------
# Accounting
# ---------------------------------------------------------------------------

<#
  Sums the per-role memory of a counted process list.

  Two figures are produced and they must never be conflated:

    * `WorkingSetBytes` - the sum of working sets. Shared pages are counted
      once per holding process, so this is an UPPER BOUND.
    * `CommitBytes` - private committed bytes per process, charged to exactly
      one process, so it sums without that double-count. This is the figure this
      repository calls "private memory".

  A role with no processes reports zero with `Complete = $true`, because zero
  processes really do contribute zero bytes. A role with processes whose figures
  could not be read reports `Complete = $false`, so a partial total can never be
  presented as a complete one.

  @param Counted - rows from `Get-ProcessTreeMembership`.
  @returns ProcessCount, the three sums with their completeness flags, CpuSeconds
    and the per-role breakdown.
#>
function Measure-ProcessTreeTotals {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Counted)

    $byRole = New-Object 'System.Collections.Generic.List[object]'
    $workingSetSum = [long]0
    $workingSetComplete = $true
    $commitSum = [long]0
    $commitComplete = $true
    $privateWsSum = [long]0
    $privateWsComplete = $true
    $cpuSum = [double]0
    $cpuComplete = $true

    foreach ($role in Get-ProcessRoleTable) {
        $rows = @($Counted | Where-Object { $_.Role -eq $role })
        $roleWorkingSet = [long]0; $roleWorkingSetComplete = $true
        $roleCommit = [long]0; $roleCommitComplete = $true
        $rolePrivate = [long]0; $rolePrivateComplete = $true
        $roleCpu = [double]0; $roleCpuComplete = $true

        foreach ($row in $rows) {
            if ($null -ne $row.WorkingSetBytes) { $roleWorkingSet += [long]$row.WorkingSetBytes } else { $roleWorkingSetComplete = $false }
            if ($null -ne $row.CommitBytes) { $roleCommit += [long]$row.CommitBytes } else { $roleCommitComplete = $false }
            if ($null -ne $row.PrivateWorkingSetBytes) { $rolePrivate += [long]$row.PrivateWorkingSetBytes } else { $rolePrivateComplete = $false }
            if ($null -ne $row.CpuSeconds) { $roleCpu += [double]$row.CpuSeconds } else { $roleCpuComplete = $false }
        }

        $workingSetSum += $roleWorkingSet
        $commitSum += $roleCommit
        $privateWsSum += $rolePrivate
        $cpuSum += $roleCpu
        if (-not $roleWorkingSetComplete) { $workingSetComplete = $false }
        if (-not $roleCommitComplete) { $commitComplete = $false }
        if (-not $rolePrivateComplete) { $privateWsComplete = $false }
        if (-not $roleCpuComplete) { $cpuComplete = $false }

        $byRole.Add((New-Row @{
            Role                   = $role
            Count                  = $rows.Count
            WorkingSetBytes        = $roleWorkingSet
            CommitBytes            = $roleCommit
            PrivateWorkingSetBytes = $rolePrivate
            CpuSeconds             = [math]::Round($roleCpu, 3)
            WorkingSetComplete     = $roleWorkingSetComplete
            CommitComplete         = $roleCommitComplete
        }))
    }

    return New-Row @{
        ProcessCount              = @($Counted).Count
        WorkingSetBytes           = $workingSetSum
        WorkingSetComplete        = $workingSetComplete
        CommitBytes               = $commitSum
        CommitComplete            = $commitComplete
        PrivateWorkingSetBytes    = $privateWsSum
        PrivateWorkingSetComplete = $privateWsComplete
        CpuSeconds                = [math]::Round($cpuSum, 3)
        CpuComplete               = $cpuComplete
        ByRole                    = $byRole.ToArray()
    }
}

<#
  Turns a measured total plus its incompleteness into the claim a report may
  make, so "complete" is decided by rules rather than by the author's confidence.

  @param Totals - the result of `Measure-ProcessTreeTotals`.
  @param Membership - the result of `Get-ProcessTreeMembership`.
  @param Limits - collection limits recorded with the sample.
  @returns `Claimable` (`full` | `partial` | `none`), `Complete`, and the
    verbatim reason a report must print next to the number.
#>
function Get-ProcessTreeClaim {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Totals,
        [Parameter(Mandatory)]$Membership,
        [AllowEmptyCollection()][string[]]$Limits = @()
    )

    if (-not $Membership.RootResolved) {
        return New-Row @{
            Claimable = 'none'
            Complete  = $false
            Reason    = "no whole-tree number may be claimed: $($Membership.RootReason)"
        }
    }

    $gaps = New-Object 'System.Collections.Generic.List[string]'
    if (-not $Totals.WorkingSetComplete) { $gaps.Add('the working set could not be read for at least one counted process') }
    if (-not $Totals.CommitComplete) { $gaps.Add('private committed bytes could not be read for at least one counted process') }
    if (-not $Totals.PrivateWorkingSetComplete) { $gaps.Add('private working set could not be read for at least one counted process') }
    if (-not $Totals.CpuComplete) { $gaps.Add('CPU time could not be read for at least one counted process') }
    if (@($Membership.Orphaned).Count -gt 0) {
        $gaps.Add("$(@($Membership.Orphaned).Count) process(es) have an absent parent and could not be attributed, so membership is a lower bound")
    }
    if (@($Limits).Count -gt 0) { $gaps.Add("$(@($Limits).Count) collection limit(s) recorded") }
    if ($Totals.ProcessCount -le 1) { $gaps.Add('the tree contains only the root process, which is not a whole-tree measurement') }

    if ($gaps.Count -eq 0) {
        return New-Row @{
            Claimable = 'full'
            Complete  = $true
            Reason    = 'every counted process reported every aggregate and no collection limit applies'
        }
    }
    if ($Totals.ProcessCount -gt 0) {
        return New-Row @{
            Claimable = 'partial'
            Complete  = $false
            Reason    = "PARTIAL: $($gaps -join '; '). Quote each metric and its completeness; partial sums cannot establish the full physical footprint."
        }
    }
    return New-Row @{
        Claimable = 'none'
        Complete  = $false
        Reason    = "no whole-tree number may be claimed: $($gaps -join '; ')"
    }
}

<#
  Formats a byte count for a report. A `$null` count renders as `unavailable`
  rather than `0`, because a missing sample and a measured zero are different
  facts and the difference matters in an audit.

  @param Bytes - the byte count, or `$null`.
  @returns A human-readable string.
#>
function Format-ByteCount {
    [CmdletBinding()]
    [OutputType([string])]
    param([Nullable[long]]$Bytes)
    if ($null -eq $Bytes) { return 'unavailable' }
    $value = [double]$Bytes
    if ([math]::Abs($value) -ge 1073741824) { return ('{0:N2} GiB' -f ($value / 1073741824)) }
    if ([math]::Abs($value) -ge 1048576) { return ('{0:N1} MiB' -f ($value / 1048576)) }
    if ([math]::Abs($value) -ge 1024) { return ('{0:N1} KiB' -f ($value / 1024)) }
    return ('{0} B' -f [long]$value)
}

# ---------------------------------------------------------------------------
# Responsiveness markers
# ---------------------------------------------------------------------------

<#
  Builds the responsiveness marker record. A marker exists in the record ONLY
  when the caller supplied a value. Nothing is invented, and an unmeasured marker
  is present with `Value = $null` and `Status = 'not-measured'` so the gap
  travels with the result instead of disappearing from it.

  @param StartupMs - an already observed startup figure, when the caller has one.
  @param IdleCpuPercent - an already measured idle CPU percentage.
  @param BusyMarkers - a hashtable of named busy-phase latencies in milliseconds.
  @param Source - where the supplied values came from, recorded verbatim.
  @returns Markers, MeasuredCount and NotMeasuredCount.
#>
function New-ResponsivenessMarkers {
    [CmdletBinding()]
    param(
        [Nullable[double]]$StartupMs = $null,
        [Nullable[double]]$IdleCpuPercent = $null,
        [hashtable]$BusyMarkers,
        [string]$Source = 'not-supplied'
    )

    $markers = New-Object 'System.Collections.Generic.List[object]'
    $markers.Add((New-Row @{
        Marker = 'startupMs'
        Value  = $StartupMs
        Unit   = 'ms'
        Status = $(if ($null -eq $StartupMs) { 'not-measured' } else { 'measured' })
        Source = $Source
        Note   = 'process create to first usable UI; needs an observed launch and an interaction predicate'
    }))
    $markers.Add((New-Row @{
        Marker = 'idleCpuPercent'
        Value  = $IdleCpuPercent
        Unit   = 'percent'
        Status = $(if ($null -eq $IdleCpuPercent) { 'not-measured' } else { 'measured' })
        Source = $Source
        Note   = 'idle CPU over a stated quiet window; a point sample is not an idle measurement'
    }))

    $busyNames = @()
    if ($BusyMarkers) { $busyNames = @($BusyMarkers.Keys | Sort-Object) }
    if ($busyNames.Count -eq 0) {
        $markers.Add((New-Row @{
            Marker = 'busy'
            Value  = $null
            Unit   = 'ms'
            Status = 'not-measured'
            Source = $Source
            Note   = 'no busy-phase measurement was supplied (send, session open, scroll, tab switch, stream)'
        }))
    } else {
        foreach ($busyName in $busyNames) {
            $markers.Add((New-Row @{
                Marker = "busy.$busyName"
                Value  = $BusyMarkers[$busyName]
                Unit   = 'ms'
                Status = 'measured'
                Source = $Source
                Note   = 'supplied by the caller; this tool did not observe the interaction'
            }))
        }
    }

    return New-Row @{
        Markers          = $markers.ToArray()
        MeasuredCount    = @($markers | Where-Object { $_.Status -eq 'measured' }).Count
        NotMeasuredCount = @($markers | Where-Object { $_.Status -eq 'not-measured' }).Count
    }
}

# ---------------------------------------------------------------------------
# Fingerprint
# ---------------------------------------------------------------------------

<#
  A machine fingerprint plus this tool's own identity, so a quoted number always
  carries the environment it came from. `Win32_Processor`, `Win32_OperatingSystem`
  and `Win32_ComputerSystem` are refused under the DSH file sandbox on this host,
  so each field degrades to an explicit `unavailable` rather than failing the
  measurement or silently reading as zero.

  @returns The fingerprint.
#>
function Get-ProcessTreeFingerprint {
    [CmdletBinding()]
    param()

    $cpu = 'unavailable'
    $osCaption = 'unavailable'
    $totalRam = 'unavailable'
    try { $cpu = [string](Get-CimInstance Win32_Processor | Select-Object -First 1).Name } catch { $cpu = 'unavailable (CIM refused)' }
    try { $osCaption = [string](Get-CimInstance Win32_OperatingSystem).Caption } catch { $osCaption = 'unavailable (CIM refused)' }
    try { $totalRam = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1) } catch { $totalRam = 'unavailable (CIM refused)' }

    if ($osCaption -eq 'unavailable (CIM refused)') {
        # PROCESSOR_ARCHITECTURE is process metadata, not user content, and it is
        # the one OS-shape fact available without a privileged query.
        $osCaption = "unavailable (CIM refused); PROCESSOR_ARCHITECTURE=$env:PROCESSOR_ARCHITECTURE"
    }

    return New-Row @{
        CapturedAtUtc     = (Get-Date).ToUniversalTime().ToString('o')
        OsCaption         = $osCaption
        Cpu               = $cpu
        LogicalProcessors = [Environment]::ProcessorCount
        TotalRamGiB       = $totalRam
        PowerShellVersion = $PSVersionTable.PSVersion.ToString()
        PowerShellEdition = $(if ($PSVersionTable.ContainsKey('PSEdition')) { [string]$PSVersionTable.PSEdition } else { 'Desktop' })
        NativeReader      = (Test-ProcessTreeNativeReader)
        NativeReaderError = (Get-ProcessTreeNativeReaderError)
    }
}

# Both ends of a parent edge must have verifiable creation times. A stale
# parent PID must not attach a surviving child to a different/newer process.
# CIM CreationDate has microsecond precision; .NET/GetProcessTimes have 100ns
# precision. Normalize only the CIM observation comparison, never retained keys.
function Test-ProcessCreationObservation {
    param([Nullable[long]]$ExpectedTicks, [Nullable[long]]$ObservedTicks)
    if ($null -eq $ExpectedTicks -or $null -eq $ObservedTicks) { return $false }
    $expected = [long]$ExpectedTicks; $observed = [long]$ObservedTicks
    return (($expected - ($expected % 10)) -eq ($observed - ($observed % 10)))
}

function Test-ProcessParentChronology {
    param([Parameter(Mandatory)]$Parent, [Parameter(Mandatory)]$Child)
    $parentIdentity = Get-ProcessIdentityFromRow $Parent
    $childIdentity = Get-ProcessIdentityFromRow $Child
    return ($null -ne $parentIdentity.StartTimeTicks -and
        $null -ne $childIdentity.StartTimeTicks -and
        [long]$parentIdentity.StartTimeTicks -le [long]$childIdentity.StartTimeTicks)
}

function New-TrackedProcessRow {
    param($Row, [int]$Depth, [string]$Basis, [string]$Role)
    return New-Row @{
        Pid = [int]$Row.Pid; ParentPid = $Row.ParentPid; Name = $Row.Name
        Role = $Role; Depth = $Depth; Basis = $Basis
        StartTimeUtc = $Row.StartTimeUtc; Identity = Get-ProcessIdentityFromRow $Row
        WorkingSetBytes = $Row.WorkingSetBytes; CommitBytes = $Row.CommitBytes
        PrivateWorkingSetBytes = $Row.PrivateWorkingSetBytes; CpuSeconds = $Row.CpuSeconds
    }
}

# History belongs to one observation/launch, not the machine. Only exact
# PID+creation identities are retained. Exited/reparented ancestors do not
# erase live known descendants, and a recycled PID never inherits membership.
function Get-ProcessTreeRunClaim {
    param([AllowEmptyCollection()][object[]]$Samples)
    if (@($Samples).Count -eq 0 -or @($Samples | Where-Object { $_.Claim.Claimable -eq 'none' }).Count -gt 0) {
        return New-Row @{ Claimable = 'none'; Complete = $false; Reason = 'at least one sample has no attributable root identity; no whole-run claim is permitted' }
    }
    $partial = @($Samples | Where-Object { $_.Claim.Claimable -ne 'full' })
    if ($partial.Count -gt 0) {
        return New-Row @{ Claimable = 'partial'; Complete = $false; Reason = "$($partial.Count) sample(s) are partial; a complete final sample cannot upgrade earlier incomplete observations" }
    }
    return New-Row @{ Claimable = 'full'; Complete = $true; Reason = 'all observed live snapshots are complete under the recorded limits; periodic sampling can miss short-lived processes' }
}

function Get-ProcessTreeSeriesMembership {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Snapshot,
        [Parameter(Mandatory)][int]$RootPid,
        [Nullable[long]]$RootStartTimeTicks = $null,
        [AllowEmptyCollection()][int[]]$ExcludedRoots = @(),
        [Parameter(Mandatory)][AllowEmptyCollection()][hashtable]$History
    )
    $membership = Get-ProcessTreeMembership -Snapshot $Snapshot -RootPid $RootPid `
        -RootStartTimeTicks $RootStartTimeTicks -ExcludedRoots $ExcludedRoots
    $rowsByPid = @{}
    foreach ($row in $Snapshot.Processes) { $rowsByPid[[int]$row.Pid] = $row }
    $excluded = @{}
    foreach ($excludedRoot in $ExcludedRoots) { $excluded[[int]$excludedRoot] = $true }
    # Explicit exclusions win even for a previously observed member.
    do {
        $expanded = $false
        foreach ($row in $Snapshot.Processes) {
            if ($null -eq $row.ParentPid -or $excluded.ContainsKey([int]$row.Pid)) { continue }
            if ($excluded.ContainsKey([int]$row.ParentPid) -and $rowsByPid.ContainsKey([int]$row.ParentPid) -and
                (Test-ProcessParentChronology -Parent $rowsByPid[[int]$row.ParentPid] -Child $row)) {
                $excluded[[int]$row.Pid] = $true; $expanded = $true
            }
        }
    } while ($expanded)
    $members = @{}
    foreach ($row in $membership.Counted) {
        if (-not $excluded.ContainsKey([int]$row.Pid)) { $members[[int]$row.Pid] = $row }
    }
    foreach ($row in $Snapshot.Processes) {
        $processId = [int]$row.Pid
        if ($members.ContainsKey($processId) -or $excluded.ContainsKey($processId)) { continue }
        $identity = Get-ProcessIdentityFromRow $row
        if ($null -eq $identity.StartTimeTicks) { continue }
        $key = Get-ProcessIdentityKey $identity
        if ($History.ContainsKey($key)) {
            $previous = $History[$key]
            $members[$processId] = New-TrackedProcessRow -Row $row -Depth $previous.Depth `
                -Basis 'retained-identity' -Role $previous.Role
        }
    }
    # Includes descendants of retained or explicit identity-matched seeds;
    # snapshot enumeration order cannot affect attribution.
    do {
        $expanded = $false
        foreach ($row in $Snapshot.Processes) {
            $processId = [int]$row.Pid
            if ($members.ContainsKey($processId) -or $excluded.ContainsKey($processId) -or $null -eq $row.ParentPid) { continue }
            $parentId = [int]$row.ParentPid
            if (-not $members.ContainsKey($parentId)) { continue }
            if (-not (Test-ProcessParentChronology -Parent $rowsByPid[$parentId] -Child $row)) { continue }
            $parent = $members[$parentId]
            $depth = [int]$parent.Depth + 1
            $role = Get-ProcessRole -Row $row -RootPid $RootPid
            if ($role -eq 'NodeHost' -and $parent.Role -in @('NodeHost', 'Tool')) { $role = 'Tool' }
            $members[$processId] = New-TrackedProcessRow -Row $row -Depth $depth -Basis 'lineage' -Role $role
            $expanded = $true
        }
    } while ($expanded)
    $membership.Counted = @($members.Values | Sort-Object Depth, Pid)
    $membership.Orphaned = @($membership.Orphaned | Where-Object { -not $members.ContainsKey([int]$_.Pid) })
    $membership.Excluded = @($membership.Excluded | Where-Object { -not $members.ContainsKey([int]$_.Pid) })
    foreach ($row in $membership.Counted) {
        if ($null -ne $row.Identity.StartTimeTicks) { $History[(Get-ProcessIdentityKey $row.Identity)] = $row }
    }
    return $membership
}

Export-ModuleMember -Function @(
    'Test-ProcessCreationObservation'
    'Get-ProcessTreeRunClaim'
    'ConvertTo-PrivateWorkingSetCounterMap'
    'Get-ProcessTreeSeriesMembership'
    'Test-ProcessParentChronology'
    'New-Row'
    'Initialize-ProcessTreeNativeReader'
    'Test-ProcessTreeNativeReader'
    'Get-ProcessTreeNativeReaderError'
    'Get-ProcessTreeSnapshot'
    'Get-ProcessIdentityFromRow'
    'New-ProcessIdentity'
    'Test-ProcessIdentityEqual'
    'Get-ProcessIdentityKey'
    'Compare-ProcessTreeSnapshot'
    'Get-ProcessRole'
    'Get-ProcessRoleTable'
    'Resolve-AmbiguousRole'
    'Get-ProcessTreeMembership'
    'Measure-ProcessTreeTotals'
    'Get-ProcessTreeClaim'
    'Format-ByteCount'
    'New-ResponsivenessMarkers'
    'Get-ProcessTreeFingerprint'
    'Get-DeterministicUInt32'
    'Reset-DeterministicSeed'
    'Get-StableHash64'
    'Get-PrivateWorkingSetCounterMap'
)
