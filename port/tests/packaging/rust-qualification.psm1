# Trusted, outside-the-workspace roots and image/child-token evidence for Rust hosts.
#
# WHY THIS MODULE EXISTS
#   The DSH sandbox labels the workspace tree `Mandatory Label\Low Mandatory Level`.
#   Any executable CREATED inside it (including everything cargo links into
#   `port/src-tauri/target/...`) becomes a Low image, so Windows starts it with a
#   Low token; MSVC link/PDB work and test-binary children then fail with errors
#   that name the wrong cause (the observed `D8050` and the credentials /
#   diagnostics / profile failures). Files created in an UNLABELLED directory
#   inherit Medium, so an outside target/TEMP root is the durable fix.
#
# WHAT THIS MODULE DOES, AND WHAT IT REFUSES TO DO
#   * creates one short owned root outside the checkout, with `target`, `temp`,
#     `probe` and `cargo` subdirectories, and enforces a path-length bound
#     (Node/NSIS/Rust all suffer from long fixture roots);
#   * reports IMAGE evidence (absolute path, length, size, SHA-256, mandatory
#     label) and ACTUAL CHILD TOKEN evidence (the integrity SID of a child it
#     started itself) for `cargo.exe`, `rustc.exe` and any new-built artifact the
#     caller names;
#   * applies environment overrides PER CHILD on the child's own
#     `ProcessStartInfo`, so the caller's environment is never changed;
#   * never relabels, never resets or normalises an ACL, never sweeps processes,
#     never touches credentials, never installs anything, and never launches the
#     application. An artifact probe runs only the arguments the caller passes
#     (for a Rust test binary, `--list`), never a real application start.
#
# Pure ASCII; Windows PowerShell 5.1 and 7 compatible.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command -Name 'Get-DshProcessIntegrity' -ErrorAction SilentlyContinue)) {
    Import-Module (Join-Path $PSScriptRoot 'qualification-preflight.psm1') -Global -ErrorAction Stop
}
if (-not (Get-Command -Name 'ConvertTo-DshNativeArgumentList' -ErrorAction SilentlyContinue)) {
    Import-Module (Join-Path $PSScriptRoot 'native-quoting.psm1') -Global -ErrorAction Stop
}

function New-DshRustQualificationRoot {
    <#
    .SYNOPSIS
      Create one short, fresh, owned Rust qualification root OUTSIDE the checkout.
    .DESCRIPTION
      `%LOCALAPPDATA%\DSH-Qual-<8 hex>` keeps the deepest cargo path well inside
      the legacy path limit, which matters because a target directory holds
      `<crate>-<hash>.exe`, `.pdb` and `incremental` paths that are already long.
      An existing root is refused, never reused and never cleared.
    #>
    param([int]$MaxPathLength = 120)

    $local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if ([string]::IsNullOrWhiteSpace($local)) { throw 'LocalApplicationData could not be resolved.' }
    $root = Join-Path $local ('DSH-Qual-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    if ($root.Length -gt 60) { throw "Rust qualification root is unexpectedly long ($($root.Length)): $root" }
    if (Test-Path -LiteralPath $root) { throw "Rust qualification root already exists; preserved unmodified: $root" }
    $null = New-Item -ItemType Directory -Path $root -ErrorAction Stop

    $paths = [ordered]@{ Root = $root }
    foreach ($name in @('target', 'temp', 'probe', 'cargo')) {
        $path = Join-Path $root $name
        $null = New-Item -ItemType Directory -Path $path -ErrorAction Stop
        $paths[$name.Substring(0, 1).ToUpperInvariant() + $name.Substring(1)] = $path
    }
    $result = [pscustomobject]@{
        Root = $root
        Target = $paths.Target
        Temp = $paths.Temp
        Probe = $paths.Probe
        Cargo = $paths.Cargo
        RootLength = $root.Length
        DeepestFixture = (Join-Path $paths.Target 'debug\deps\placeholder-hash.exe')
        MaxPathLength = $MaxPathLength
    }
    if ($result.DeepestFixture.Length -gt $MaxPathLength) {
        throw "A target artifact path would be $($result.DeepestFixture.Length) characters, over the $MaxPathLength bound: $($result.DeepestFixture)"
    }
    Write-Host "RUST_QUAL_ROOT=$root (outside workspace; target/temp/probe/cargo created; retained)"
    Write-Host "RUST_QUAL_DEEPEST_FIXTURE=$($result.DeepestFixture) length=$($result.DeepestFixture.Length)"
    return $result
}

function Get-DshImageEvidence {
    <#
    .SYNOPSIS
      Read-only evidence about an executable image: path, length, size, hash, label.
    #>
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Image is absent: $Path" }
    $full = (Resolve-Path -LiteralPath $Path).Path
    $item = Get-Item -LiteralPath $full -Force
    $label = Get-DshFileIntegrityLabel -Path $full
    return [pscustomobject]@{
        Path = $full
        PathLength = $full.Length
        Bytes = $item.Length
        Sha256 = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
        LabelKnown = $label.Known
        LabelLevel = $label.Level
        LabelSid = $label.Sid
        ReparsePoint = (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
        ModifiedUtc = $item.LastWriteTimeUtc.ToString('o')
    }
}

function Invoke-DshOwnedChild {
    <#
    .SYNOPSIS
      Start one child with exact per-child environment overrides and report the
      child's own token integrity, exit code and output.
    .DESCRIPTION
      The parent environment is inherited and then overridden only for the keys
      the caller names, on the child's own `ProcessStartInfo`. Nothing is written
      to the caller's environment, so no restore is needed and the
      absent-versus-empty question cannot arise.
    #>
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [AllowEmptyCollection()][string[]]$Arguments = @(),
        [string]$WorkingDirectory,
        [hashtable]$Environment = @{},
        [int]$TimeoutSeconds = 120
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { throw "Child executable is absent: $FilePath" }
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = ConvertTo-DshNativeArgumentList -Arguments $Arguments
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    if ($WorkingDirectory) {
        if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) { throw "Working directory is absent: $WorkingDirectory" }
        $startInfo.WorkingDirectory = $WorkingDirectory
    }
    foreach ($key in $Environment.Keys) { $startInfo.EnvironmentVariables[$key] = [string]$Environment[$key] }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        if (-not $process.Start()) { throw "Child did not start: $FilePath" }
        # The token is read from the live child, which is the authoritative answer:
        # it is the token the kernel will enforce for this image and this parent.
        $token = Get-DshProcessIntegrity -ProcessId $process.Id
        $outTask = $process.StandardOutput.ReadToEndAsync()
        $errTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $process.Kill() } catch { }
            $null = $process.WaitForExit(10000)
            throw "Child exceeded ${TimeoutSeconds}s and was stopped by its own pid: $FilePath"
        }
        $stdout = $outTask.GetAwaiter().GetResult()
        $stderr = $errTask.GetAwaiter().GetResult()
        return [pscustomobject]@{
            Path = $FilePath
            CommandLine = "$FilePath $($startInfo.Arguments)"
            ExitCode = $process.ExitCode
            StandardOutput = $stdout.Trim()
            StandardError = $stderr.Trim()
            ChildTokenKnown = $token.Known
            ChildTokenLevel = $token.Level
            ChildTokenSid = $token.Sid
            ChildTokenReason = $token.Reason
        }
    } finally {
        $ErrorActionPreference = $previous
        if ($null -ne $process) { $process.Dispose() }
    }
}

