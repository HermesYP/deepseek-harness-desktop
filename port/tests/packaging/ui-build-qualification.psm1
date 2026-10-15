# Qualified UI production build: a trusted esbuild image, a pinned Node and an
# outside owned output root, then an atomic publication of the result.
#
# WHY THIS MODULE EXISTS
#   The UI build failed with `REMOVE Temp/esbuild-... AccessDenied`: Vite spawns
#   esbuild, the located `esbuild.exe` lives under `_upstream/node_modules/.pnpm/...`
#   where its image is Low-labelled, and a Low child cannot delete the
#   Medium-owned temp file Vite asked it to remove. Relabelling anything is not an
#   option, so the qualified build instead:
#
#     * resolves the LOCKED esbuild binary narrowly, by its exact `.pnpm`
#       `@esbuild+win32-x64@<version>` directory (three versions coexist in this
#       checkout, so a glob would be a silent version substitution), and checks the
#       package's own declared version;
#     * copies those bytes (never a link, never a hardlink) into an outside owned
#       root through `Copy-DshTrustedPlainCopy`, so the copy is Medium, and asserts
#       the SHA-256 BEFORE and AFTER the copy plus a real child `--version` and the
#       child's actual token;
#     * runs Vite with the pinned payload Node resolved through the shared trusted
#       resolver - never a system `node`/`pnpm`;
#     * passes `ESBUILD_BINARY_PATH`, `TEMP` and `TMP` PER CHILD on the child's own
#       ProcessStartInfo, so the caller's environment is never modified and there is
#       nothing to restore;
#     * writes into a FRESH owned output root and refuses to report success without
#       numeric, artifact-level evidence.
#
# WHY THE OUTPUT ROOT IS OWNED AND FRESH, AND WHY PUBLICATION IS A SEPARATE STEP
#   Two integration defects are fixed here, both behavioural rather than textual.
#
#   (1) `port/ui/dist` is an EXISTING, non-empty, tracked-output directory. Passing
#       it as the Vite output root failed the fresh-output guard, so the advertised
#       `-Stage ui` could not run at all; and the guard itself only rejected a
#       non-empty directory, so an existing EMPTY directory, a plain FILE or a
#       reparse point at the output leaf was accepted and Vite was then run with
#       `--emptyOutDir` against it. The build now writes into a FRESH path that is
#       canonically contained in an explicitly fenced owned root (known integrity,
#       outside the labelled tree, no linked ancestors) and refuses ANY existing
#       entry at that leaf. Vite never runs anywhere else.
#
#   (2) The validated tree is then published to the normal `dist` by the existing
#       `publish.psm1` machinery: a sibling staging tree, `Publish-DshStagedTree`
#       (rename the current tree to `<dist>.previous`, then rename the stage into
#       place), re-validation of the PUBLISHED tree, and `Restore-DshPublishedTree`
#       rollback on failure. The previous tree is RETAINED - this module never calls
#       `Complete-DshPublishedTree`, and a backup left by an earlier run is moved
#       aside under a unique name instead of being deleted. Nothing is ever removed
#       in place.
#
# WHY A FRESH CHECKOUT CAN BUILD
#   `-Stage ui` precedes `-Stage runtime` in the default all-stage order, so on a
#   fresh checkout `runtime-payload/dsh/node/node.exe` does not exist yet. The
#   reference interpreter is then the PINNED archive extracted into this run's owned
#   root through `node-runtime.psm1` (`Install-DshPinnedNode`: digest verified
#   against `installer/node-runtime.json` before extraction, version asserted on the
#   extracted bytes). There is no system `node`/`pnpm` fallback on any path: if the
#   payload is absent and no verified archive is available, the build fails with
#   guidance naming the archive it needs.
#
# No relabel, no ACL change, no upstream write, no new dependency, no application
# launch. Pure ASCII; Windows PowerShell 5.1 and 7 compatible.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command -Name 'Copy-DshTrustedPlainCopy' -ErrorAction SilentlyContinue)) {
    Import-Module (Join-Path $PSScriptRoot 'qualification-preflight.psm1') -Global -ErrorAction Stop
}
if (-not (Get-Command -Name 'Resolve-DshTrustedExecutionNode' -ErrorAction SilentlyContinue)) {
    Import-Module (Join-Path $PSScriptRoot 'rust-qualification.psm1') -Global -ErrorAction Stop
}
if (-not (Get-Command -Name 'Publish-DshStagedTree' -ErrorAction SilentlyContinue)) {
    Import-Module (Join-Path $PSScriptRoot '..\..\scripts\lib\publish.psm1') -Global -ErrorAction Stop
}
if (-not (Get-Command -Name 'Install-DshPinnedNode' -ErrorAction SilentlyContinue)) {
    Import-Module (Join-Path $PSScriptRoot '..\..\scripts\lib\node-runtime.psm1') -Global -ErrorAction Stop
}

# The compiler the target's OWN Web build resolves. This is not the root
# lockfile's newest esbuild: `apps/web` declares `vite: ^6.4.3`, the linked
# `vite@6.4.3` declares `esbuild: ^0.25.0`, and exactly one installed
# `@esbuild/win32-x64` version (0.25.12) satisfies that range.
# `Get-DshUpstreamEsbuildVersion` re-derives this from the linked Vite package on
# every use and refuses a disagreement, so a stale literal cannot pick a
# different compiler than the build actually runs on.
$script:DefaultEsbuildVersion = '0.25.12'

