# Packaging-test fixtures ONLY; no production process policy or ACL repair.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:OwnedRoots = @{}

# Centralised native quoting. Loaded without `-Force` so a nested forced re-import
# cannot hide the caller's instance (observed under Windows PowerShell 5.1).
if (-not (Get-Command -Name 'ConvertTo-DshNativeArgumentList' -ErrorAction SilentlyContinue)) {
    Import-Module (Join-Path $PSScriptRoot 'native-quoting.psm1') -Global -ErrorAction Stop
}

function Assert-PackagingAbsolutePath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -notmatch '^[A-Za-z]:\\') {
        throw 'Fixture path must be an absolute local Windows path.'
    }
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not [string]::Equals($full, $Path.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw "Fixture path is not canonical: $Path"
    }
    return $full
}

function Assert-PackagingNoLinkedAncestors([string]$Path) {
    $walk = Assert-PackagingAbsolutePath $Path
    while ($walk) {
        if (Test-Path -LiteralPath $walk -ErrorAction Stop) {
            $item = Get-Item -LiteralPath $walk -Force -ErrorAction Stop
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Fixture path traverses a reparse point: $walk"
            }
        }
        $parent = Split-Path -Parent $walk
        if (-not $parent -or $parent -eq $walk) { break }
        $walk = $parent
    }
}

function Assert-PackagingFixturePath {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Path,
          [switch]$AllowLeafReparsePoint)
    $base = Assert-PackagingAbsolutePath $Root
    $full = Assert-PackagingAbsolutePath $Path
    if (-not $script:OwnedRoots.ContainsKey($base) -or
        -not $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Destructive fixture target is not strictly inside a root created by this invocation: $full"
    }
    $walk = if ($AllowLeafReparsePoint) { Split-Path -Parent $full } else { $full }
    Assert-PackagingNoLinkedAncestors $walk
    return $full
}

