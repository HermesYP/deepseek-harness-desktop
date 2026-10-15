<#
.SYNOPSIS
  Trusted esbuild compiler for the RUNTIME staging child.

.DESCRIPTION
  `port/scripts/lib/runtime-payload.psm1` loads upstream TypeScript through
  `--import tsx/esm`, so the staging child runs tsx's own esbuild. The UI stage
  uses a different esbuild release (whatever `apps/web`'s Vite resolves), so one
  process-wide ESBUILD_BINARY_PATH cannot serve both: pointing the staging child
  at the UI compiler makes tsx abort with

      Cannot start service: Host version "0.28.1" does not match binary version "0.25.12"

  This module derives the compiler the checkout's tsx ACTUALLY resolves and
  produces a byte-identical Medium execution copy of it outside the labelled
  tree, so a normal build needs no manual environment.

  The version is resolved through tsx's OWN dependency link -- never by matching
  tsx's declared range. tsx declares a range such as `~0.28.0`, and a store can
  hold several releases that satisfy it (0.28.1 and 0.28.2 both occur), so a
  range match is ambiguous. The resolved link names exactly one release.

  Usage from `build.ps1`:
    $runtimeEsbuild = Resolve-DshTrustedRuntimeEsbuild -UpstreamRoot $Upstream
    $env:ESBUILD_BINARY_PATH = $runtimeEsbuild.Path   # restored in the caller's finally

  No ACL, integrity label or ownership of any existing file is changed; the copy
  is created fresh inside an owned root outside the labelled workspace.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command -Name 'Get-DshProcessIntegrity' -ErrorAction SilentlyContinue)) {
    Import-Module (Join-Path $PSScriptRoot 'qualification-preflight.psm1') -Global -ErrorAction Stop
}
if (-not (Get-Command -Name 'Invoke-DshOwnedChild' -ErrorAction SilentlyContinue)) {
    Import-Module (Join-Path $PSScriptRoot 'rust-qualification.psm1') -Global -ErrorAction Stop
}

function Get-DshTsxEsbuildResolution {
    <#
    .SYNOPSIS
      The esbuild release the checkout's tsx dependency actually resolves.
    .DESCRIPTION
      Read through tsx's own `node_modules/esbuild` link. Range matching is
      deliberately not used: tsx declares a tilde range that several installed
      releases satisfy, which is ambiguous. Every installed tsx must agree on one
      version, otherwise the checkout is refused rather than guessed at.
    #>
    param(
        [Parameter(Mandatory)][string]$UpstreamRoot
    )

    $store = Join-Path $UpstreamRoot 'node_modules\.pnpm'
    if (-not (Test-Path -LiteralPath $store -PathType Container)) {
        throw "The pnpm store is absent: $store"
    }
    $linked = @()
    foreach ($directory in Get-ChildItem -LiteralPath $store -Directory -Filter 'tsx@*') {
        $manifestPath = Join-Path $directory.FullName 'node_modules\esbuild\package.json'
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { continue }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ($manifest.name -ne 'esbuild' -or -not $manifest.version) {
            throw "The tsx dependency link at $manifestPath is not an esbuild manifest."
        }
        $linked += [pscustomobject]@{
            Tsx = $directory.Name
            Version = [string]$manifest.version
            ManifestPath = $manifestPath
        }
    }
    if ($linked.Count -eq 0) {
        throw "No installed tsx declares a resolved esbuild dependency under $store; the runtime stage cannot know which compiler its loader uses."
    }
    $versions = @($linked | ForEach-Object { $_.Version } | Sort-Object -Unique)
    if ($versions.Count -ne 1) {
        $detail = ($linked | ForEach-Object { "$($_.Tsx)=$($_.Version)" }) -join ', '
        throw "Installed tsx packages disagree on their resolved esbuild version ($detail); refusing to guess the runtime compiler."
    }
    return [pscustomobject]@{
        Version = $versions[0]
        Tsx = ($linked | ForEach-Object { $_.Tsx }) -join ', '
        ManifestPath = $linked[0].ManifestPath
    }
}

