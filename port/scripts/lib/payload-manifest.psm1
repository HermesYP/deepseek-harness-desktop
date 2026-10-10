# Payload manifest: pins every byte the installer ships to an explicit input.
#
# Why this exists. The staged runtime payload is produced by a `pnpm install`
# against the npm registry, which means the *content* of the shipped tree is
# decided by (a) whatever the resolver picked that day and (b) any transitive
# dependency whose author republished a version. That is implicit, mutable
# dependency drift: two builds of the same commit can ship different bytes, and
# nothing in the build notices. Upstream already answers the drift question for
# the *lockfile* (`--frozen-lockfile --trust-lockfile` plus
# `verifyDesktopCoreLockfile`), but the lockfile pins versions and integrity
# hashes of tarballs - it does not pin the *files that end up in the payload*,
# and it does not cover the port's own packages or the pinned interpreter.
#
# This module records the final, materialised state as a manifest and fails a
# build whose result differs from the recorded one:
#
#   * `inputs`    - the pinned explicit inputs (interpreter digest, upstream
#                   commit, package set digest, port package file digests).
#                   These are the things a human chose.
#   * `packages`  - the resolved production dependency closure with versions.
#   * `licenseFiles` - the license texts that must travel with the payload.
#   * `files`     - shipped content digests, excluding this manifest and the
#                   final desktop-runtime.json descriptor to avoid a hash cycle.
#                   The final descriptor inventories this manifest in turn.
#
# `Compare-DshPayloadManifest` reports the difference between two manifests as
# added / removed / changed files and changed inputs, so a rebuild that drifts
# is a build failure with a named cause rather than a silent difference.

Set-StrictMode -Version Latest

function Get-DshPortPackageInputs {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string[]]$SourceDirectories,
        [Parameter(Mandatory)][string[]]$RelativeFiles
    )

    $inputs = @()
    foreach ($directory in $SourceDirectories) {
        foreach ($relative in $RelativeFiles) {
            $candidate = Join-Path $directory $relative
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                throw "Pinned port package input is missing: $candidate"
            }
            $inputs += [pscustomobject]@{
                Name   = "$([System.IO.Path]::GetFileName($directory))/$($relative -replace '\\', '/')"
                Bytes  = (Get-Item -LiteralPath $candidate).Length
                Sha256 = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
    }
    return @($inputs | Sort-Object Name)
}

# Inventory every shipped file. Slashes are normalized so a manifest produced on
# Windows compares equal to one produced on macOS for the same logical tree.
function Get-DshPayloadFileInventory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Root,
        [string[]]$Exclude = @()
    )

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        throw "Cannot inventory a missing payload root: $Root"
    }

    $rootFull = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')
    $prefixLength = $rootFull.Length + 1
    $files = @()

    # A linked entry is fatal here, and it must be detected BEFORE the file walk:
    # `Get-ChildItem -Recurse -File` does not descend a directory junction, so a
    # linked package would simply be absent from the inventory and the manifest
    # would under-report what ships. Both directories and files are scanned, and
    # the scan does not follow the links it finds.
    foreach ($entry in Get-ChildItem -LiteralPath $Root -Recurse -Force -ErrorAction Stop) {
        if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw "Payload inventory refuses a reparse point: $($entry.FullName). A linked entry cannot be proven to ship, and its contents are not walked."
        }
    }

    foreach ($entry in Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction Stop) {
        $relative = $entry.FullName.Substring($prefixLength) -replace '\\', '/'
        $excluded = $false
        foreach ($pattern in $Exclude) {
            if ($relative -like $pattern) { $excluded = $true; break }
        }
        if ($excluded) { continue }
        $files += [pscustomobject]@{
            Path   = $relative
            Bytes  = $entry.Length
            Sha256 = (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }

    return @($files | Sort-Object Path)
}

# The license texts that must accompany a redistributed payload. A missing
# license is a redistribution defect, not a warning.
function Get-DshLicenseInventory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string[]]$Required
    )

    $missing = @()
    $present = @()
    foreach ($relative in $Required) {
        $candidate = Join-Path $Root $relative
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            $missing += $relative
            continue
        }
        $present += [pscustomobject]@{
            Path   = $relative
            Bytes  = (Get-Item -LiteralPath $candidate).Length
            Sha256 = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    if ($missing.Count -gt 0) {
        throw "Payload is missing required license text(s): $($missing -join ', ')."
    }
    return @($present | Sort-Object Path)
}