function New-PackagingFixtureRoot {
    param([Parameter(Mandatory)][string]$PortRoot,
          [Parameter(Mandatory)][ValidateSet('packaging-module-tests', 'packaging-stage-guards',
              'installer-hooks-compile', 'installer-strings-messages', 'installer-guard-probe',
              'installer-hook-behavior', 'packaging-safety-runner')][string]$Prefix,
          [string]$RequestedRoot,
          [int]$MaxPathLength = 200)
    # PortRoot is read-only source context retained for caller compatibility, never a fixture base.
    $null = Assert-PackagingAbsolutePath $PortRoot
    $local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    $scope = Assert-PackagingAbsolutePath (Join-Path $local 'DSH-Packaging-Qualification')
    $parent = Join-Path $scope $Prefix
    # An 8-hex leaf keeps the deepest fixture path short (the run that motivated
    # this had 293-character session paths and made `git status` warn "Filename too
    # long") while remaining collision-free in practice; an explicitly requested
    # root is still held to the stricter UUID form below.
    $root = if ([string]::IsNullOrWhiteSpace($RequestedRoot)) {
        Join-Path $parent ([guid]::NewGuid().ToString('N').Substring(0, 8))
    } else { Assert-PackagingAbsolutePath $RequestedRoot }
    $root = Assert-PackagingAbsolutePath $root
    if ($root.Length -gt $MaxPathLength -or $parent.Length -gt ($MaxPathLength - 12)) {
        throw "Fixture root path is longer than the $MaxPathLength-character bound; choose a shorter scope or prefix: $root"
    }
    # Explicit roots must be fresh UUID children of this suite's exact scope.
    if (-not [string]::Equals((Split-Path -Parent $root), $parent, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Leaf $root) -notmatch '^(?:[0-9a-f]{8}|[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$') {
        throw "Fixture root must be a fresh UUID child of $parent"
    }
    Write-Host "FIXTURE_ROOT_PLANNED=$root; OS-known LocalApplicationData; exact suite UUID scope"
    Assert-PackagingNoLinkedAncestors $root
    if (Test-Path -LiteralPath $root -ErrorAction Stop) { throw "Fixture root already exists; preserved without modification: $root" }
    $null = New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop
    $null = New-Item -ItemType Directory -Path $root -ErrorAction Stop
    Write-Host "FIXTURE_ROOT_CREATED=$root; preserved even if ACL setup fails"
    # Fresh ROOT only. Apply the real current-user SID and SYSTEM before contents.
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
    if ($null -eq $user -or $user.Value -eq 'S-1-1-0' -or $user.Value -eq $system.Value) {
        throw 'The actual current-user SID could not be established distinctly from SYSTEM.'
    }
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($user)
    $flags = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($sid in @($user, $system)) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl, $flags,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow)
        $null = $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $root -AclObject $acl -ErrorAction Stop
    $actual = Get-Acl -LiteralPath $root -ErrorAction Stop
    if ($null -eq $actual -or -not $actual.AreAccessRulesProtected) { throw 'Fixture ROOT DACL is not protected.' }
    $rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    $seen = @{}
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Value
        if ($sid -notin @($user.Value, $system.Value) -or $rule.IsInherited -or
            $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
            $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
            $rule.InheritanceFlags -ne $flags -or
            $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None -or
            $seen.ContainsKey($sid)) { throw 'Fixture ROOT DACL readback has unexpected SID, rights or inheritance.' }
        $seen[$sid] = $true
    }
    if ($rules.Count -ne 2 -or -not $seen.ContainsKey($user.Value) -or -not $seen.ContainsKey($system.Value)) {
        throw 'Fixture ROOT DACL does not grant exactly current user and SYSTEM.'
    }
    $script:OwnedRoots[$root] = $true
    # Logs and NSIS $TEMP output remain inside the protected ROOT, on every exit.
    $null = Start-Transcript -LiteralPath (Join-Path $root 'suite-transcript.log') -ErrorAction Stop
    Write-Host "FIXTURE_ROOT=$root"
    Write-Host "ROOT_ACL=protected; user=$($user.Value); system=$($system.Value); FullControl; OI,CI; propagation=None"
    $temp = Join-Path $root 'temp'
    $null = New-Item -ItemType Directory -Path $temp -ErrorAction Stop
    # TEMP/TMP are NOT set process-wide here. They are set per child in
    # Start-PackagingFixtureProcess, so one suite can never change another suite's
    # or the caller's environment, and there is no "was it absent or empty?"
    # question to get wrong on the way out. `Push-PackagingFixtureEnvironment`
    # exists for the rare caller that runs a compiled probe directly.
    Write-Host "FIXTURE_TEMP=$temp; applied per child; process TEMP is untouched"
    return $root
}

function Push-PackagingFixtureEnvironment {
    <#
    .SYNOPSIS
      Redirect TEMP/TMP into an owned fixture root for the current process, and
      return a scope that restores the previous state exactly.
    .DESCRIPTION
      "Exactly" includes the absent-versus-empty distinction: a variable that was
      never set is removed again, and one that was set to the empty string is set
      back to the empty string. The finding this closes was a suite leaving TEMP
      pointed at a fixture directory for the rest of the session.
    #>
    param([Parameter(Mandatory)][string]$Root)

    $temp = Join-Path $Root 'temp'
    if (-not (Test-Path -LiteralPath $temp)) { $null = New-Item -ItemType Directory -Path $temp -ErrorAction Stop }
    $scope = [pscustomobject]@{ Root = $Root; Temp = $temp; Prior = @{} }
    foreach ($name in @('TEMP', 'TMP')) {
        $existed = Test-Path -LiteralPath "Env:$name"
        $scope.Prior[$name] = [pscustomobject]@{
            Existed = $existed
            Value = if ($existed) { (Get-Item -LiteralPath "Env:$name").Value } else { $null }
        }
        Set-Item -LiteralPath "Env:$name" -Value $temp
    }
    Write-Host "FIXTURE_ENV_PUSHED=TEMP,TMP->$temp"
    return $scope
}

