# Atomic directory publication with crash recovery.
#
# Why this exists (findings F-41 and F-46): `Stage-Runtime` used to
# `Remove-Item port\runtime-payload\dsh -Recurse -Force` and then rebuild it in
# place. Two things followed from that:
#
#   * While the removal/rebuild was running the published path did not exist.
#     Tauri's build script validates every `bundle.resources` source at
#     build-script time, so every concurrent `cargo test` / `cargo clippy` /
#     `cargo build` failed with `resource path ../../runtime-payload/dsh doesn't
#     exist` - a failure that names a resource path, not the real cause.
#   * A failure, interruption or lock (F-46: a running app holds `koffi.node`
#     open) left the published root partially populated or absent with no
#     previous good copy to fall back to.
#
# The rule implemented here: never mutate a published root in place. A new tree
# is materialised beside it, validated in full, and only then swapped in with a
# single directory rename, keeping the previous tree under a sibling
# `.previous` name until the caller explicitly commits or rolls back. The
# published path is therefore always either the complete old tree or the
# complete new tree, never a half-written one.

Set-StrictMode -Version Latest

# Resolve (and create) a scratch root on the SAME volume as the published path.
# The swap is a directory rename; a rename across volumes is a copy and loses
# atomicity, so the staging root must be a sibling of the target rather than a
# system temp directory.
function New-DshStageRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$PublishedPath,
        [Parameter(Mandatory)][string]$Name
    )

    $parent = Split-Path -Parent $PublishedPath
    if (-not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    $stage = Join-Path $parent $Name
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    $null = New-Item -ItemType Directory -Force -Path $stage
    return $stage
}

function Test-DshReparsePoint {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    # Get-Item -Force so a hidden junction is still reported. `-Attributes` in a
    # bitwise test needs a real filesystem entry, not a resolved path: Test-Path
    # follows links, which is exactly the false-green that hid F-15/F-20.
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $false }
    return [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

# Inventory a staged tree. Returns counts and the longest path, because Windows
# `makensis` and Tauri's resource copy both fail on the Win32 MAX_PATH limit
# (finding F-14) and the limit has to be checked before publication, not after.
function Get-DshTreeFact {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [int]$MaxPathLength = 260
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Cannot inventory a missing tree: $Path"
    }

    $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction Stop)
    $reparse = @(Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction Stop |
        Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint })
    $directories = @(Get-ChildItem -LiteralPath $Path -Recurse -Directory -Force -ErrorAction Stop)

    $deepest = 0
    $deepestPath = $Path
    foreach ($entry in @($files) + @($directories)) {
        if ($entry.FullName.Length -gt $deepest) {
            $deepest = $entry.FullName.Length
            $deepestPath = $entry.FullName
        }
    }

    return [pscustomobject]@{
        Path              = $Path
        FileCount         = $files.Count
        DirectoryCount    = $directories.Count
        ReparsePointCount = $reparse.Count
        ReparsePoints     = @($reparse | ForEach-Object { $_.FullName })
        DeepestPathLength = $deepest
        DeepestPath       = $deepestPath
        ExceedsPathLimit  = ($deepest -ge $MaxPathLength)
    }
}

