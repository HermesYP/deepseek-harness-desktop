# Self-contained pinned Node.js runtime provisioning.
#
# Why this exists (finding F-20, and the P9 note in docs/verification-report.md):
# the application defaults `DSH_DESKTOP_NODE` to the bare string `node`, i.e. a
# system Node.js resolved from PATH. That is an explicit prerequisite today, so
# the installer is not self-contained and a machine without Node gets an
# application that installs, launches, and then dies at host preflight.
#
# Two rules this module enforces, both aimed at the failure mode where a build
# silently packages whatever happened to be on the build machine:
#
#   1. Pinned explicit inputs. The Node version and the SHA-256 of the exact
#      archive are declared in `node-runtime.json`, under source control. A
#      build never infers either from `node --version`.
#   2. Authoritative checksum verification. The downloaded (or locally supplied)
#      archive is hashed and compared to the pinned digest BEFORE anything is
#      extracted. A mismatch is a hard failure, never a warning: an unverified
#      Node binary shipped inside an installer is indistinguishable from a
#      trojaned one.
#
# When the pinned archive is not present locally and no network is available,
# the stage fails with an actionable message rather than falling back to the
# system `node.exe`. There is deliberately NO development fallback to a system
# Node.js: such a path would produce a payload that boots on the build machine and
# nowhere else, and its only observable difference would be an easily-missed
# warning. A build either ships the pinned interpreter or fails.

Set-StrictMode -Version Latest

# The engine range the pinned interpreter must satisfy.
#
# `node-runtime.json` declares `enginesRange` and `_upstream/package.json` declares
# the same constraint, but nothing read the field: only `schemaVersion`,
# `nodeVersion`, `license` and `targets` were validated. A future edit pinning,
# say, 20.x would therefore pass every check and ship an interpreter the Rust
# prerequisite gate refuses, so the pin is validated against the range HERE and a
# mismatch is a hard failure.
function Assert-DshPinnedNodeVersionSupported {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$NodeVersion,
        [string]$EnginesRange,
        [string]$ManifestPath
    )

    if ([string]::IsNullOrWhiteSpace($EnginesRange)) {
        throw "Pinned Node manifest $ManifestPath declares no enginesRange; refusing to ship a pin whose supported range is unstated."
    }

    $match = [regex]::Match($NodeVersion, '^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$')
    if (-not $match.Success) {
        throw "Pinned Node version '$NodeVersion' is not a plain major.minor.patch version."
    }
    $major = [int]$match.Groups['major'].Value
    $minor = [int]$match.Groups['minor'].Value

    # The range is a disjunction of `^x.y.z` / `>=x.y.z` clauses, which is the
    # shape npm and upstream both use. Only the clauses that actually appear are
    # honoured, and an unparseable clause is an error rather than a silent pass -
    # a range this function cannot read must never read as "everything is fine".
    $satisfied = $false
    $clauses = @($EnginesRange -split '\|\|' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    if ($clauses.Count -eq 0) {
        throw "Pinned Node manifest $ManifestPath declares an empty enginesRange."
    }
    foreach ($clause in $clauses) {
        $caret = [regex]::Match($clause, '^\^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$')
        if ($caret.Success) {
            # `^A.B.C` means >= A.B.C AND < (A+1).0.0. Bounding the upper end is
            # the whole point: without it a `^22.19.0 || >=24.0.0` range would
            # also admit 23.x, which satisfies neither clause.
            $caretMajor = [int]$caret.Groups['major'].Value
            $caretMinor = [int]$caret.Groups['minor'].Value
            if ($major -eq $caretMajor -and $minor -ge $caretMinor) { $satisfied = $true }
            continue
        }
        $atLeast = [regex]::Match($clause, '^>=(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$')
        if ($atLeast.Success) {
            if ($major -ge [int]$atLeast.Groups['major'].Value) { $satisfied = $true }
            continue
        }
        $exact = [regex]::Match($clause, '^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$')
        if ($exact.Success) {
            if ($major -eq [int]$exact.Groups['major'].Value -and $minor -eq [int]$exact.Groups['minor'].Value) { $satisfied = $true }
            continue
        }
        throw "Pinned Node manifest $ManifestPath declares enginesRange clause '$clause', which this validator cannot evaluate. Refusing to assume the pin is supported."
    }

    if (-not $satisfied) {
        throw "Pinned Node $NodeVersion is outside the supported range '$EnginesRange' declared by $ManifestPath. The Rust prerequisite gate would refuse this interpreter at run time; refusing to package it."
    }
}