function Test-DshEsbuildVersionSatisfies {
    <#
    .SYNOPSIS
      Whether an exact esbuild version satisfies a declared range.
    .DESCRIPTION
      Supports the exact, caret and tilde forms the workspace uses. Any other
      syntax is refused rather than approximated: a guessed comparison could accept
      the wrong compiler, which is the failure this check exists to prevent.
    #>
    param(
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$Range
    )

    $parts = $Version.Split('-')[0].Split('.')
    if ($parts.Count -ne 3) { return $false }
    $major = 0; $minor = 0; $patch = 0
    if (-not [int]::TryParse($parts[0], [ref]$major)) { return $false }
    if (-not [int]::TryParse($parts[1], [ref]$minor)) { return $false }
    if (-not [int]::TryParse($parts[2], [ref]$patch)) { return $false }

    $text = $Range.Trim()
    if ($text -match '^\^(\d+)\.(\d+)\.(\d+)$') {
        $rMajor = [int]$Matches[1]; $rMinor = [int]$Matches[2]; $rPatch = [int]$Matches[3]
        if ($major -ne $rMajor) { return $false }
        if ($rMajor -gt 0) {
            if ($minor -ne $rMinor) { return $minor -gt $rMinor }
            return $patch -ge $rPatch
        }
        # Caret below 1.0.0 pins the leftmost non-zero position.
        if ($rMinor -gt 0) { return ($minor -eq $rMinor) -and ($patch -ge $rPatch) }
        return ($minor -eq 0) -and ($patch -eq $rPatch)
    }
    if ($text -match '^~(\d+)\.(\d+)\.(\d+)$') {
        return ($major -eq [int]$Matches[1]) -and ($minor -eq [int]$Matches[2]) -and ($patch -ge [int]$Matches[3])
    }
    if ($text -match '^(\d+)\.(\d+)\.(\d+)$') {
        return ($major -eq [int]$Matches[1]) -and ($minor -eq [int]$Matches[2]) -and ($patch -eq [int]$Matches[3])
    }
    throw "Unsupported esbuild range '$Range'; refusing to guess whether a compiler satisfies it."
}

function Get-DshUpstreamEsbuildVersion {
    <#
    .SYNOPSIS
      The unique esbuild version the linked `apps/web` Vite resolves.
    .DESCRIPTION
      `apps/web` owns its own Vite, which is not the root lockfile's newest Vite.
      The linked Vite package declares an esbuild range; the installed
      `@esbuild/win32-x64` directories are the candidates. Exactly one candidate
      must satisfy the range, otherwise the compiler is ambiguous and the caller is
      refused instead of being handed a guessed one.
    #>
    param(
        [Parameter(Mandatory)][string]$UpstreamRoot
    )

    $viteManifestPath = Join-Path $UpstreamRoot 'apps\web\node_modules\vite\package.json'
    if (-not (Test-Path -LiteralPath $viteManifestPath -PathType Leaf)) {
        throw "The linked apps/web Vite manifest is absent: $viteManifestPath. Link the toolchain first (port/ui/link-toolchain.ps1)."
    }
    $vite = Get-Content -LiteralPath $viteManifestPath -Raw | ConvertFrom-Json
    $range = [string]$vite.dependencies.esbuild
    if (-not $range) {
        throw "The linked apps/web Vite $($vite.version) declares no esbuild dependency; refusing to guess the compiler."
    }
    $store = Join-Path $UpstreamRoot 'node_modules\.pnpm'
    if (-not (Test-Path -LiteralPath $store -PathType Container)) {
        throw "The pnpm store is absent: $store"
    }
    $satisfying = @()
    foreach ($dir in Get-ChildItem -LiteralPath $store -Directory -Filter '@esbuild+win32-x64@*') {
        $candidate = $dir.Name.Substring('@esbuild+win32-x64@'.Length).Split('_')[0]
        if (Test-DshEsbuildVersionSatisfies -Version $candidate -Range $range) { $satisfying += $candidate }
    }
    if ($satisfying.Count -ne 1) {
        throw "The linked apps/web Vite $($vite.version) declares esbuild '$range' and $($satisfying.Count) installed @esbuild/win32-x64 versions satisfy it ($($satisfying -join ', ')); exactly one reviewed compiler is required. Clean the toolchain link and re-run link-toolchain.ps1."
    }
    return $satisfying[0]
}