# Validate a staged tree before it becomes the published tree.
#
# `Required` names package.json anchors that must exist. `RequiredDirectories`
# names entries that must be real directories rather than reparse points - the
# F-20 correction: `Test-Path` follows a junction and therefore cannot prove the
# bundle will carry the content.
#
# REPARSE-POINT SCOPE. A reparse point is only a defect where it would make the
# shipped tree carry a link instead of content, i.e. under a path this function
# was asked to guarantee. A whole-tree scan is wrong for two measured reasons:
#
#   * the staging root legitimately contains `packed/` and `work/` scaffolding
#     that the build does not control entry-by-entry;
#   * a build whose payload is correct must not fail because of a link the
#     installer will never copy.
#
# So the hard failure is confined to `-RequiredDirectories` (and the parents of
# `-Required`), and any link found elsewhere is reported as a WARNING through
# `-WarningVariable`-style output rather than aborting an otherwise-correct build.
# `-StrictReparsePoints` restores the old whole-tree behaviour for callers that
# genuinely own the entire tree.
#
# WHY THE ANCESTOR WALK STOPS AT `-Path` (measured defect, P3).
#
# The first version of this scoping walked the parents of every `-Required` path
# to the DRIVE ROOT and then normalized each scope with `TrimEnd('\', '/')`.
# That normalization turns `C:\` into `C:`, and the match test is
# `$candidate.StartsWith("$_\")`, so the scope `C:` matches `C:\...anything`.
# The scope set therefore degenerated to "everything on the volume" and an
# unrelated junction anywhere under the staging root was still fatal:
#
#   required: stageRoot\node-identity.json, stageRoot\stage-runtime.mjs
#   scope C: matched C:\...\dsh.staging\work\unrelated-junction
#   -> reparsePoints: 1 (first: ...\dsh.staging\work\unrelated-junction)
#
# measured, before the fix, against the real module and the exact arguments
# `build.ps1:334-336` passes.
#
# The walk is still needed for the property it exists for, but that property is
# "a DIRECTORY BETWEEN the tree root and a required entry must not be a link",
# because such a link makes the required entry itself a link by inheritance.
# Every such directory is `Join-Path $Path <relative>` with a non-empty relative
# part, i.e. strictly inside `$Path` and strictly below it. The stops below keep
# the walk inside `$Path`:
#
#   * the walk begins at the required path's parent, never above it;
#   * it stops BEFORE emitting the tree root, so `$Path` is never a scope and no
#     ancestor of `$Path` can be either;
#   * it stops on any entry that stops making progress (a bare `C:`-style root
#     has no parent), which also covers a relative or non-absolute `-Path`.
#
# The tree root must not be a scope: a scope matches everything strictly below
# it, so `$Path` as a scope would mark every reparse point in the tree as
# required. That is the same whole-tree hard failure this scoping exists to
# prevent, reached by a second route - `T\work\unrelated-junction` is below the
# tree root. Measured: emitting the root made the exact `build.ps1:334-336` call
# throw `reparsePoints: 1 (first: ...\dsh.staging\work\unrelated-junction)`.
function Assert-DshStagedTree {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [string[]]$Required = @(),
        [string[]]$RequiredDirectories = @(),
        [string[]]$ExpectedTopLevel = @(),
        [int]$MaxPathLength = 260,
        [int]$MinimumFiles = 0,
        [switch]$StrictReparsePoints
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Staged tree is absent: $Path"
    }

    $missing = @()
    foreach ($relative in $Required) {
        $candidate = Join-Path $Path $relative
        # `Test-Path -PathType Leaf` FOLLOWS a link, so a required file reachable
        # only through a junction reports as present when the bundle would in fact
        # carry a link. Check the entry itself first, then every ancestor, so a
        # required file under a linked directory is rejected as linked rather than
        # accepted as a real file.
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            $missing += $relative
            continue
        }
        $linkedAncestor = @()
        $walk = $relative
        while ($walk -and $walk -ne '.') {
            if (Test-DshReparsePoint -Path (Join-Path $Path $walk)) { $linkedAncestor += $walk }
            $parent = Split-Path -Parent $walk
            if ($parent -eq $walk) { break }
            $walk = $parent
        }
        if ($linkedAncestor.Count -gt 0) {
            $missing += "$relative (reached through reparse point: $($linkedAncestor -join ', '))"
        }
    }

    foreach ($relative in $RequiredDirectories) {
        $candidate = Join-Path $Path $relative
        if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
            $missing += "$relative (not a directory)"
        } elseif (Test-DshReparsePoint -Path $candidate) {
            $missing += "$relative (reparse point, not a materialized directory)"
        }
    }

    $unexpected = @()
    if ($ExpectedTopLevel.Count -gt 0) {
        $unexpected = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue |
            Where-Object { $ExpectedTopLevel -notcontains $_.Name } |
            ForEach-Object { $_.Name })
    }

    $fact = Get-DshTreeFact -Path $Path -MaxPathLength $MaxPathLength

    # A link is fatal only where the caller asked for a guarantee. Every link is
    # still *reported*, so a caller can see it without the build being aborted by
    # a tree it does not own. A link counts as required when it is one of the
    # required entries, lies under a required directory, or is an ANCESTOR of a
    # required file (a required file reached through a junction is not a real
    # file, which is the F-20 property).
    $requiredReparse = @()
    if ($StrictReparsePoints) {
        $requiredReparse = @($fact.ReparsePoints)
    } else {
        # The tree root, normalized once, is the walk's stopping point. Resolving
        # it (when it exists) rather than trimming the caller's string keeps the
        # comparison meaningful for a path with a trailing separator or a `.`
        # segment; the raw value is the fallback so a non-existent tree still
        # produces a usable scope instead of throwing here.
        $treeRoot = $Path
        try {
            $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
            if ($resolved) { $treeRoot = $resolved }
        } catch {
            $treeRoot = $Path
        }
        $treeRoot = $treeRoot.TrimEnd('\', '/')

        # Ancestors of a required file, confined to the tree, and EXCLUDING the
        # tree root itself.
        #
        # The root must not become a scope. A scope matches everything strictly
        # below it, so `$Path` as a scope would mark every reparse point anywhere
        # in the tree as required - which is exactly the whole-tree hard failure
        # this scoping exists to avoid, only reached by a different route (the
        # first version reached it through the drive root, this would reach it
        # through the tree root). Only the DIRECTORIES BETWEEN the root and a
        # required entry are scopes: for `-Path T -Required d\f.txt` that is `T\d`,
        # which is the real property - an intermediate directory that is a link
        # makes the required file a link by inheritance, while a link in a sibling
        # subtree (`T\work\...`) does not.
        #
        # `Split-Path -Parent` on a drive root returns the root itself, so the
        # progress test (`$parent -eq $walk`) is what terminates the walk.
        $requiredAncestors = @($Required | ForEach-Object {
            $walk = Split-Path -Parent (Join-Path $Path $_)
            while ($walk) {
                $normalized = $walk.TrimEnd('\', '/')
                if (-not $normalized) { break }
                # Reached the tree root: it is NOT a scope and the walk is done.
                if ([string]::Equals($normalized, $treeRoot, [System.StringComparison]::OrdinalIgnoreCase)) { break }
                $normalized
                $parent = Split-Path -Parent $walk
                if ($parent -eq $walk -or -not $parent) { break }
                $walk = $parent
            }
        })

        $scopes = @($RequiredDirectories | ForEach-Object { Join-Path $Path $_ }) +
            @($Required | ForEach-Object { Join-Path $Path $_ }) +
            $requiredAncestors
        $scopes = @($scopes | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\', '/') } |
            Where-Object { $_ -and -not [string]::Equals($_, [System.IO.Path]::GetPathRoot($_), [System.StringComparison]::OrdinalIgnoreCase) } |
            Sort-Object -Unique)
        # A scope matches a candidate when the candidate IS the scope or lies
        # strictly BELOW it. The `StartsWith("<scope>\")` form is a PREFIX test, so
        # a scope that is itself a filesystem root ("C:") would match every path on
        # the volume. The scope filter above removes drive roots, and the
        # `IsPrefixScope` check below is the second, independent line of defence:
        # a scope with no separator in it is not a directory path and is refused
        # as a match rather than silently widening the required set to the volume.
        $requiredReparse = @($fact.ReparsePoints | Where-Object {
            $candidate = $_
            @($scopes | Where-Object {
                $scope = $_
                # "C:" has no separator and is not a directory scope.
                if ($scope.IndexOfAny([char[]]@('\', '/')) -lt 0) { return $false }
                $candidate.Equals($scope, [System.StringComparison]::OrdinalIgnoreCase) -or
                $candidate.StartsWith("$scope\", [System.StringComparison]::OrdinalIgnoreCase)
            }).Count -gt 0
        })
    }
    $unscopedReparse = @($fact.ReparsePoints | Where-Object { $requiredReparse -notcontains $_ })

    if ($unscopedReparse.Count -gt 0) {
        Write-Warning "Staged tree at $Path contains $($unscopedReparse.Count) reparse point(s) outside the required paths (first: $($unscopedReparse[0])). They are not covered by -RequiredDirectories and are not treated as a failure."
    }

    $problems = @()
    if ($missing.Count -gt 0) { $problems += "missingOrLinked: $($missing -join ', ')" }
    if ($unexpected.Count -gt 0) {
        $problems += "unexpectedTopLevel: $($unexpected -join ', ') (expected only: $($ExpectedTopLevel -join ', '))"
    }
    if ($requiredReparse.Count -gt 0) {
        $problems += "reparsePoints: $($requiredReparse.Count) (first: $($requiredReparse[0]))"
    }
    if ($fact.ExceedsPathLimit) {
        $problems += "deepestPath $($fact.DeepestPathLength) >= $MaxPathLength chars: $($fact.DeepestPath)"
    }
    if ($fact.FileCount -lt $MinimumFiles) {
        $problems += "fileCount $($fact.FileCount) < required $MinimumFiles"
    }

    if ($problems.Count -gt 0) {
        throw "Staged tree failed validation before publication ($Path): $($problems -join '; ')"
    }

    return $fact
}

# Publish a validated staged tree at `PublishedPath`.
#
# Sequence, all renames on one volume:
#   1. rename the current published tree to `<name>.previous` (only if present)
#   2. rename the staged tree to the published name
#
# A failure between 1 and 2 is recoverable: `Restore-DshPublishedTree` renames
# `.previous` back. The caller commits with `Complete-DshPublishedTree`, which
# deletes `.previous`; until then the previous tree is intact on disk, so a
# crash never destroys the last known-good payload.
#
# `-AllowInPlaceRemoval` exists only for the one case a rename cannot handle: a
# published path that is NOT on the same volume as the staging root. Callers
# must pass it explicitly and the operation is logged as non-atomic.
function Publish-DshStagedTree {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StagedPath,
        [Parameter(Mandatory)][string]$PublishedPath,
        [switch]$AllowInPlaceRemoval
    )

    if (-not (Test-Path -LiteralPath $StagedPath)) {
        throw "Nothing to publish: staged path $StagedPath does not exist."
    }

    $parent = Split-Path -Parent $PublishedPath
    if (-not (Test-Path -LiteralPath $parent)) {
        $null = New-Item -ItemType Directory -Force -Path $parent
    }

    $stagedRoot = [System.IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $StagedPath).Path)
    $parentRoot = [System.IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $parent).Path)
    if ($stagedRoot -ne $parentRoot -and -not $AllowInPlaceRemoval) {
        throw "Staged path $StagedPath and published path $PublishedPath are on different volumes; a directory rename cannot be atomic. Stage as a sibling of the published path, or pass -AllowInPlaceRemoval to accept a non-atomic copy."
    }

    $previous = "$PublishedPath.previous"
    $hadPrevious = Test-Path -LiteralPath $PublishedPath

    if ($hadPrevious) {
        if (Test-Path -LiteralPath $previous) {
            Remove-Item -LiteralPath $previous -Recurse -Force
        }
        Rename-Item -LiteralPath $PublishedPath -NewName (Split-Path -Leaf $previous) -ErrorAction Stop
    }

    try {
        # Rename-Item only renames WITHIN the entry's own parent, so the staged
        # tree must already sit beside the published path for this to land on
        # PublishedPath. The build stages a sibling of the published path, and the
        # guard below keeps that a requirement rather than an assumption - a staged
        # tree in some other directory would be renamed in place and silently
        # publish nothing.
        $stagedParent = Split-Path -Parent $StagedPath
        if ($stagedParent -ne $parent) {
            throw "Staged path $StagedPath is not a sibling of $PublishedPath (its parent is $stagedParent). A directory rename cannot cross directories atomically; stage beside the published path."
        }
        $stagedLeaf = Split-Path -Leaf $StagedPath
        $leaf = Split-Path -Leaf $PublishedPath
        if ($stagedLeaf -eq $leaf) {
            # Already has the published name: the rename below would be a no-op and
            # a following Move-Item would target the path onto itself ("Source and
            # destination path must be different"). The tree is already in place.
            if ($StagedPath -ne $PublishedPath) {
                throw "Staged path $StagedPath and published path $PublishedPath are different entries with the same name; refusing an ambiguous swap."
            }
        } else {
            Rename-Item -LiteralPath $StagedPath -NewName $leaf -ErrorAction Stop
        }
        if (-not (Test-Path -LiteralPath $PublishedPath)) {
            throw "The rename completed but $PublishedPath does not exist; the swap did not land on the published path."
        }
    } catch {
        if ($hadPrevious -and -not (Test-Path -LiteralPath $PublishedPath) -and (Test-Path -LiteralPath $previous)) {
            Rename-Item -LiteralPath $previous -NewName (Split-Path -Leaf $PublishedPath) -ErrorAction SilentlyContinue
        }
        throw "Publication of $PublishedPath failed and the previous tree was restored: $($_.Exception.Message)"
    }

    return [pscustomobject]@{
        PublishedPath  = $PublishedPath
        PreviousPath   = if ($hadPrevious) { $previous } else { $null }
        HadPrevious    = $hadPrevious
    }
}

# Drop the retained previous tree. This is the point of no return.
function Complete-DshPublishedTree {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$PublishedPath)

    $previous = "$PublishedPath.previous"
    if (Test-Path -LiteralPath $previous) {
        # /REBOOTOK semantics are NSIS's; here a locked file (F-46) is a hard
        # failure the caller must see rather than a silent partial delete.
        Remove-Item -LiteralPath $previous -Recurse -Force -ErrorAction Stop
    }
}

# Undo a publication that has not been committed yet.
function Restore-DshPublishedTree {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$PublishedPath)

    $previous = "$PublishedPath.previous"
    if (-not (Test-Path -LiteralPath $previous)) { return $false }
    if (Test-Path -LiteralPath $PublishedPath) {
        Remove-Item -LiteralPath $PublishedPath -Recurse -Force -ErrorAction Stop
    }
    Rename-Item -LiteralPath $previous -NewName (Split-Path -Leaf $PublishedPath) -ErrorAction Stop
    return $true
}