function Pop-PackagingFixtureEnvironment {
    param([Parameter(Mandatory)]$Scope)

    foreach ($name in @('TEMP', 'TMP')) {
        $prior = $Scope.Prior[$name]
        if ($prior.Existed) {
            Set-Item -LiteralPath "Env:$name" -Value $prior.Value
        } else {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        }
    }
    Write-Host "FIXTURE_ENV_RESTORED=TEMP,TMP (absent stays absent, empty stays empty)"
}

function Test-PackagingFixtureIntegrity {
    <#
    .SYNOPSIS
      Read-only integrity observation of the fixture root and of this process.
    .DESCRIPTION
      Never relabels and never repairs. A root that is Low while this process is
      Medium is the documented write-up hazard, so it is reported as a refusal
      with that diagnosis; an unreadable label is reported as unknown, and the
      caller decides. Returns a record rather than throwing for Low, because a
      suite must be able to turn the condition into a structured SKIP.
    #>
    param([Parameter(Mandatory)][string]$Root)

    if (-not (Get-Command -Name 'Get-DshProcessIntegrity' -ErrorAction SilentlyContinue)) {
        Import-Module (Join-Path $PSScriptRoot 'qualification-preflight.psm1') -Global -ErrorAction Stop
    }
    $parent = Get-DshProcessIntegrity -ProcessId $PID
    $label = Get-DshFileIntegrityLabel -Path (Join-Path $Root 'temp')
    $hazard = $label.Known -and $label.Level -eq 'low' -and $parent.Known -and $parent.Level -eq 'medium'
    $record = [pscustomobject]@{
        Root = $Root
        Parent = $parent
        RootLabel = $label
        Known = ($parent.Known -and $label.Known)
        Downgraded = $hazard
        Diagnosis = if ($hazard) {
            'The fixture root carries Low integrity while this process is Medium; a Low child cannot write up to it (EPERM -4048). No relabel was attempted.'
        } elseif (-not $label.Known) { "The fixture root label could not be read: $($label.Reason)" }
        elseif (-not $parent.Known) { "This process integrity could not be read: $($parent.Reason)" }
        else { '' }
    }
    Write-Host "FIXTURE_INTEGRITY root=$Root parent=$($parent.Level) label=$($label.Level) known=$($record.Known) downgraded=$($hazard)"
    return $record
}

function Get-PackagingProcessIdentity([int]$ProcessId) {
    try {
        if ($ProcessId -le 0) { throw 'Invalid direct-root PID.' }
        $rows = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop)
        if ($rows.Count -eq 0) { return [pscustomobject]@{ Status = 'absent'; ProcessId = $ProcessId; Exe = $null; Ticks = $null; Reason = 'CIM explicitly returned zero rows' } }
        if ($rows.Count -ne 1 -or [int]$rows[0].ProcessId -ne $ProcessId -or
            [string]::IsNullOrWhiteSpace($rows[0].ExecutablePath) -or $null -eq $rows[0].CreationDate) {
            throw 'CIM process identity is incomplete or ambiguous.'
        }
        $exe = Assert-PackagingAbsolutePath $rows[0].ExecutablePath
        return [pscustomobject]@{ Status = 'present'; ProcessId = $ProcessId; Exe = $exe;
            Ticks = $rows[0].CreationDate.ToUniversalTime().Ticks; Reason = '' }
    } catch {
        return [pscustomobject]@{ Status = 'unknown'; ProcessId = $ProcessId; Exe = $null; Ticks = $null; Reason = $_.Exception.Message }
    }
}