function Get-DshRustToolchainEvidence {
    <#
    .SYNOPSIS
      Image + actual child-token evidence for the cargo and rustc that will be used.
    .DESCRIPTION
      `-ProbeToken` runs `<tool> --version` inside the owned probe root with the
      per-child TEMP/TMP override and reads the child's token. That is a harmless,
      side-effect-free invocation; it is not a build and not a test run.
    #>
    param(
        [Parameter(Mandatory)][string]$OwnedRoot,
        [switch]$ProbeToken,
        [int]$TimeoutSeconds = 120
    )

    $probeDir = Join-Path $OwnedRoot 'probe'
    if (-not (Test-Path -LiteralPath $probeDir)) { $null = New-Item -ItemType Directory -Path $probeDir -ErrorAction Stop }
    $childEnvironment = Get-DshRustChildEnvironment -OwnedRoot $OwnedRoot

    $evidence = @()
    foreach ($tool in @('cargo', 'rustc')) {
        $command = Get-Command $tool -ErrorAction SilentlyContinue
        if ($null -eq $command) {
            $evidence += [pscustomobject]@{ Tool = $tool; Present = $false; Image = $null; Child = $null; Refusal = "$tool was not found on PATH" }
            continue
        }
        $image = Get-DshImageEvidence -Path $command.Source
        $child = $null
        $refusal = ''
        if ($ProbeToken) {
            try {
                $child = Invoke-DshOwnedChild -FilePath $command.Source -Arguments @('--version') `
                    -WorkingDirectory $probeDir -Environment $childEnvironment -TimeoutSeconds $TimeoutSeconds
                if (-not $child.ChildTokenKnown) { $refusal = "child token unknown: $($child.ChildTokenReason)" }
                elseif ($child.ExitCode -ne 0) { $refusal = "version probe exited $($child.ExitCode): $($child.StandardError)" }
                elseif ($child.ChildTokenLevel -eq 'low') {
                    $refusal = "$tool runs at Low integrity ($($child.ChildTokenSid)); a Low compiler cannot write up to a Medium target/temp root. Refusing it rather than relabelling anything."
                }
            } catch {
                $refusal = $_.Exception.Message
            }
        }
        $evidence += [pscustomobject]@{ Tool = $tool; Present = $true; Image = $image; Child = $child; Refusal = $refusal }
    }

    # link.exe is reported when it can be located because the MSVC link/PDB stage is
    # where a Low target directory surfaces as D8050. Absence is not an error: the
    # toolset may be resolved by rustc through its own vcvars environment.
    $linkCommand = Get-Command link.exe -ErrorAction SilentlyContinue
    $link = if ($null -ne $linkCommand) { Get-DshImageEvidence -Path $linkCommand.Source } else { $null }
    return [pscustomobject]@{ Tools = $evidence; Link = $link }
}

function Get-DshRustChildEnvironment {
    <#
    .SYNOPSIS
      The exact per-child environment for a trusted cargo/rustc run.
    .DESCRIPTION
      Only these keys are overridden; everything else (PATH, CARGO_HOME,
      RUSTUP_HOME, RUSTFLAGS, RUSTC_WRAPPER, credentials the toolchain needs) is
      inherited unchanged from the caller.
    #>
    param([Parameter(Mandatory)][string]$OwnedRoot)

    $target = Join-Path $OwnedRoot 'target'
    $temp = Join-Path $OwnedRoot 'temp'
    foreach ($path in @($target, $temp)) {
        if (-not (Test-Path -LiteralPath $path)) { $null = New-Item -ItemType Directory -Path $path -ErrorAction Stop }
    }
    return @{
        CARGO_TARGET_DIR = $target
        TEMP = $temp
        TMP = $temp
        TMPDIR = $temp
        RUST_BACKTRACE = '1'
    }
}

function Get-DshRustCargoArguments {
    <#
    .SYNOPSIS
      The ready, serialized cargo arguments for the trusted outside root.
    .DESCRIPTION
      `--config profile.dev.debug=0` is the D8050 mitigation the parent identified:
      with no PDB emitted, the link stage does not depend on debug-info files in
      the (previously Low) target directory. `--jobs 1` keeps the gates serialized
      so a shared temp/global label cannot make one crate's link race another's.
    #>
    param(
        [int]$Jobs = 1,
        [switch]$KeepDebugInfo,
        [switch]$Offline,
        [switch]$Locked
    )

    $arguments = @()
    if ($Locked) { $arguments += '--locked' }
    if ($Offline) { $arguments += '--offline' }
    $arguments += @('--jobs', [string]$Jobs)
    if (-not $KeepDebugInfo) { $arguments += @('--config', 'profile.dev.debug=0') }
    return $arguments
}

function Test-DshRustArtifactTrust {
    <#
    .SYNOPSIS
      Image and (opt-in) actual child-token evidence for a newly built artifact.
    .DESCRIPTION
      For a Rust test binary the safe probe is `--list`, which enumerates tests and
      never runs one. For an application binary there is NO safe probe here, so
      this reports image evidence only and says so; launching the application is
      the parent's decision, never this helper's.
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [string[]]$Arguments = @('--list'),
        [switch]$SkipProbe,
        [Parameter(Mandatory)][string]$OwnedRoot,
        [int]$TimeoutSeconds = 120
    )

    $image = Get-DshImageEvidence -Path $Path
    if ($SkipProbe) {
        Write-Host "ARTIFACT_IMAGE_ONLY=$($image.Path) label=$($image.LabelLevel) sha256=$($image.Sha256) (no probe; launching is the parent's decision)"
        return [pscustomobject]@{ Image = $image; Child = $null; Probed = $false }
    }
    $probeDir = Join-Path $OwnedRoot 'probe'
    $childEnvironment = Get-DshRustChildEnvironment -OwnedRoot $OwnedRoot
    $child = Invoke-DshOwnedChild -FilePath $image.Path -Arguments $Arguments -WorkingDirectory $probeDir -Environment $childEnvironment -TimeoutSeconds $TimeoutSeconds
    Write-Host "ARTIFACT_PROBE=$($image.Path) args='$($Arguments -join ' ')' exit=$($child.ExitCode) childToken=$($child.ChildTokenLevel) label=$($image.LabelLevel)"
    return [pscustomobject]@{ Image = $image; Child = $child; Probed = $true }
}

function Test-DshRustTargetTrust {
    <#
    .SYNOPSIS
      Re-checkable answer to "is this target root still trusted and writable?".
    .DESCRIPTION
      Runs a process-owned write probe INSIDE the target root (the same operation a
      compile performs), reads the root's effective label, and reports free space.
      Safe to call before every gate: it writes one small evidence file under
      `<target>\.dsh-trust\` and changes nothing else.
    #>
    param(
        [Parameter(Mandatory)][string]$TargetRoot,
        [string]$ParentIntegrity = ''
    )

    if (-not (Test-Path -LiteralPath $TargetRoot -PathType Container)) {
        return [pscustomobject]@{ Available = $false; Writable = $false; EffectiveLabel = 'absent'; ParentLevel = $ParentIntegrity; FreeGiB = $null; ProbePath = $null; Reason = "the target root is absent: $TargetRoot" }
    }

    # FAIL CLOSED on unknown evidence. Trust cannot be inferred from "writable and
    # not Low": an unreadable target label or an unrecognised/unknown parent level
    # must both refuse, with the precise reason named.
    $recognisedLevels = @('untrusted', 'low', 'medium', 'mediumplus', 'high', 'system', 'protected')
    if ($ParentIntegrity) {
        if ($ParentIntegrity -notin $recognisedLevels) {
            return [pscustomobject]@{ Available = $false; Writable = $false; EffectiveLabel = 'unknown'; ParentLevel = $ParentIntegrity; FreeGiB = $null; ProbePath = $null
                Reason = "the caller-supplied parent integrity '$ParentIntegrity' is not a recognised level; refusing unknown visibility" }
        }
        $parent = $ParentIntegrity
    } else {
        $parentEvidence = Get-DshProcessIntegrity -ProcessId $PID
        if (-not $parentEvidence.Known) {
            return [pscustomobject]@{ Available = $false; Writable = $false; EffectiveLabel = 'unknown'; ParentLevel = 'unknown'; FreeGiB = $null; ProbePath = $null
                Reason = "this process's integrity could not be read ($($parentEvidence.Reason)); refusing unknown visibility" }
        }
        $parent = $parentEvidence.Level
    }
    if ($parent -notin $recognisedLevels) {
        return [pscustomobject]@{ Available = $false; Writable = $false; EffectiveLabel = 'unknown'; ParentLevel = $parent; FreeGiB = $null; ProbePath = $null
            Reason = "the observed parent integrity '$parent' is not a recognised level; refusing unknown visibility" }
    }
    $effective = Get-DshEffectiveIntegrity -Path $TargetRoot
    if (-not $effective.Known) {
        return [pscustomobject]@{ Available = $false; Writable = $false; EffectiveLabel = 'unknown'; ParentLevel = $parent; FreeGiB = $null; ProbePath = $null
            Reason = "the target root's label could not be read ($($effective.Reason)); refusing unknown visibility" }
    }
    if ($effective.Enforced -notin $recognisedLevels) {
        return [pscustomobject]@{ Available = $false; Writable = $false; EffectiveLabel = $effective.Enforced; ParentLevel = $parent; FreeGiB = $null; ProbePath = $null
            Reason = "the target root's enforced integrity '$($effective.Enforced)' is not a recognised level; refusing unknown visibility" }
    }

    $probeDir = Join-Path $TargetRoot '.dsh-trust'
    if (-not (Test-Path -LiteralPath $probeDir)) { $null = New-Item -ItemType Directory -Path $probeDir -ErrorAction Stop }
    $probePath = Join-Path $probeDir ('probe-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.txt')
    $writable = $false
    $reason = ''
    try {
        # This write is performed by the CURRENT process, not by a child: it proves
        # only that THIS process can create a file in the target tree. The child-side
        # proof (a real interpreter writing, opening a named pipe and being watched
        # for the watchdog) comes from Test-DshChildPreflight and the toolchain
        # evidence probes, which run separately.
        Set-Content -LiteralPath $probePath -Value 'target-trust-probe' -Encoding Ascii -ErrorAction Stop
        $readBack = (Get-Content -LiteralPath $probePath -Raw).Trim()
        $writable = ($readBack -eq 'target-trust-probe')
        if (-not $writable) { $reason = 'the write probe read back unexpected content' }
    } catch {
        $reason = "the target root refused a write: $($_.Exception.Message)"
    }
    $freeGiB = $null
    try {
        $drive = [System.IO.Path]::GetPathRoot($TargetRoot)
        $freeGiB = [math]::Round((New-Object System.IO.DriveInfo($drive)).AvailableFreeSpace / 1GB, 1)
    } catch { }
    $trusted = $writable -and $effective.Enforced -ne 'low' -and $parent -ne 'low' -and $parent -ne 'untrusted'
    if (-not $trusted -and -not $reason) {
        $reason = "the target root's enforced integrity is $($effective.Enforced) ($($effective.LevelSource)) for a $parent process; a build there is refused. No relabel was attempted."
    }
    Write-Host ("TARGET_TRUST available={0} writable={1} effectiveLabel={2} source={3} parent={4} freeGiB={5} probe={6}" -f `
        $trusted, $writable, $effective.Level, $effective.Source, $parent, $freeGiB, $probePath)
    return [pscustomobject]@{
        Available = $trusted
        Writable = $writable
        EffectiveLabel = $effective.Level
        LabelSource = $effective.Source
        ParentLevel = $parent
        FreeGiB = $freeGiB
        ProbePath = $probePath
        Reason = $reason
    }
}

function New-DshRustCheckpoint {
    <#
    .SYNOPSIS
      Create a fresh checkpoint directory for one serialized cargo gate.
    .DESCRIPTION
      Returns the paths a gate runner should use for its redirected stdout, stderr,
      exit code, environment record and command line. Nothing is deleted: each
      checkpoint is new, so a later gate cannot overwrite an earlier gate's
      evidence.
    #>
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')][string]$Name,
        [string[]]$Command,
        [hashtable]$Environment = @{}
    )

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "The qualification root is absent: $Root" }
    $checkpoints = Join-Path $Root 'checkpoints'
    if (-not (Test-Path -LiteralPath $checkpoints)) { $null = New-Item -ItemType Directory -Path $checkpoints -ErrorAction Stop }
    $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $dir = Join-Path $checkpoints "$Name-$stamp"
    $null = New-Item -ItemType Directory -Path $dir -ErrorAction Stop

    $paths = [pscustomobject]@{
        Name = $Name
        Dir = $dir
        Stdout = Join-Path $dir 'stdout.log'
        Stderr = Join-Path $dir 'stderr.log'
        ExitCode = Join-Path $dir 'exit-code.txt'
        EnvJson = Join-Path $dir 'environment.json'
        CommandTxt = Join-Path $dir 'command.txt'
    }
    if ($Command -and $Command.Count -gt 0) {
        Set-Content -LiteralPath $paths.CommandTxt -Value (ConvertTo-DshNativeArgumentList -Arguments $Command) -Encoding Ascii
    }
    $envRecord = [ordered]@{
        createdUtc = (Get-Date).ToUniversalTime().ToString('o')
        parentIntegrity = (Get-DshProcessIntegrity -ProcessId $PID).Level
        overrides = @{}
    }
    foreach ($key in ($Environment.Keys | Sort-Object)) { $envRecord.overrides[$key] = [string]$Environment[$key] }
    Set-Content -LiteralPath $paths.EnvJson -Value ($envRecord | ConvertTo-Json -Depth 4) -Encoding Ascii
    Write-Host "RUST_CHECKPOINT=$dir"
    return $paths
}