function Get-DshRuntimeEsbuildReference {
    <#
    .SYNOPSIS
      The installed win32-x64 package for the esbuild release tsx resolves.
    #>
    param(
        [Parameter(Mandatory)][string]$UpstreamRoot
    )

    $resolution = Get-DshTsxEsbuildResolution -UpstreamRoot $UpstreamRoot
    $packageRoot = Join-Path $UpstreamRoot "node_modules\.pnpm\@esbuild+win32-x64@$($resolution.Version)\node_modules\@esbuild\win32-x64"
    if (-not (Test-Path -LiteralPath $packageRoot -PathType Container)) {
        throw "The resolved tsx esbuild package directory is absent: $packageRoot (tsx resolves esbuild $($resolution.Version))."
    }
    $manifestPath = Join-Path $packageRoot 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "The resolved esbuild package manifest is absent: $manifestPath"
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.name -ne '@esbuild/win32-x64') {
        throw "Unexpected esbuild package name '$($manifest.name)' at $packageRoot"
    }
    if ([string]$manifest.version -ne $resolution.Version) {
        throw "The resolved esbuild package declares version '$($manifest.version)', not '$($resolution.Version)'."
    }
    $executable = Join-Path $packageRoot 'esbuild.exe'
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw "The resolved esbuild executable is absent: $executable"
    }
    $item = Get-Item -LiteralPath $executable -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "The resolved esbuild executable is a reparse point: $executable"
    }
    return [pscustomobject]@{
        PackageRoot = $packageRoot
        Executable = $executable
        Version = $resolution.Version
        Tsx = $resolution.Tsx
        Bytes = $item.Length
        Sha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

function Resolve-DshTrustedRuntimeEsbuild {
    <#
    .SYNOPSIS
      A Medium, byte-identical execution copy of the runtime loader's esbuild.
    .DESCRIPTION
      Without -OverridePath the compiler is copied out of the resolved tsx
      dependency package. With -OverridePath the supplied file must be a regular
      non-link file whose bytes are IDENTICAL to that resolved reference: an
      override selects where the same compiler comes from, it never selects a
      different compiler.
    .PARAMETER UpstreamRoot
      The upstream checkout the runtime stages from.
    .PARAMETER RequestedRoot
      An existing owned root to copy into. Omitted, a fresh qualification root
      outside the labelled workspace is created.
    .PARAMETER OverridePath
      An optional byte-identical source for the same compiler.
    #>
    param(
        [Parameter(Mandatory)][string]$UpstreamRoot,
        [string]$RequestedRoot,
        [string]$OverridePath
    )

    $parent = Get-DshProcessIntegrity -ProcessId $PID
    if (-not $parent.Known) { throw "REFUSED_UNKNOWN_VISIBILITY: this process's integrity could not be read ($($parent.Reason))." }

    $reference = Get-DshRuntimeEsbuildReference -UpstreamRoot $UpstreamRoot
    $root = if ($RequestedRoot) {
        if (-not (Test-Path -LiteralPath $RequestedRoot -PathType Container)) { throw "The requested owned root is absent: $RequestedRoot" }
        (Resolve-Path -LiteralPath $RequestedRoot).Path
    } else {
        New-DshQualificationRoot -Prefix 'runesbuild'
    }
    $destination = Join-Path $root 'runtime-esbuild'
    if (-not (Test-Path -LiteralPath $destination)) { $null = New-Item -ItemType Directory -Path $destination -ErrorAction Stop }
    $temp = Join-Path $root 'temp'
    if (-not (Test-Path -LiteralPath $temp)) { $null = New-Item -ItemType Directory -Path $temp -ErrorAction Stop }

    $copyRoot = $reference.PackageRoot
    $copyNames = @('esbuild.exe')
    $sourceDescription = "resolved-tsx-dependency:$($reference.Version)"
    if ($OverridePath) {
        $override = Get-Item -LiteralPath $OverridePath -Force -ErrorAction Stop
        if ($override.PSIsContainer) { throw "The -RuntimeEsbuildPath override is a directory, not a compiler: $OverridePath" }
        if (($override.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "The -RuntimeEsbuildPath override is a reparse point: $OverridePath"
        }
        # Check the bytes BEFORE copying so a substituted compiler is named cheaply.
        $overrideSha = (Get-FileHash -LiteralPath $OverridePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($overrideSha -ne $reference.Sha256) {
            throw "The -RuntimeEsbuildPath override is not the compiler this checkout's tsx resolves (expected esbuild $($reference.Version), sha256 $($reference.Sha256); found sha256 $overrideSha). Refusing a substituted compiler."
        }
        $copyRoot = $override.DirectoryName
        $copyNames = @($override.Name)
        $sourceDescription = "override-byte-identical"
    }

    $copy = Copy-DshTrustedPlainCopy -SourceRoot $copyRoot -DestinationRoot $destination `
        -RelativePaths $copyNames -ParentIntegrity $parent.Level
    $copiedExe = $copy.Files[0]
    $afterSha = (Get-FileHash -LiteralPath $copiedExe -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($afterSha -ne $reference.Sha256) {
        throw "The trusted runtime esbuild copy is not byte-identical: $afterSha vs $($reference.Sha256)"
    }
    $copyLabel = Get-DshEffectiveIntegrity -Path $copiedExe
    if (-not $copyLabel.Known) { throw "The runtime esbuild copy's label could not be read: $($copyLabel.Reason)" }
    if ($copyLabel.Enforced -eq 'low' -and $parent.Level -eq 'medium') {
        throw "The runtime esbuild execution copy is still Low integrity ($($copyLabel.LevelSource)); the owned root must be outside the labelled tree. No relabel was attempted."
    }

    $childEnvironment = @{ TEMP = $temp; TMP = $temp; TMPDIR = $temp; ESBUILD_BINARY_PATH = $copiedExe }
    $probe = Invoke-DshOwnedChild -FilePath $copiedExe -Arguments @('--version') -WorkingDirectory $root `
        -Environment $childEnvironment -TimeoutSeconds 60
    if (-not $probe.ChildTokenKnown) { throw "REFUSED_UNKNOWN_VISIBILITY: the runtime esbuild child token could not be read ($($probe.ChildTokenReason))." }
    if ($probe.ExitCode -ne 0) { throw "The runtime esbuild copy failed '--version' with exit $($probe.ExitCode): $($probe.StandardError)" }
    $observed = $probe.StandardOutput.Trim()
    if ($observed -ne $reference.Version) {
        throw "The runtime esbuild copy reports '$observed', not the resolved '$($reference.Version)'."
    }
    if ($probe.ChildTokenLevel -eq 'low') {
        throw "The runtime esbuild child runs at Low integrity ($($probe.ChildTokenSid)); it cannot remove the staging temp files."
    }

    Write-Host ("TRUSTED_RUNTIME_ESBUILD=ok copy={0} sha256={1} version={2} source={3} copyLabel={4} childToken={5} temp={6}" -f `
        $copiedExe, $afterSha, $observed, $sourceDescription, $copyLabel.Enforced, $probe.ChildTokenLevel, $temp)
    return [pscustomobject]@{
        Path = $copiedExe
        Root = $root
        Temp = $temp
        Sha256 = $afterSha
        ReferenceSha256 = $reference.Sha256
        Version = $observed
        Tsx = $reference.Tsx
        Source = $sourceDescription
        CopyLabel = $copyLabel.Enforced
        ChildToken = $probe.ChildTokenLevel
        Environment = $childEnvironment
    }
}

Export-ModuleMember -Function Get-DshTsxEsbuildResolution, Get-DshRuntimeEsbuildReference,
    Resolve-DshTrustedRuntimeEsbuild