function Test-DshPathContained {
    <#
    .SYNOPSIS
      True when -Path is -Root or lies strictly below it, compared canonically.
    .DESCRIPTION
      A prefix test alone is not containment: `C:\a` must not match `C:\ab`. The
      comparison is therefore made against the root PLUS a separator, and the
      caller resolves both sides before calling so a `..` segment cannot smuggle a
      path out of the fence.
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Root,
        [switch]$AllowEqual
    )

    $candidate = $Path.TrimEnd('\', '/')
    $scope = $Root.TrimEnd('\', '/')
    if ([string]::Equals($candidate, $scope, [System.StringComparison]::OrdinalIgnoreCase)) {
        return [bool]$AllowEqual
    }
    if ($candidate.StartsWith("$scope\", [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($candidate.StartsWith("$scope/", [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $false
}

function Assert-DshUiOwnedRootFence {
    <#
    .SYNOPSIS
      The explicit fence a build output root must satisfy before Vite writes to it.
    .DESCRIPTION
      Refuses, in this order: an absent root, a non-directory, a reparse point, a
      path traversing a linked ancestor, unknown visibility, a Low root under a
      Medium parent (no relabel is ever attempted), and a root inside the labelled
      upstream tree. Returns the canonical (resolved) path so every later
      containment test compares real paths rather than caller spelling.
    #>
    param(
        [Parameter(Mandatory)][string]$OwnedRoot,
        [string]$UpstreamRoot
    )

    $item = Get-Item -LiteralPath $OwnedRoot -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { throw "The owned build root is absent: $OwnedRoot (it is never created implicitly from the workspace)." }
    if (-not $item.PSIsContainer) { throw "The owned build root is not a directory: $OwnedRoot" }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "The owned build root is a reparse point: $OwnedRoot"
    }
    Assert-DshNoLinkedAncestors -Path $OwnedRoot

    $parent = Get-DshProcessIntegrity -ProcessId $PID
    if (-not $parent.Known) { throw "REFUSED_UNKNOWN_VISIBILITY: this process's integrity could not be read ($($parent.Reason))." }
    $canonical = (Resolve-Path -LiteralPath $OwnedRoot).Path
    $label = Get-DshEffectiveIntegrity -Path $canonical
    if (-not $label.Known) { throw "The owned build root's label could not be read ($($label.Reason)); refusing unknown visibility." }
    if ($label.Enforced -eq 'low' -and $parent.Level -eq 'medium') {
        throw "The owned build root is Low integrity ($($label.LevelSource)) while this process is $($parent.Level); the build root must be outside the labelled tree. No relabel was attempted: $canonical"
    }

    if ($UpstreamRoot) {
        $upstreamItem = Get-Item -LiteralPath $UpstreamRoot -Force -ErrorAction SilentlyContinue
        if ($null -ne $upstreamItem -and $upstreamItem.PSIsContainer) {
            $canonicalUpstream = (Resolve-Path -LiteralPath $UpstreamRoot).Path
            if (Test-DshPathContained -Path $canonical -Root $canonicalUpstream -AllowEqual) {
                throw "The owned build root is inside the labelled upstream tree: $canonical"
            }
        }
    }

    Write-Host "UI_BUILD_OWNED_ROOT=$canonical label=$($label.Enforced) parent=$($parent.Level)"
    return $canonical
}

function Get-DshUiNodeTargetName {
    <#
    .SYNOPSIS
      The pinned-Node target name for this host, never a PATH lookup.
    #>
    $architecture = $env:PROCESSOR_ARCHITECTURE
    if ($architecture -eq 'x86' -and $env:PROCESSOR_ARCHITEW6432) { $architecture = $env:PROCESSOR_ARCHITEW6432 }
    if ($env:OS -eq 'Windows_NT') {
        if ($architecture -eq 'ARM64') { return 'win-arm64' }
        return 'win-x64'
    }
    if ("$env:OSTYPE" -match 'darwin') {
        if ($architecture -eq 'arm64') { return 'darwin-arm64' }
        return 'darwin-x64'
    }
    if ($architecture -eq 'aarch64') { return 'linux-arm64' }
    return 'linux-x64'
}

function Get-DshLockedEsbuildBinary {
    <#
    .SYNOPSIS
      Resolve the locked `@esbuild/win32-x64` binary by its EXACT version directory.
    .DESCRIPTION
      Three `@esbuild+win32-x64@*` directories exist in this checkout (0.21.5,
      0.25.12, 0.28.1). Resolving by glob would silently pick a different compiler,
      so the directory name is constructed from the expected version and the
      package's own `package.json` must agree.
    #>
    param(
        [Parameter(Mandatory)][string]$UpstreamRoot,
        [string]$ExpectedVersion = $script:DefaultEsbuildVersion
    )

    $pnpmName = "@esbuild+win32-x64@$ExpectedVersion"
    $packageRoot = Join-Path $UpstreamRoot "node_modules\.pnpm\$pnpmName\node_modules\@esbuild\win32-x64"
    if (-not (Test-Path -LiteralPath $packageRoot -PathType Container)) {
        throw "The locked esbuild package directory is absent: $packageRoot (expected version $ExpectedVersion)"
    }
    $manifestPath = Join-Path $packageRoot 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "The esbuild package manifest is absent: $manifestPath"
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.name -ne '@esbuild/win32-x64') { throw "Unexpected esbuild package name '$($manifest.name)' at $packageRoot" }
    if ([string]$manifest.version -ne $ExpectedVersion) {
        throw "The locked esbuild package declares version '$($manifest.version)', not '$ExpectedVersion'; refusing a substituted compiler."
    }
    # Cross-check the recorded version against the compiler the linked apps/web
    # Vite actually resolves, so this literal cannot silently rot into a
    # different compiler than the build runs on.
    $derived = Get-DshUpstreamEsbuildVersion -UpstreamRoot $UpstreamRoot
    if ($derived -ne $ExpectedVersion) {
        throw "The recorded esbuild version '$ExpectedVersion' is not the one the linked apps/web Vite resolves ('$derived'); update the recorded version deliberately rather than staging a compiler the build does not use."
    }
    $executable = Join-Path $packageRoot 'esbuild.exe'
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "The esbuild executable is absent: $executable" }
    $item = Get-Item -LiteralPath $executable -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "The locked esbuild executable is a reparse point: $executable" }
    $sha = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host "LOCKED_ESBUILD=$executable version=$($manifest.version) bytes=$($item.Length) sha256=$sha"
    return [pscustomobject]@{
        Executable = $executable
        Version = [string]$manifest.version
        PackageRoot = $packageRoot
        Bytes = $item.Length
        Sha256 = $sha
    }
}