function Get-DshRustPreflightContext {
    <#
    .SYNOPSIS
      One call that returns everything a serialized cargo gate needs: the trusted
      root, the per-child environment, the ready arguments, the toolchain evidence
      and a fresh checkpoint directory.
    .DESCRIPTION
      `Trusted` is the single gate: false means the caller must not run cargo with
      this context. Refusals name every reason. The caller's own environment is
      never modified, so there is nothing to restore and no absent-versus-empty
      question.
    #>
    param(
        [string]$OwnedRoot,
        [int]$Jobs = 1,
        [switch]$KeepDebugInfo,
        [switch]$SkipCopySelfTest,
        [string]$CheckpointName = 'cargo-gate'
    )

    $refusals = @()
    $parent = Get-DshProcessIntegrity -ProcessId $PID
    if (-not $parent.Known) { $refusals += "parent integrity unknown: $($parent.Reason)" }

    if ($OwnedRoot) {
        if (-not (Test-Path -LiteralPath $OwnedRoot -PathType Container)) { throw "The requested owned root is absent: $OwnedRoot" }
        $owned = [pscustomobject]@{
            Root = (Resolve-Path -LiteralPath $OwnedRoot).Path
            Target = Join-Path $OwnedRoot 'target'
            Temp = Join-Path $OwnedRoot 'temp'
            Probe = Join-Path $OwnedRoot 'probe'
            Cargo = Join-Path $OwnedRoot 'cargo'
        }
        foreach ($path in @($owned.Target, $owned.Temp, $owned.Probe, $owned.Cargo)) {
            if (-not (Test-Path -LiteralPath $path)) { $null = New-Item -ItemType Directory -Path $path -ErrorAction Stop }
        }
    } else {
        $owned = New-DshRustQualificationRoot
    }

    $toolchain = Get-DshRustToolchainEvidence -OwnedRoot $owned.Root -ProbeToken
    foreach ($entry in $toolchain.Tools) {
        if (-not $entry.Present) { $refusals += "$($entry.Tool) is not on PATH" ; continue }
        if ($entry.Refusal) { $refusals += "$($entry.Tool): $($entry.Refusal)" }
    }

    $targetTrust = Test-DshRustTargetTrust -TargetRoot $owned.Target -ParentIntegrity $parent.Level
    if (-not $targetTrust.Available) { $refusals += "target root not trusted: $($targetTrust.Reason)" }

    $environment = Get-DshRustChildEnvironment -OwnedRoot $owned.Root
    $cargoArguments = Get-DshRustCargoArguments -Jobs $Jobs -KeepDebugInfo:$KeepDebugInfo -Locked -Offline

    $copySelfTest = $null
    if (-not $SkipCopySelfTest) {
        $portRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
        try { $copySelfTest = Invoke-DshTrustedCopySelfTest -PortRoot $portRoot -ProveNegativeControl }
        catch { $refusals += "copy self-test failed: $($_.Exception.Message)" }
    }

    $checkpoint = New-DshRustCheckpoint -Root $owned.Root -Name $CheckpointName -Environment $environment

    $context = [pscustomobject]@{
        Trusted = ($refusals.Count -eq 0)
        Refusals = $refusals
        Root = $owned.Root
        Target = $owned.Target
        Temp = $owned.Temp
        Probe = $owned.Probe
        Environment = $environment
        CargoArguments = $cargoArguments
        ParentIntegrity = $parent
        Toolchain = $toolchain
        TargetTrust = $targetTrust
        CopySelfTest = $copySelfTest
        Checkpoint = $checkpoint
        CreatedUtc = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-Host ("RUST_PREFLIGHT_CONTEXT trusted={0} refusals={1} root={2} checkpoint={3}" -f $context.Trusted, $refusals.Count, $owned.Root, $checkpoint.Dir)
    return $context
}

function Resolve-DshTrustedExecutionNode {
    <#
    .SYNOPSIS
      Resolve the interpreter that will EXECUTE a staging program, with the SAME
      checks on both the default (fresh outside copy) and the explicit-override path.
    .DESCRIPTION
      A caller-supplied `-AttestedPath` previously only had its label read, so an
      arbitrary interpreter could be executed with none of the guarantees the default
      path had. Both paths now require, in this order:

        1. the staged executable's image evidence (path, SHA-256, label) and this
           process's integrity are KNOWN - an unknown parent or unreadable image is
           refused, never assumed;
        2. the candidate is BYTE-IDENTICAL to the staged executable (which is the
           archive-pinned interpreter), so the executed interpreter cannot differ
           from the one the payload is built from;
        3. its `--version` prints exactly `v<pinned version>` from the source pin
           (`installer/node-runtime.json`, cross-checked with the packaged
           `runtime-payload.json` when present);
        4. it is not a Low image under a Medium parent (no relabel is ever done);
        5. it runs the REAL child preflight - process-owned write, process-sentinel,
           named pipe and watchdog - from a FRESH owned root, and that root and its
           temp are what the caller receives.

      The default path satisfies (2) by copying the staged bytes into the owned root
      and re-hashing the copy; the override path must supply bytes that already
      match. Both then run (3), (4) and (5) identically.
    #>
    param(
        [Parameter(Mandatory)][string]$StagedExecutable,
        [Parameter(Mandatory)][string]$PinManifestPath,
        [string]$AttestedPath,
        [string]$RequestedRoot,
        [int]$VersionProbeSeconds = 120
    )

    # --- 1. evidence of the reference (the staged, archive-pinned interpreter) ---
    $parent = Get-DshProcessIntegrity -ProcessId $PID
    if (-not $parent.Known) { throw "REFUSED_UNKNOWN_VISIBILITY: this process's integrity could not be read ($($parent.Reason)); refusing to resolve an execution interpreter." }
    $staged = Get-DshImageEvidence -Path $StagedExecutable
    if (-not $staged.Sha256) { throw "The staged interpreter's digest could not be established: $StagedExecutable" }
    $stagedLabel = Get-DshFileIntegrityLabel -Path $staged.Path
    if (-not $stagedLabel.Known) { throw "The staged interpreter's label could not be read ($($stagedLabel.Reason)); refusing unknown image evidence." }

    if (-not (Test-Path -LiteralPath $PinManifestPath -PathType Leaf)) { throw "The Node pin manifest is absent: $PinManifestPath" }
    $pin = Get-Content -LiteralPath $PinManifestPath -Raw | ConvertFrom-Json
    $expectedVersion = [string]$pin.nodeVersion
    if ([string]::IsNullOrWhiteSpace($expectedVersion)) { throw "The Node pin manifest declares no nodeVersion: $PinManifestPath" }

    # --- 2-4. candidate selection, then the checks applied to BOTH paths ---------
    $root = $null
    $temp = $null
    $source = ''
    if ($AttestedPath) {
        $candidate = Get-DshImageEvidence -Path $AttestedPath
        if ($candidate.Sha256 -ne $staged.Sha256) {
            throw "The explicitly attested interpreter is NOT byte-identical to the archive-pinned staged interpreter: $($candidate.Sha256) vs $($staged.Sha256). Compute the digest from the pinned archive; a different interpreter is never executed."
        }
        $candidateLabel = Get-DshEffectiveIntegrity -Path $candidate.Path
        if (-not $candidateLabel.Known) { throw "The explicitly attested interpreter's effective label could not be read: $($candidateLabel.Reason)" }
        if ($candidateLabel.Enforced -eq 'low' -and $parent.Level -eq 'medium') {
            throw "The explicitly attested interpreter '$($candidate.Path)' is Low integrity ($($candidateLabel.LevelSource)) while this process is $($parent.Level). No relabel was attempted."
        }
        # A FRESH owned root is still required: the preflight needs an owned temp and
        # the caller must receive real Root/Temp/Preflight values, not nulls.
        $root = if ($RequestedRoot) {
            if (-not (Test-Path -LiteralPath $RequestedRoot -PathType Container)) { throw "The requested trusted execution root is absent: $RequestedRoot" }
            (Resolve-Path -LiteralPath $RequestedRoot).Path
        } else { New-DshQualificationRoot -Prefix 'runtimenode' }
        $candidatePath = $candidate.Path
        $source = 'attested'
        $candidateHash = $candidate.Sha256
    } else {
        $root = if ($RequestedRoot) {
            if (-not (Test-Path -LiteralPath $RequestedRoot -PathType Container)) { throw "The requested trusted execution root is absent: $RequestedRoot" }
            (Resolve-Path -LiteralPath $RequestedRoot).Path
        } else { New-DshQualificationRoot -Prefix 'runtimenode' }
        $destination = Join-Path $root 'exec'
        if (-not (Test-Path -LiteralPath $destination)) { $null = New-Item -ItemType Directory -Path $destination -ErrorAction Stop }
        $copy = Copy-DshTrustedPlainCopy -SourceRoot (Split-Path -Parent $staged.Path) -DestinationRoot $destination `
            -RelativePaths @((Split-Path -Leaf $staged.Path)) -ParentIntegrity $parent.Level
        $candidatePath = $copy.Files[0]
        $candidateHash = (Get-FileHash -LiteralPath $candidatePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($candidateHash -ne $staged.Sha256) {
            throw "The trusted execution copy is not byte-identical to the pinned interpreter: $candidateHash vs $($staged.Sha256)"
        }
        $copyEffective = Get-DshEffectiveIntegrity -Path $candidatePath
        if (-not $copyEffective.Known) { throw "The trusted execution copy's label could not be read: $($copyEffective.Reason)" }
        if ($copyEffective.Enforced -eq 'low' -and $parent.Level -eq 'medium') {
            throw "The trusted execution copy is still Low integrity ($($copyEffective.LevelSource)); the execution root must be outside the labelled workspace. No relabel was attempted."
        }
        $source = 'fresh-outside-copy'
    }

    $temp = Join-Path $root 'temp'
    if (-not (Test-Path -LiteralPath $temp)) { $null = New-Item -ItemType Directory -Path $temp -ErrorAction Stop }

    # --- 3. version, on the ACTUAL candidate, with the child's real token --------
    $childEnvironment = @{ TEMP = $temp; TMP = $temp; TMPDIR = $temp }
    $versionProbe = Invoke-DshOwnedChild -FilePath $candidatePath -Arguments @('--version') `
        -WorkingDirectory $root -Environment $childEnvironment -TimeoutSeconds $VersionProbeSeconds
    if (-not $versionProbe.ChildTokenKnown) {
        throw "REFUSED_UNKNOWN_VISIBILITY: the candidate interpreter's child token could not be read ($($versionProbe.ChildTokenReason))."
    }
    if ($versionProbe.ExitCode -ne 0) {
        throw "The candidate interpreter failed '--version' with exit code $($versionProbe.ExitCode): $($versionProbe.StandardError)"
    }
    $observedVersion = $versionProbe.StandardOutput.Trim()
    if ($observedVersion -ne "v$expectedVersion") {
        throw "The candidate interpreter reports '$observedVersion', not the pinned 'v$expectedVersion' ($PinManifestPath). Refusing it."
    }

    # --- 5. the real child preflight, from this fresh owned root -----------------
    $preflight = Test-DshChildPreflight -NodePath $candidatePath -OwnedRoot $root
    Write-Host "TRUSTED_NODE_EXECUTION=ok source=$source candidate=$candidatePath sha256=$candidateHash version=$observedVersion root=$root temp=$temp preflight=write+pipe+sentinel+watchdog"
    return [pscustomobject]@{
        Path = $candidatePath
        Root = $root
        Temp = $temp
        Sha256 = $candidateHash
        Version = $observedVersion
        Source = $source
        Attested = [bool]$AttestedPath
        StagedPath = $staged.Path
        StagedSha256 = $staged.Sha256
        StagedLabel = $stagedLabel.Level
        ParentIntegrity = $parent.Level
        ChildToken = $versionProbe.ChildTokenLevel
        Preflight = $preflight
    }
}

function Invoke-DshTrustedCopySelfTest {
    <#
    .SYNOPSIS
      Exercise Copy-DshTrustedPlainCopy on a scoped owned fixture (never the whole
      checkout) and prove hash equality, path containment/bounds and the label.
    .DESCRIPTION
      Three real files are copied from `port/tests/packaging` into an owned root.
      Each destination is re-hashed against its source, its containment and length
      are asserted, and the destination label is read. With
      `-ProveNegativeControl`, one more copy is attempted into the workspace's
      scratch tree: because that tree is Low-labelled, the guard must REFUSE it,
      which proves the label check is not vacuous rather than merely asserted.
    #>
    param([Parameter(Mandatory)][string]$PortRoot, [switch]$ProveNegativeControl)

    $parent = Get-DshProcessIntegrity -ProcessId $PID
    if (-not $parent.Known) { throw "Parent integrity is unknown ($($parent.Reason)); refusing an unproven copy self-test." }
    $sourceRoot = Join-Path $PortRoot 'tests\packaging'
    $members = @('native-quoting.psm1', 'suite-result.psm1', 'nsis\process-probe.nsi')
    foreach ($member in $members) {
        if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $member) -PathType Leaf)) {
            throw "Copy self-test member is absent: $member"
        }
    }

    $root = New-DshQualificationRoot -Prefix 'copyselftest'
    $destination = Join-Path $root 'copy'
    $null = New-Item -ItemType Directory -Path $destination -ErrorAction Stop
    $copied = Copy-DshTrustedPlainCopy -SourceRoot $sourceRoot -DestinationRoot $destination `
        -RelativePaths $members -ParentIntegrity $parent.Level

    foreach ($member in $members) {
        $source = Join-Path $sourceRoot $member
        $target = Join-Path $destination $member
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Copied member is missing: $member" }
        $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
        $targetHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
        if ($sourceHash -ne $targetHash) { throw "Copied member differs from its source: $member" }
        if (-not $target.StartsWith($destination + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Copied member escaped its owned destination: $target"
        }
        if ($target.Length -gt 240) { throw "Copied member path is over the bound: $target" }
    }
    $label = Get-DshFileIntegrityLabel -Path (Join-Path $destination $members[0])
    if (-not $label.Known) { throw "Copied member label could not be read: $($label.Reason)" }
    if ($label.Level -eq 'low' -and $parent.Level -eq 'medium') {
        throw "Copied member landed at Low while the parent is Medium: $($label.Sid)"
    }
    Write-Host "COPY_SELFTEST=ok files=$($copied.Count) root=$root label=$($label.Level) parent=$($parent.Level) hash=equal paths=contained"

    $negative = $null
    $negativeReason = ''
    $negativeGuard = ''
    $lowDestination = $null
    if ($ProveNegativeControl) {
        $lowDestination = Join-Path $PortRoot ('.scratch\copyselftest-low-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        $null = New-Item -ItemType Directory -Path $lowDestination -ErrorAction Stop
        $observedLabel = Get-DshFileIntegrityLabel -Path $lowDestination
        try {
            $null = Copy-DshTrustedPlainCopy -SourceRoot $sourceRoot -DestinationRoot $lowDestination `
                -RelativePaths @($members[0]) -ParentIntegrity $parent.Level
            $negative = 'NOT-REFUSED'
            Write-Host "COPY_SELFTEST_NEGATIVE=NOT-REFUSED destination=$lowDestination label=$($observedLabel.Level)" -ForegroundColor Yellow
        } catch {
            $negative = 'refused'
            $negativeReason = $_.Exception.Message
            # Report WHICH guard refused. The checkout on this host sits under a
            # OneDrive reparse point, so the reparse guard can fire before the label
            # guard; claiming the label guard was proven when it was not would be a
            # false green.
            $negativeGuard = if ($negativeReason -match 'Low integrity') { 'label-guard' }
                elseif ($negativeReason -match 'reparse point') { 'reparse-guard' }
                else { 'other-guard' }
            Write-Host "COPY_SELFTEST_NEGATIVE=refused guard=$negativeGuard label=$($observedLabel.Level) reason=$negativeReason"
        }
        Write-Host "COPY_SELFTEST_NEGATIVE_DIR=$lowDestination (retained as evidence)"
        if ($negativeGuard -ne 'label-guard') {
            Write-Host 'COPY_SELFTEST_NOTE=the label guard itself was NOT exercised by this control (the workspace refused first for an independent reason); it is verified by source inspection only on this host.' -ForegroundColor DarkYellow
        }
    }

    return [pscustomobject]@{
        Root = $root
        Files = $copied.Count
        Label = $label.Level
        ParentIntegrity = $parent.Level
        HashEqual = $true
        NegativeControl = $negative
        NegativeGuard = $negativeGuard
        NegativeReason = $negativeReason
        NegativeDirectory = $lowDestination
    }
}

Export-ModuleMember -Function New-DshRustQualificationRoot, Get-DshImageEvidence,
    Invoke-DshOwnedChild, Get-DshRustToolchainEvidence, Get-DshRustChildEnvironment,
    Get-DshRustCargoArguments, Test-DshRustArtifactTrust, Invoke-DshTrustedCopySelfTest,
    Test-DshRustTargetTrust, New-DshRustCheckpoint, Get-DshRustPreflightContext,
    Resolve-DshTrustedExecutionNode