# Resolve an interrupted publication left behind by a crashed build.
#
# If `.previous` exists next to a published path, a build died between the two
# renames. The published tree may be absent (crash between rename 1 and 2) or
# complete (crash after rename 2 but before commit). Either way the previous
# tree is the last known-good payload, so it is restored unless the published
# tree already validates.
function Repair-DshInterruptedPublication {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$PublishedPath,
        [string[]]$Required = @()
    )

    $previous = "$PublishedPath.previous"
    if (-not (Test-Path -LiteralPath $previous)) {
        return [pscustomobject]@{ Action = 'none'; Detail = 'no interrupted publication' }
    }

    if (Test-Path -LiteralPath $PublishedPath) {
        $complete = $true
        foreach ($relative in $Required) {
            if (-not (Test-Path -LiteralPath (Join-Path $PublishedPath $relative) -PathType Leaf)) {
                $complete = $false
                break
            }
        }
        if ($complete) {
            Complete-DshPublishedTree -PublishedPath $PublishedPath
            return [pscustomobject]@{ Action = 'committed'; Detail = 'published tree was complete; removed the retained previous tree' }
        }
        Remove-Item -LiteralPath $PublishedPath -Recurse -Force
    }

    Rename-Item -LiteralPath $previous -NewName (Split-Path -Leaf $PublishedPath) -ErrorAction Stop
    return [pscustomobject]@{ Action = 'restored'; Detail = "restored $PublishedPath from its retained previous tree" }
}

Export-ModuleMember -Function @(
    'New-DshStageRoot'
    'Test-DshReparsePoint'
    'Get-DshTreeFact'
    'Assert-DshStagedTree'
    'Publish-DshStagedTree'
    'Complete-DshPublishedTree'
    'Restore-DshPublishedTree'
    'Repair-DshInterruptedPublication'
)