function Resolve-DshTrustedEsbuild {
    <#
    .SYNOPSIS
      A Medium, byte-identical execution copy of the locked esbuild compiler.
    #>
    param(
        [Parameter(Mandatory)][string]$UpstreamRoot,
        [string]$ExpectedVersion = $script:DefaultEsbuildVersion,
        [string]$RequestedRoot
    )

    $parent = Get-DshProcessIntegrity -ProcessId $PID
    if (-not $parent.Known) { throw "REFUSED_UNKNOWN_VISIBILITY: this process's integrity could not be read ($($parent.Reason))." }

    $locked = Get-DshLockedEsbuildBinary -UpstreamRoot $UpstreamRoot -ExpectedVersion $ExpectedVersion
    $root = if ($RequestedRoot) {
        if (-not (Test-Path -LiteralPath $RequestedRoot -PathType Container)) { throw "The requested owned root is absent: $RequestedRoot" }
        (Resolve-Path -LiteralPath $RequestedRoot).Path
    } else { New-DshQualificationRoot -Prefix 'uibuild' }
    $destination = Join-Path $root 'esbuild'
    if (-not (Test-Path -LiteralPath $destination)) { $null = New-Item -ItemType Directory -Path $destination -ErrorAction Stop }
    $temp = Join-Path $root 'temp'
    if (-not (Test-Path -LiteralPath $temp)) { $null = New-Item -ItemType Directory -Path $temp -ErrorAction Stop }

    $copy = Copy-DshTrustedPlainCopy -SourceRoot $locked.PackageRoot -DestinationRoot $destination `
        -RelativePaths @('esbuild.exe') -ParentIntegrity $parent.Level
    $copiedExe = $copy.Files[0]
    $afterSha = (Get-FileHash -LiteralPath $copiedExe -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($afterSha -ne $locked.Sha256) {
        throw "The trusted esbuild copy is not byte-identical: $afterSha vs $($locked.Sha256)"
    }
    $copyLabel = Get-DshEffectiveIntegrity -Path $copiedExe
    if (-not $copyLabel.Known) { throw "The esbuild copy's label could not be read: $($copyLabel.Reason)" }
    if ($copyLabel.Enforced -eq 'low' -and $parent.Level -eq 'medium') {
        throw "The esbuild execution copy is still Low integrity ($($copyLabel.LevelSource)); the execution root must be outside the labelled tree. No relabel was attempted."
    }

    $childEnvironment = @{ TEMP = $temp; TMP = $temp; TMPDIR = $temp; ESBUILD_BINARY_PATH = $copiedExe }
    $probe = Invoke-DshOwnedChild -FilePath $copiedExe -Arguments @('--version') -WorkingDirectory $root `
        -Environment $childEnvironment -TimeoutSeconds 60
    if (-not $probe.ChildTokenKnown) { throw "REFUSED_UNKNOWN_VISIBILITY: the esbuild child token could not be read ($($probe.ChildTokenReason))." }
    if ($probe.ExitCode -ne 0) { throw "The esbuild copy failed '--version' with exit $($probe.ExitCode): $($probe.StandardError)" }
    $observed = $probe.StandardOutput.Trim()
    if ($observed -ne $locked.Version) { throw "The esbuild copy reports '$observed', not the locked '$($locked.Version)'." }
    if ($probe.ChildTokenLevel -eq 'low') { throw "The esbuild child runs at Low integrity ($($probe.ChildTokenSid)); it cannot remove Vite's Medium temp files." }

    Write-Host ("TRUSTED_ESBUILD=ok copy={0} sha256={1} version={2} copyLabel={3} childToken={4} temp={5}" -f `
        $copiedExe, $afterSha, $observed, $copyLabel.Enforced, $probe.ChildTokenLevel, $temp)
    return [pscustomobject]@{
        Path = $copiedExe
        Root = $root
        Temp = $temp
        Sha256 = $afterSha
        SourceSha256 = $locked.Sha256
        Version = $observed
        CopyLabel = $copyLabel.Enforced
        ChildToken = $probe.ChildTokenLevel
        Environment = $childEnvironment
    }
}

function Resolve-DshQualifiedUiNode {
    <#
    .SYNOPSIS
      The trusted interpreter that EXECUTES the UI build, with an explicit
      pinned-archive fallback for a fresh checkout.
    .DESCRIPTION
      The reference interpreter is the archive-pinned staged payload interpreter
      (`runtime-payload/dsh/node/node.exe`) when it exists. When it does not - the
      normal state on a fresh checkout, because `-Stage ui` runs before
      `-Stage runtime` - the PINNED archive is acquired through `node-runtime.psm1`
      (digest checked against `installer/node-runtime.json` before extraction),
      extracted into this run's owned root, and its bytes become the reference.

      Both cases then go through the shared `Resolve-DshTrustedExecutionNode`, so an
      optional `-StagedNodeExecutable` must be BYTE-IDENTICAL to the reference and
      print the pinned version on a real child, and the executed interpreter is
      either that attested file or a fresh Medium copy outside the labelled tree.
      A system `node`/`pnpm` is never used on any path: with the payload absent and
      no verified archive available, this throws with the archive guidance.
    #>
    param(
        [Parameter(Mandatory)][string]$PortRoot,
        [Parameter(Mandatory)][string]$OwnedRoot,
        [string]$PayloadNodePath,
        [string]$StagedNodeExecutable,
        [string]$NodeArchivePath,
        [string]$NodeArchiveCacheRoot,
        [switch]$AllowNodeDownload
    )

    $pinPath = Join-Path $PortRoot 'installer\node-runtime.json'
    if (-not (Test-Path -LiteralPath $pinPath -PathType Leaf)) { throw "The Node pin manifest is absent: $pinPath" }

    $payload = if ($PayloadNodePath) { $PayloadNodePath } else { Join-Path $PortRoot 'runtime-payload\dsh\node\node.exe' }
    $reference = $null
    $referenceSource = ''
    if (Test-Path -LiteralPath $payload -PathType Leaf) {
        $reference = $payload
        $referenceSource = 'staged-payload'
    } else {
        if (-not (Get-Command -Name 'Install-DshPinnedNode' -ErrorAction SilentlyContinue)) {
            Import-Module (Join-Path $PSScriptRoot '..\..\scripts\lib\node-runtime.psm1') -Global -ErrorAction Stop
        }
        $cacheRoot = if ($NodeArchiveCacheRoot) { $NodeArchiveCacheRoot } else { Join-Path $PortRoot '.scratch\node-cache' }
        $suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
        $licenseDestination = Join-Path $OwnedRoot "node-licenses-$suffix"
        $archive = Install-DshPinnedNode -ManifestPath $pinPath -TargetName (Get-DshUiNodeTargetName) `
            -Destination (Join-Path $OwnedRoot "node-$suffix") -CacheRoot $cacheRoot `
            -LicenseDestination $licenseDestination -ArchivePath $NodeArchivePath -AllowDownload:$AllowNodeDownload
        $reference = $archive.Executable
        $referenceSource = "pinned-archive:$($archive.Source)"
        Write-Host "UI_BUILD_NODE_REFERENCE=$reference source=$referenceSource sha256=$($archive.Sha256) version=$($archive.NodeVersion)"
    }

    if (-not $reference) {
        throw "No pinned Node interpreter reference could be established; the UI build never substitutes a system Node.js."
    }

    $executionRoot = Join-Path $OwnedRoot 'node-exec'
    if (-not (Test-Path -LiteralPath $executionRoot -PathType Container)) {
        $null = New-Item -ItemType Directory -Path $executionRoot -ErrorAction Stop
    }
    $node = Resolve-DshTrustedExecutionNode -StagedExecutable $reference -PinManifestPath $pinPath `
        -AttestedPath $StagedNodeExecutable -RequestedRoot $executionRoot
    Write-Host "UI_BUILD_NODE=ok reference=$reference source=$referenceSource executed=$($node.Path) version=$($node.Version) sha256=$($node.Sha256) token=$($node.ChildToken)"
    return $node
}

function Assert-DshUiBuildArtifacts {
    <#
    .SYNOPSIS
      Artifact-level proof that a production UI build really produced its output.
    #>
    param(
        [Parameter(Mandatory)][string]$OutDir,
        [int]$MinAssets = 1,
        [int]$MinFiles = 10
    )

    if (-not (Test-Path -LiteralPath $OutDir -PathType Container)) { throw "The build produced no output directory: $OutDir" }
    $index = Join-Path $OutDir 'index.html'
    if (-not (Test-Path -LiteralPath $index -PathType Leaf)) { throw "The build produced no index.html under $OutDir" }
    $policy = @(Get-ChildItem -LiteralPath $OutDir -Recurse -File -Filter '*policy-bootstrap*' -ErrorAction SilentlyContinue)
    if ($policy.Count -eq 0) { throw "The build produced no desktop policy bootstrap asset under $OutDir" }
    $assetsDir = Join-Path $OutDir 'assets'
    if (-not (Test-Path -LiteralPath $assetsDir -PathType Container)) { throw "The build produced no assets directory under $OutDir" }
    $assets = @(Get-ChildItem -LiteralPath $assetsDir -File -ErrorAction Stop)
    if ($assets.Count -lt $MinAssets) { throw "The build produced $($assets.Count) asset file(s); at least $MinAssets are required." }
    $all = @(Get-ChildItem -LiteralPath $OutDir -Recurse -File -ErrorAction Stop)
    if ($all.Count -lt $MinFiles) { throw "The build produced $($all.Count) file(s); at least $MinFiles are required." }
    $bytes = ($all | Measure-Object -Property Length -Sum).Sum
    Write-Host ("UI_BUILD_ARTIFACTS=outDir={0} files={1} assets={2} bytes={3} indexHtml=1 policyBootstrap={4}" -f `
        $OutDir, $all.Count, $assets.Count, $bytes, $policy.Count)
    return [pscustomobject]@{
        OutDir = $OutDir
        Files = $all.Count
        Assets = $assets.Count
        Bytes = $bytes
        IndexHtml = $index
        PolicyBootstrap = $policy[0].FullName
    }
}

function Publish-DshUiBuildTree {
    <#
    .SYNOPSIS
      Publish a fresh, validated UI build tree to the normal output path.
    .DESCRIPTION
      Uses the shared `publish.psm1` sequence: a sibling staging tree on the same
      volume, `Publish-DshStagedTree` (current tree renamed to `<target>.previous`,
      then the stage renamed into place), re-validation of the PUBLISHED tree, and
      `Restore-DshPublishedTree` rollback when re-validation fails. The previous
      tree is RETAINED: `Complete-DshPublishedTree` is deliberately never called,
      and a backup already left by an earlier run is moved aside under a unique name
      rather than deleted, so the step is repeatable and destroys no original.
    #>
    param(
        [Parameter(Mandatory)][string]$FreshPath,
        [Parameter(Mandatory)][string]$PublishedPath,
        [int]$MinAssets = 1,
        [int]$MinFiles = 10
    )

    if (-not (Test-Path -LiteralPath $FreshPath -PathType Container)) { throw "Nothing to publish: the fresh build tree is absent: $FreshPath" }

    $targetParent = Split-Path -Parent $PublishedPath
    if (-not $targetParent) { throw "The published path has no parent directory: $PublishedPath" }
    if (-not (Test-Path -LiteralPath $targetParent -PathType Container)) { throw "The published path's parent directory is absent: $targetParent" }
    # NOTE ON THE LINK CHECK. Only the DIRECTORY itself is checked here, not its
    # ancestors. The publication target is the caller's own output tree, and on a
    # redirected profile that tree legitimately has reparse-point ancestors (a
    # OneDrive-redirected `Dokumen` above the checkout), which an ancestor walk
    # refuses - and Vite never runs at this path, so the Low-image/temp hazard the
    # ancestor fence exists for does not apply to the swap. What WOULD be unsafe is
    # a link AT the parent or AT the target leaf, because the rename would then
    # write through it; both are refused below and in the leaf check.
    $targetParentItem = Get-Item -LiteralPath $targetParent -Force -ErrorAction Stop
    if (-not $targetParentItem.PSIsContainer) { throw "The published path's parent is not a directory: $targetParent" }
    if (($targetParentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "The published path's parent directory is a reparse point: $targetParent"
    }
    $canonicalParent = (Resolve-Path -LiteralPath $targetParent).Path
    $target = Join-Path $canonicalParent (Split-Path -Leaf $PublishedPath)
    $fresh = (Resolve-Path -LiteralPath $FreshPath).Path
    if ([string]::Equals($fresh, $target, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "The fresh build tree and the publication target are the same directory: $target"
    }
    if ((Test-DshPathContained -Path $fresh -Root $target) -or (Test-DshPathContained -Path $target -Root $fresh)) {
        throw "Refusing to publish: the fresh build tree and the publication target are nested in one another ($fresh vs $target)."
    }
    $targetItem = Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    if ($null -ne $targetItem) {
        if (-not $targetItem.PSIsContainer) { throw "The publication target exists and is not a directory: $target" }
        if (($targetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "The publication target is a reparse point: $target"
        }
    }

    # Validate the source tree before anything is staged or moved.
    $freshArtifacts = Assert-DshUiBuildArtifacts -OutDir $fresh -MinAssets $MinAssets -MinFiles $MinFiles

    $leaf = Split-Path -Leaf $target
    $stageName = "$leaf.s-" + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $stage = New-DshStageRoot -PublishedPath $target -Name $stageName
    foreach ($entry in (Get-ChildItem -LiteralPath $fresh -Force -ErrorAction Stop)) {
        Copy-Item -LiteralPath $entry.FullName -Destination $stage -Recurse -Force -ErrorAction Stop
    }
    $stagedArtifacts = Assert-DshUiBuildArtifacts -OutDir $stage -MinAssets $MinAssets -MinFiles $MinFiles
    if ($stagedArtifacts.Files -ne $freshArtifacts.Files -or $stagedArtifacts.Assets -ne $freshArtifacts.Assets) {
        throw "The staged tree does not match the fresh tree: staged files=$($stagedArtifacts.Files) assets=$($stagedArtifacts.Assets) vs fresh files=$($freshArtifacts.Files) assets=$($freshArtifacts.Assets)"
    }

    # Retain, never delete, a backup left by an earlier publication.
    $retained = @()
    $previous = "$target.previous"
    if (Test-Path -LiteralPath $previous) {
        $archived = "$previous-" + [guid]::NewGuid().ToString('N').Substring(0, 8)
        if (Test-Path -LiteralPath $archived) { throw "Retained backup path already exists: $archived" }
        Rename-Item -LiteralPath $previous -NewName (Split-Path -Leaf $archived) -ErrorAction Stop
        $retained += $archived
        Write-Host "UI_BUILD_RETAINED_BACKUP=$archived"
    }

    $publication = Publish-DshStagedTree -StagedPath $stage -PublishedPath $target
    try {
        $publishedArtifacts = Assert-DshUiBuildArtifacts -OutDir $target -MinAssets $MinAssets -MinFiles $MinFiles
        if ($publishedArtifacts.Files -ne $freshArtifacts.Files) {
            throw "The published tree has $($publishedArtifacts.Files) file(s) but the fresh tree had $($freshArtifacts.Files); the swap did not preserve the tree."
        }
    } catch {
        $restored = Restore-DshPublishedTree -PublishedPath $target
        if ($restored) { throw "Publication failed and the previous tree was restored: $($_.Exception.Message)" }
        throw "Publication failed and there was no previous tree to restore: $($_.Exception.Message)"
    }
    Write-Host "UI_BUILD_PUBLISHED=$target files=$($publishedArtifacts.Files) assets=$($publishedArtifacts.Assets) bytes=$($publishedArtifacts.Bytes) previous=$($publication.PreviousPath)"

    return [pscustomobject]@{
        PublishedPath = $target
        StagePath = $stage
        FreshPath = $fresh
        PreviousPath = $publication.PreviousPath
        RetainedBackups = @($retained)
        Files = $publishedArtifacts.Files
        Assets = $publishedArtifacts.Assets
        Bytes = $publishedArtifacts.Bytes
        IndexHtml = $publishedArtifacts.IndexHtml
        PolicyBootstrap = $publishedArtifacts.PolicyBootstrap
    }
}

function Invoke-DshQualifiedNodeScript {
    <#
    .SYNOPSIS
      Run a Node script with the pinned interpreter and a PER-CHILD environment.
    .DESCRIPTION
      The child's `TEMP`/`TMP`/`TMPDIR` are the owned root's temp and `PATH` starts
      with the pinned interpreter's directory, all applied on the child's own
      `ProcessStartInfo`: the caller's environment is never modified, so there is
      nothing to restore and the absent-versus-empty question cannot arise. Never a
      system `node` from PATH.
    #>
    param(
        [Parameter(Mandatory)][string]$NodePath,
        [Parameter(Mandatory)][string]$ScriptPath,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [AllowEmptyCollection()][string[]]$Arguments = @(),
        [string]$TempRoot,
        [int]$TimeoutSeconds = 900
    )

    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "The qualified interpreter is absent: $NodePath" }
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) { throw "The Node script is absent: $ScriptPath" }
    $nodePath = (Resolve-Path -LiteralPath $NodePath).Path
    $environment = @{}
    if ($TempRoot) {
        if (-not (Test-Path -LiteralPath $TempRoot -PathType Container)) { throw "The qualified temp root is absent: $TempRoot" }
        $environment['TEMP'] = $TempRoot
        $environment['TMP'] = $TempRoot
        $environment['TMPDIR'] = $TempRoot
    }
    $environment['PATH'] = (Split-Path -Parent $nodePath) + [IO.Path]::PathSeparator + $env:PATH

    $arguments = @($ScriptPath) + @($Arguments)
    Write-Host "QUALIFIED_NODE_SCRIPT=$nodePath $($arguments -join ' ')" -ForegroundColor DarkGray
    $run = Invoke-DshOwnedChild -FilePath $nodePath -Arguments $arguments -WorkingDirectory $WorkingDirectory `
        -Environment $environment -TimeoutSeconds $TimeoutSeconds
    if (-not $run.ChildTokenKnown) { throw "REFUSED_UNKNOWN_VISIBILITY: the Node script child token could not be read ($($run.ChildTokenReason))." }
    if ($run.StandardOutput) { Write-Host $run.StandardOutput }
    if ($run.StandardError) { Write-Host $run.StandardError -ForegroundColor DarkYellow }
    if ($run.ExitCode -ne 0) {
        throw "The Node script $ScriptPath failed with exit $($run.ExitCode)."
    }
    return $run
}

function Invoke-DshQualifiedUiBuild {
    <#
    .SYNOPSIS
      Run a real Vite production build with the pinned Node and the trusted esbuild.
    .DESCRIPTION
      Vite writes ONLY into a fresh path that is canonically contained in the
      explicitly fenced owned root; the child gets a per-child
      `ESBUILD_BINARY_PATH` pointing at the Medium copy, a per-child `TEMP`/`TMP`
      inside the owned root, and a PATH whose first entry is the pinned
      interpreter's directory. Nothing is written to the caller's environment and
      nothing under `_upstream` is modified.

      `-OutDir` is the FINAL output path. When it is supplied the validated fresh
      tree is published there atomically by `Publish-DshUiBuildTree` (previous tree
      retained, rollback on failure); when it is omitted the fresh tree is reported
      and retained inside the owned root. The counts returned always describe the
      tree at the returned `OutDir`, and are artifact-level, never an exit code.
    #>
    param(
        [Parameter(Mandatory)][string]$PortRoot,
        [string]$OutDir,
        [string]$OwnedRoot,
        [string]$FreshOutDir,
        [string]$PayloadNodePath,
        [string]$StagedNodeExecutable,
        [string]$NodeArchivePath,
        [string]$NodeArchiveCacheRoot,
        [switch]$AllowNodeDownload,
        [string]$ExpectedEsbuildVersion = $script:DefaultEsbuildVersion,
        [int]$MinAssets = 1,
        [int]$MinFiles = 10,
        [string]$RepoRoot,
        [int]$TimeoutSeconds = 1800
    )

    $uiDir = Join-Path $PortRoot 'ui'
    $upstream = if ($RepoRoot) { Join-Path $RepoRoot '_upstream' } else { Join-Path (Split-Path -Parent $PortRoot) '_upstream' }
    # An explicitly owned upstream checkout overrides the default, so the UI build
    # can be qualified against a checkout outside this repository.
    if ($env:DSH_UPSTREAM_ROOT) { $upstream = $env:DSH_UPSTREAM_ROOT }
    $pinPath = Join-Path $PortRoot 'installer\node-runtime.json'
    $vite = Join-Path $uiDir 'node_modules\vite\bin\vite.js'
    foreach ($required in @($vite, $pinPath)) {
        if (-not (Test-Path -LiteralPath $required)) { throw "A required UI build input is absent: $required" }
    }

    # --- 1. the owned root fence ------------------------------------------------
    if (-not $OwnedRoot) { $OwnedRoot = New-DshQualificationRoot -Prefix 'uibuild' }
    $owned = Assert-DshUiOwnedRootFence -OwnedRoot $OwnedRoot -UpstreamRoot $upstream

    # --- 2. the fresh output path, canonically contained in the owned root ------
    if (-not $FreshOutDir) { $FreshOutDir = Join-Path $owned 'fresh-dist' }
    $freshParent = Split-Path -Parent $FreshOutDir
    if (-not $freshParent) { throw "The fresh build output has no parent directory: $FreshOutDir" }
    if (-not (Test-Path -LiteralPath $freshParent -PathType Container)) {
        throw "The fresh build output's parent directory is absent: $freshParent"
    }
    $freshParentItem = Get-Item -LiteralPath $freshParent -Force
    if (($freshParentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "The fresh build output's parent directory is a reparse point: $freshParent"
    }
    $freshOut = Join-Path (Resolve-Path -LiteralPath $freshParent).Path (Split-Path -Leaf $FreshOutDir)
    if (-not (Test-DshPathContained -Path $freshOut -Root $owned)) {
        throw "The fresh build output is not canonically contained in the owned root: $freshOut (owned root $owned)"
    }
    Assert-DshNoLinkedAncestors -Path $freshOut
    # ANY existing entry is refused, not only a non-empty directory: an existing
    # EMPTY directory, a plain file or a reparse point at the leaf would be handed
    # to `--emptyOutDir`, which is exactly the unsafe case this guard exists for.
    $existingOut = Get-Item -LiteralPath $freshOut -Force -ErrorAction SilentlyContinue
    if ($null -ne $existingOut) {
        $kind = if ($existingOut.PSIsContainer) { 'directory' } else { 'file' }
        $link = if (($existingOut.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { ' (reparse point)' } else { '' }
        throw "refusing to build into a non-fresh output root: $freshOut (an existing $kind$link is present)"
    }

    # --- 3. the final output path (validated here, published in step 6) --------
    $target = $null
    if ($OutDir) {
        $targetParent = Split-Path -Parent $OutDir
        if (-not $targetParent) { throw "The UI output path has no parent directory: $OutDir" }
        if (-not (Test-Path -LiteralPath $targetParent -PathType Container)) { throw "The UI output parent directory is absent: $targetParent" }
        # Only the parent ENTRY is checked, not its ancestors: the caller's own tree
        # legitimately has redirected (reparse-point) ancestors on a OneDrive
        # profile, and no build ever runs at the publication target. See
        # Publish-DshUiBuildTree for the full reasoning.
        $targetParentItem = Get-Item -LiteralPath $targetParent -Force -ErrorAction Stop
        if (($targetParentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "The UI output parent directory is a reparse point: $targetParent"
        }
        $target = Join-Path (Resolve-Path -LiteralPath $targetParent).Path (Split-Path -Leaf $OutDir)
        if ([string]::Equals($target, $freshOut, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing an ambiguous build: the publication target and the fresh output root are the same path: $target"
        }
    }

    # --- 4. the trusted compiler and interpreter -------------------------------
    $esbuild = Resolve-DshTrustedEsbuild -UpstreamRoot $upstream -ExpectedVersion $ExpectedEsbuildVersion -RequestedRoot $owned
    $node = Resolve-DshQualifiedUiNode -PortRoot $PortRoot -OwnedRoot $owned -PayloadNodePath $PayloadNodePath `
        -StagedNodeExecutable $StagedNodeExecutable -NodeArchivePath $NodeArchivePath `
        -NodeArchiveCacheRoot $NodeArchiveCacheRoot -AllowNodeDownload:$AllowNodeDownload

    # --- 5. the real production build, into the fresh owned path ONLY ----------
    $null = New-Item -ItemType Directory -Path $freshOut -ErrorAction Stop
    $environment = @{
        ESBUILD_BINARY_PATH = $esbuild.Path
        TEMP = $esbuild.Temp
        TMP = $esbuild.Temp
        TMPDIR = $esbuild.Temp
        PATH = (Split-Path -Parent $node.Path) + [IO.Path]::PathSeparator + $env:PATH
    }
    $arguments = @($vite, 'build', '--config', 'shell/vite.config.ts', '--outDir', $freshOut, '--emptyOutDir')
    Write-Host "UI_BUILD_COMMAND=$($node.Path) $($arguments -join ' ')"
    $run = Invoke-DshOwnedChild -FilePath $node.Path -Arguments $arguments -WorkingDirectory $uiDir `
        -Environment $environment -TimeoutSeconds $TimeoutSeconds
    if (-not $run.ChildTokenKnown) { throw "REFUSED_UNKNOWN_VISIBILITY: the Vite child token could not be read ($($run.ChildTokenReason))." }
    if ($run.ExitCode -ne 0) {
        throw "The UI production build failed with exit $($run.ExitCode). stderr tail: $($run.StandardError.Substring(0, [Math]::Min(600, $run.StandardError.Length)))"
    }
    $freshArtifacts = Assert-DshUiBuildArtifacts -OutDir $freshOut -MinAssets $MinAssets -MinFiles $MinFiles

    # --- 6. publish, or report the retained fresh tree -------------------------
    $publication = $null
    if ($target) {
        $publication = Publish-DshUiBuildTree -FreshPath $freshOut -PublishedPath $target -MinAssets $MinAssets -MinFiles $MinFiles
        $artifacts = [pscustomobject]@{
            OutDir = $publication.PublishedPath
            Files = $publication.Files
            Assets = $publication.Assets
            Bytes = $publication.Bytes
            IndexHtml = $publication.IndexHtml
            PolicyBootstrap = $publication.PolicyBootstrap
        }
    } else {
        $artifacts = $freshArtifacts
    }

    return [pscustomobject]@{
        NodePath = $node.Path
        NodeVersion = $node.Version
        NodeSha256 = $node.Sha256
        NodeSource = $node.Source
        EsbuildPath = $esbuild.Path
        EsbuildVersion = $esbuild.Version
        EsbuildSha256 = $esbuild.Sha256
        EsbuildChildToken = $esbuild.ChildToken
        ViteChildToken = $run.ChildTokenLevel
        OwnedRoot = $owned
        FreshOutDir = $freshOut
        OutDir = $artifacts.OutDir
        Published = [bool]$target
        PreviousPath = if ($publication) { $publication.PreviousPath } else { $null }
        RetainedBackups = if ($publication) { @($publication.RetainedBackups) } else { @() }
        TempDir = $esbuild.Temp
        Files = $artifacts.Files
        Assets = $artifacts.Assets
        Bytes = $artifacts.Bytes
        IndexHtml = $artifacts.IndexHtml
        PolicyBootstrap = $artifacts.PolicyBootstrap
    }
}

Export-ModuleMember -Function Get-DshLockedEsbuildBinary, Resolve-DshTrustedEsbuild,
    Get-DshUpstreamEsbuildVersion, Test-DshEsbuildVersionSatisfies,
    Assert-DshUiBuildArtifacts, Publish-DshUiBuildTree, Resolve-DshQualifiedUiNode,
    Invoke-DshQualifiedNodeScript, Invoke-DshQualifiedUiBuild