function Start-PackagingFixtureProcess {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Executable,
          [Parameter(Mandatory)][string[]]$Arguments,
          [hashtable]$Environment = @{})
    $exe = Assert-PackagingFixturePath -Root $Root -Path $Executable
    $before = [datetime]::UtcNow.Ticks
    # One verbatim, correctly quoted command line; PowerShell 5.1 would otherwise
    # join the array without quoting and silently truncate an argument containing a
    # space. The child's TEMP/TMP are set here, for THIS child only.
    $temp = Join-Path $Root 'temp'
    if (-not (Test-Path -LiteralPath $temp)) { $null = New-Item -ItemType Directory -Path $temp -ErrorAction Stop }
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $exe
    $startInfo.Arguments = ConvertTo-DshNativeArgumentList -Arguments $Arguments
    $startInfo.WorkingDirectory = $Root
    $startInfo.UseShellExecute = $false
    $startInfo.EnvironmentVariables['TEMP'] = $temp
    $startInfo.EnvironmentVariables['TMP'] = $temp
    foreach ($key in $Environment.Keys) { $startInfo.EnvironmentVariables[$key] = [string]$Environment[$key] }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Fixture process did not start: $exe" }
    # Capture before any wait/probe. Fast exited roots may be positively absent;
    # unknown/mismatched roots never acquire termination authority.
    $identity = Get-PackagingProcessIdentity -ProcessId $process.Id
    $after = [datetime]::UtcNow.Ticks
    $owned = $identity.Status -eq 'present' -and $identity.Exe -eq $exe -and
        $identity.Ticks -ge $before -and $identity.Ticks -le $after
    $record = [pscustomobject]@{ Process = $process; Identity = $identity; Executable = $exe; Root = $Root; Owned = $owned; StopAttempted = $false; ChildTemp = $temp }
    Write-Host "PROCESS_SPAWN pid=$($process.Id) status=$($identity.Status) exe=$($identity.Exe) creationTicks=$($identity.Ticks) owned=$owned"
    if (-not $owned -and $identity.Status -ne 'absent') {
        Write-Host "UNRESOLVED_ROOT pid=$($process.Id); no kill; spawn identity not established: $($identity.Reason)"
        throw 'Spawn-time fixture process identity not established; no termination attempted.'
    }
    return $record
}

function Stop-PackagingFixtureProcess {
    param([Parameter(Mandatory)]$Record)
    if ($Record.StopAttempted) {
        Write-Host "UNRESOLVED_ROOT pid=$($Record.Process.Id); no repeated termination attempt"
        throw 'Fixture termination was already attempted; no further kill.'
    }
    $Record.StopAttempted = $true
    $fresh = Get-PackagingProcessIdentity -ProcessId $Record.Process.Id
    if ($fresh.Status -eq 'absent') {
        Write-Host "PROCESS_ABSENT pid=$($Record.Process.Id); $($fresh.Reason)"
        return
    }
    $null = Assert-PackagingFixturePath -Root $Record.Root -Path $Record.Executable
    if (-not $Record.Owned -or $fresh.Status -ne 'present' -or
        $fresh.ProcessId -ne $Record.Identity.ProcessId -or $fresh.Exe -ne $Record.Identity.Exe -or
        $fresh.Exe -ne $Record.Executable -or $fresh.Ticks -ne $Record.Identity.Ticks) {
        Write-Host "UNRESOLVED_ROOT pid=$($Record.Process.Id); no kill; fresh identity unknown or mismatched: $($fresh.Reason)"
        throw 'Fresh fixture process identity not established; refusing termination.'
    }
    # Exactly this direct root; NEVER descendants, image-name or tree termination.
    Write-Host "PROCESS_STOP_VERIFIED pid=$($fresh.ProcessId) exe=$($fresh.Exe) creationTicks=$($fresh.Ticks)"
    try {
        Stop-Process -Id $fresh.ProcessId -Force -ErrorAction Stop
    } catch {
        Write-Host "UNRESOLVED_ROOT pid=$($fresh.ProcessId); verified Stop-Process failed; no further kill: $($_.Exception.Message)"
        throw
    }
    if (-not $Record.Process.WaitForExit(10000)) {
        Write-Host "UNRESOLVED_ROOT pid=$($fresh.ProcessId); verified termination did not complete; no further kill"
        throw 'Verified direct-root process did not exit within 10 seconds.'
    }
}

Export-ModuleMember -Function New-PackagingFixtureRoot, Assert-PackagingFixturePath, Get-PackagingProcessIdentity,
    Start-PackagingFixtureProcess, Stop-PackagingFixtureProcess,
    Push-PackagingFixtureEnvironment, Pop-PackagingFixtureEnvironment, Test-PackagingFixtureIntegrity