function Get-DshPinnedNodeManifest {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ManifestPath)

    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        throw "Pinned Node manifest is missing: $ManifestPath"
    }
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    foreach ($field in @('schemaVersion', 'nodeVersion', 'license', 'targets')) {
        if ($null -eq $manifest.$field) {
            throw "Pinned Node manifest $ManifestPath is missing required field '$field'."
        }
    }
    if ($manifest.schemaVersion -ne 1) {
        throw "Pinned Node manifest $ManifestPath declares unsupported schemaVersion $($manifest.schemaVersion)."
    }
    Assert-DshPinnedNodeVersionSupported -NodeVersion ([string]$manifest.nodeVersion) `
        -EnginesRange ([string]$manifest.enginesRange) -ManifestPath $ManifestPath
    return $manifest
}

function Get-DshPinnedNodeTarget {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Manifest,
        [Parameter(Mandatory)][string]$Target
    )

    $entry = $null
    $known = @()
    # `$Manifest.targets` is a PSCustomObject once ConvertFrom-Json has run, so a
    # missing key raises a property-not-found error rather than returning null.
    # Enumerate the real names first, so an unknown target reports what IS
    # available instead of surfacing a PowerShell reflection error.
    if ($null -ne $Manifest.targets) {
        $known = @($Manifest.targets.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
        $match = $known | Where-Object { $_ -eq $Target } | Select-Object -First 1
        if ($match) { $entry = $Manifest.targets.$match }
    }
    if ($null -eq $entry) {
        throw "Pinned Node manifest has no entry for target '$Target'. Known targets: $($known -join ', ')."
    }
    foreach ($field in @('url', 'sha256', 'archiveRoot', 'executable')) {
        if ([string]::IsNullOrWhiteSpace([string]$entry.$field)) {
            throw "Pinned Node target '$Target' is missing required field '$field'."
        }
    }
    if ($entry.sha256 -notmatch '^[0-9a-f]{64}$') {
        throw "Pinned Node target '$Target' has a malformed sha256 '$($entry.sha256)'; expected 64 lowercase hex characters."
    }
    return $entry
}

function Get-DshFileSha256 {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# Acquire the pinned archive from any of the approved sources, then verify it.
#
# Source order:
#   1. `-ArchivePath` supplied by the caller (an offline provisioned copy).
#   2. A copy already in the local archive cache, keyed by digest.
#   3. HTTPS download of the pinned URL.
#
# Every source goes through the same digest check, so a poisoned cache or a
# substituted local file is caught exactly like a bad download.
function Get-DshPinnedNodeArchive {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Manifest,
        [Parameter(Mandatory)]$Target,
        [Parameter(Mandatory)][string]$TargetName,
        [Parameter(Mandatory)][string]$CacheRoot,
        [string]$ArchivePath,
        [switch]$AllowDownload
    )

    $expected = $Target.sha256.ToLowerInvariant()
    $fileName = Split-Path -Leaf ([uri]$Target.url).AbsolutePath
    $cachePath = Join-Path $CacheRoot $fileName

    if (-not (Test-Path -LiteralPath $CacheRoot)) {
        $null = New-Item -ItemType Directory -Force -Path $CacheRoot
    }

    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($ArchivePath)) {
        if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
            throw "Supplied Node archive does not exist: $ArchivePath"
        }
        $candidates += [pscustomobject]@{ Source = 'supplied'; Path = (Resolve-Path -LiteralPath $ArchivePath).Path }
    }
    if (Test-Path -LiteralPath $cachePath -PathType Leaf) {
        $candidates += [pscustomobject]@{ Source = 'cache'; Path = $cachePath }
    }

    foreach ($candidate in $candidates) {
        $actual = Get-DshFileSha256 -Path $candidate.Path
        if ($actual -eq $expected) {
            Write-Host "    pinned Node $($Manifest.nodeVersion) for $TargetName verified from $($candidate.Source) ($actual)" -ForegroundColor DarkGray
            return [pscustomobject]@{ Path = $candidate.Path; Sha256 = $actual; NodeVersion = $Manifest.nodeVersion; Target = $TargetName; Source = $candidate.Source }
        }
        if ($candidate.Source -eq 'supplied') {
            throw "Supplied Node archive $($candidate.Path) has sha256 $actual, expected $expected. Refusing to package an unverified interpreter."
        }
        Write-Warning "Cached Node archive $cachePath has sha256 $actual, expected $expected; discarding it and re-fetching."
        Remove-Item -LiteralPath $cachePath -Force
    }

    if (-not $AllowDownload) {
        throw "Pinned Node $($Manifest.nodeVersion) for $TargetName is not available locally and download is disabled. Place the archive at $cachePath (sha256 $expected) or pass -ArchivePath. The build never falls back to a system Node.js."
    }

    $partial = "$cachePath.partial"
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
    Write-Host "    downloading $($Target.url)" -ForegroundColor DarkGray
    try {
        # Invoke-WebRequest is the only TLS-validating HTTP client guaranteed on
        # both Windows PowerShell 5.1 and PowerShell 7.
        $previous = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        try {
            Invoke-WebRequest -Uri $Target.url -OutFile $partial -UseBasicParsing -ErrorAction Stop
        } finally {
            $ProgressPreference = $previous
        }
    } catch {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
        throw "Downloading the pinned Node archive from $($Target.url) failed: $($_.Exception.Message). The build refuses to substitute a system Node.js."
    }

    $actual = Get-DshFileSha256 -Path $partial
    if ($actual -ne $expected) {
        Remove-Item -LiteralPath $partial -Force
        throw "Downloaded Node archive has sha256 $actual, expected $expected. Refusing to package an unverified interpreter."
    }
    Move-Item -LiteralPath $partial -Destination $cachePath -Force
    Write-Host "    pinned Node $($Manifest.nodeVersion) for $TargetName verified from download ($actual)" -ForegroundColor DarkGray
    return [pscustomobject]@{ Path = $cachePath; Sha256 = $actual; NodeVersion = $Manifest.nodeVersion; Target = $TargetName; Source = 'download' }
}

# Extract the verified archive into a staging tree and assert the interpreter is
# really there. Extraction happens only after verification.
function Expand-DshPinnedNode {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ArchivePath,
        [Parameter(Mandatory)]$Target,
        [Parameter(Mandatory)][string]$Destination
    )

    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    $null = New-Item -ItemType Directory -Force -Path $Destination

    # The archive is a .zip for Windows and a .tar.gz for macOS/Linux. Both are
    # expanded with a tool present on the host rather than a PowerShell module,
    # so a locked-down agent host still builds.
    $suffix = [System.IO.Path]::GetExtension($ArchivePath).ToLowerInvariant()
    if ($suffix -eq '.zip') {
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $Destination -Force
    } elseif ($ArchivePath.ToLowerInvariant().EndsWith('.tar.gz') -or $ArchivePath.ToLowerInvariant().EndsWith('.tgz')) {
        $tar = Get-Command tar -ErrorAction SilentlyContinue
        if ($null -eq $tar) {
            throw "Extracting $ArchivePath requires 'tar', which was not found on PATH."
        }
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & $tar.Source -xzf $ArchivePath -C $Destination
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previous
        }
        if ($exitCode -ne 0) { throw "tar -xzf $ArchivePath failed with exit code $exitCode." }
    } else {
        throw "Unsupported pinned Node archive format: $ArchivePath"
    }

    # The upstream archives wrap everything in one versioned directory
    # (`node-v25.4.0-win-x64/`); `archiveRoot` pins that name so a layout change
    # is a manifest edit rather than a silent mis-stage.
    $root = Join-Path $Destination $Target.archiveRoot
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        $found = @(Get-ChildItem -LiteralPath $Destination -Directory | ForEach-Object { $_.Name })
        throw "Pinned Node archive did not contain the declared archiveRoot '$($Target.archiveRoot)'. Found: $($found -join ', ')."
    }

    $executable = Join-Path $root $Target.executable
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw "Pinned Node archive did not contain '$($Target.executable)' under $root."
    }

    return [pscustomobject]@{ Root = $root; Executable = $executable }
}

# Run the staged interpreter and assert it reports the pinned version. This is
# the check that distinguishes "the bytes were pinned" from "the bytes work":
# a correct digest for a wrong-architecture archive still hashes correctly.
function Assert-DshNodeVersion {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string]$ExpectedVersion
    )

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # Consume native output completely before selecting the version line.
        # Select-Object -First in the native pipeline can terminate the process
        # early on Windows PowerShell, leaving a spurious exit code of -1.
        $outputLines = @(& $Executable '--version' 2>&1)
        $exitCode = $LASTEXITCODE
        $reported = $outputLines | Select-Object -First 1
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($exitCode -ne 0) {
        throw "The staged Node interpreter $Executable failed '--version' with exit code ${exitCode}: $reported"
    }
    $normalized = "$reported".Trim().TrimStart('v')
    if ($normalized -ne $ExpectedVersion.TrimStart('v')) {
        throw "The staged Node interpreter $Executable reports v$normalized, but the manifest pins $ExpectedVersion."
    }
    return $normalized
}

# The per-target staging entry point. Returns the staged layout the caller
# publishes, plus the identity record that must accompany it.
function Install-DshPinnedNode {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ManifestPath,
        [Parameter(Mandatory)][string]$TargetName,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][string]$CacheRoot,
        [Parameter(Mandatory)][string]$LicenseDestination,
        [string]$ArchivePath,
        [switch]$AllowDownload
    )

    $manifest = Get-DshPinnedNodeManifest -ManifestPath $ManifestPath
    $target = Get-DshPinnedNodeTarget -Manifest $manifest -Target $TargetName
    $archive = Get-DshPinnedNodeArchive -Manifest $manifest -Target $target -TargetName $TargetName `
        -CacheRoot $CacheRoot -ArchivePath $ArchivePath -AllowDownload:$AllowDownload
    $expanded = Expand-DshPinnedNode -ArchivePath $archive.Path -Target $target -Destination $Destination
    $version = Assert-DshNodeVersion -Executable $expanded.Executable -ExpectedVersion $manifest.nodeVersion

    # Licenses travel with the binary. Node.js is MIT-licensed and the archive
    # the digest covers includes the license text; copying it into the payload
    # is what makes the pinned identity inspectable after installation.
    $licenseSource = Join-Path $expanded.Root $manifest.license.file
    if (-not (Test-Path -LiteralPath $licenseSource -PathType Leaf)) {
        throw "Pinned Node archive did not contain the declared license file '$($manifest.license.file)'. Refusing to publish an interpreter without its license text."
    }
    if (-not (Test-Path -LiteralPath $LicenseDestination)) {
        $null = New-Item -ItemType Directory -Force -Path $LicenseDestination
    }
    Copy-Item -LiteralPath $licenseSource -Destination (Join-Path $LicenseDestination $manifest.license.destination) -Force

    return [pscustomobject]@{
        NodeVersion  = $version
        Target       = $TargetName
        Url          = $target.url
        Sha256       = $archive.Sha256
        Source       = $archive.Source
        Root         = $expanded.Root
        Executable   = $expanded.Executable
        RelativeExecutable = $target.executable
        License      = $manifest.license.destination
        LicenseSpdx  = $manifest.license.spdx
    }
}

Export-ModuleMember -Function @(
    'Get-DshPinnedNodeManifest'
    'Assert-DshPinnedNodeVersionSupported'
    'Get-DshPinnedNodeTarget'
    'Get-DshFileSha256'
    'Get-DshPinnedNodeArchive'
    'Expand-DshPinnedNode'
    'Assert-DshNodeVersion'
    'Install-DshPinnedNode'
)