function New-DshPayloadManifest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][hashtable]$Inputs,
        [Parameter(Mandatory)][string]$UpstreamCommit,
        [Parameter(Mandatory)][string]$Version,
        [string]$HostProtocolVersion,
        [string[]]$Exclude = @(),
        [string[]]$RequiredLicenses = @(),
        [Parameter(Mandatory)]$NodeIdentity
    )

    # Only root metadata files are excluded; same-named package files still ship
    # in this inventory. desktop-runtime.json seals this manifest after it is written.
    $inventory = Get-DshPayloadFileInventory -Root $Root `
        -Exclude (@('runtime-payload.json', 'desktop-runtime.json') + $Exclude)
    $licenses = if ($RequiredLicenses.Count -gt 0) {
        Get-DshLicenseInventory -Root $Root -Required $RequiredLicenses
    } else { @() }

    # The dependency closure as it actually materialised. Read from the payload
    # manifest rather than from pnpm's metadata, so the record describes what
    # shipped even if the resolver and the writer disagreed.
    $packages = @{}
    $manifestPath = Join-Path $Root 'package.json'
    if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
        $packageManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ($null -ne $packageManifest.dependencies) {
            foreach ($property in $packageManifest.dependencies.PSObject.Properties) {
                $packages[$property.Name] = [string]$property.Value
            }
        }
    } else {
        throw "Payload root $Root has no package.json; its dependency identity cannot be recorded."
    }

    $packageRecords = @()
    foreach ($name in ($packages.Keys | Sort-Object)) {
        $packageRecords += [pscustomobject]@{ Name = $name; Version = $packages[$name] }
    }

    $deepest = 0
    $rootLength = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/').Length + 1
    foreach ($file in $inventory) {
        $absolute = $rootLength + $file.Path.Length
        if ($absolute -gt $deepest) { $deepest = $absolute }
    }

    $inputRecords = @()
    foreach ($key in ($Inputs.Keys | Sort-Object)) {
        $inputRecords += [pscustomobject]@{ Name = $key; Value = [string]$Inputs[$key] }
    }

    return [pscustomobject]@{
        schemaVersion       = 1
        version             = $Version
        upstreamCommit      = $UpstreamCommit
        hostProtocolVersion = $HostProtocolVersion
        node                = [pscustomobject]@{
            version  = $NodeIdentity.NodeVersion
            target   = $NodeIdentity.Target
            url      = $NodeIdentity.Url
            sha256   = $NodeIdentity.Sha256
            source   = $NodeIdentity.Source
            license  = $NodeIdentity.License
            spdx     = $NodeIdentity.LicenseSpdx
        }
        inputs              = $inputRecords
        packages            = $packageRecords
        licenseFiles        = $licenses
        fileCount           = $inventory.Count
        totalBytes          = ($inventory | Measure-Object -Property Bytes -Sum).Sum
        deepestPathLength   = $deepest
        files               = $inventory
    }
}

function Write-DshPayloadManifest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Manifest,
        [Parameter(Mandatory)][string]$Path
    )

    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        $null = New-Item -ItemType Directory -Force -Path $parent
    }
    # Written UTF-8 without BOM: the manifest is consumed by Node in the
    # packaging tests, and a BOM would break JSON.parse.
    $json = $Manifest | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($Path, "$json`n", (New-Object System.Text.UTF8Encoding($false)))
}

function Read-DshPayloadManifest {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Payload manifest not found: $Path"
    }
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

# Compare two manifests and name every difference. This is the drift gate: the
# caller compares a freshly built payload against the checked-in record and
# fails the build when they differ, instead of shipping quietly different bytes.
function Compare-DshPayloadManifest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Expected,
        [Parameter(Mandatory)]$Actual
    )

    $differences = @()

    if ($Expected.version -ne $Actual.version) {
        $differences += "version: expected $($Expected.version), actual $($Actual.version)"
    }
    if ($Expected.upstreamCommit -ne $Actual.upstreamCommit) {
        $differences += "upstreamCommit: expected $($Expected.upstreamCommit), actual $($Actual.upstreamCommit)"
    }
    if ($Expected.node.sha256 -ne $Actual.node.sha256) {
        $differences += "node.sha256: expected $($Expected.node.sha256), actual $($Actual.node.sha256)"
    }
    if ($Expected.node.version -ne $Actual.node.version) {
        $differences += "node.version: expected $($Expected.node.version), actual $($Actual.node.version)"
    }

    $expectedInputs = @{}
    foreach ($input in $Expected.inputs) { $expectedInputs[$input.Name] = $input.Value }
    $actualInputs = @{}
    foreach ($input in $Actual.inputs) { $actualInputs[$input.Name] = $input.Value }
    foreach ($name in ($expectedInputs.Keys | Sort-Object)) {
        if (-not $actualInputs.ContainsKey($name)) {
            $differences += "input '$name' was removed"
        } elseif ($expectedInputs[$name] -ne $actualInputs[$name]) {
            $differences += "input '$name' changed"
        }
    }
    foreach ($name in ($actualInputs.Keys | Sort-Object)) {
        if (-not $expectedInputs.ContainsKey($name)) { $differences += "input '$name' was added" }
    }

    $expectedPackages = @{}
    foreach ($package in $Expected.packages) { $expectedPackages[$package.Name] = $package.Version }
    $actualPackages = @{}
    foreach ($package in $Actual.packages) { $actualPackages[$package.Name] = $package.Version }
    foreach ($name in ($expectedPackages.Keys | Sort-Object)) {
        if (-not $actualPackages.ContainsKey($name)) {
            $differences += "package '$name@$($expectedPackages[$name])' is gone"
        } elseif ($expectedPackages[$name] -ne $actualPackages[$name]) {
            $differences += "package '$name' moved $($expectedPackages[$name]) -> $($actualPackages[$name])"
        }
    }
    foreach ($name in ($actualPackages.Keys | Sort-Object)) {
        if (-not $expectedPackages.ContainsKey($name)) {
            $differences += "package '$name@$($actualPackages[$name])' was added"
        }
    }

    $expectedFiles = @{}
    foreach ($file in $Expected.files) { $expectedFiles[$file.Path] = $file.Sha256 }
    $actualFiles = @{}
    foreach ($file in $Actual.files) { $actualFiles[$file.Path] = $file.Sha256 }
    $added = @()
    $removed = @()
    $changed = @()
    foreach ($path in ($expectedFiles.Keys | Sort-Object)) {
        if (-not $actualFiles.ContainsKey($path)) { $removed += $path }
        elseif ($expectedFiles[$path] -ne $actualFiles[$path]) { $changed += $path }
    }
    foreach ($path in ($actualFiles.Keys | Sort-Object)) {
        if (-not $expectedFiles.ContainsKey($path)) { $added += $path }
    }

    $expectedLicenses = @($Expected.licenseFiles | ForEach-Object { $_.Path })
    $actualLicenses = @($Actual.licenseFiles | ForEach-Object { $_.Path })
    foreach ($path in $expectedLicenses) {
        if ($actualLicenses -notcontains $path) { $differences += "license file '$path' is gone" }
    }

    return [pscustomobject]@{
        Matches          = ($differences.Count -eq 0 -and $added.Count -eq 0 -and $removed.Count -eq 0 -and $changed.Count -eq 0)
        Differences      = $differences
        AddedFiles       = $added
        RemovedFiles     = $removed
        ChangedFiles     = $changed
        ExpectedFileCount = $Expected.fileCount
        ActualFileCount  = $Actual.fileCount
    }
}

Export-ModuleMember -Function @(
    'Get-DshPortPackageInputs'
    'Get-DshPayloadFileInventory'
    'Get-DshLicenseInventory'
    'New-DshPayloadManifest'
    'Write-DshPayloadManifest'
    'Read-DshPayloadManifest'
    'Compare-DshPayloadManifest'
)
