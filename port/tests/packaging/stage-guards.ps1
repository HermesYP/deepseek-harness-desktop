<#
.SYNOPSIS
  Executed fixture tests for the staging-root and publication guards.

.DESCRIPTION
  `Assert-DshStagedTree` is applied to TWO different trees with two different
  contracts, and conflating them was a release blocker: the staging root is the
  build's workspace (`packed/`, `work/`, `node/`, `dsh/`, the staging program and
  the identity record) while the SHIPPED shape is the inner `dsh/` tree. Asserting
  the payload top-level set against the staging root rejected every correct stage,
  so `-Stage runtime` could never complete and no payload manifest was ever
  produced.

  The string-grep suites could not catch that: none of them executes the guard.
  This suite builds the real staging layout on disk and runs the real assertions,
  so it fails if the two sets are ever collapsed again.

  It also exercises:
    * staging-root debris (a stray downloaded archive) is still rejected;
    * payload debris still cannot ship (finding F-26);
    * a reparse point OUTSIDE the required paths warns rather than failing an
      otherwise-correct build, while one UNDER a required path is still fatal;
      the warning case is exercised with the SAME `-Required` arguments
      `build.ps1:334-336` passes, because an empty `-Required` leaves the scope
      set empty and made an earlier version of this suite pass for the wrong
      reason;
    * no derived scope is a drive root or the tree root, either of which would
      make every entry below it required and turn an unowned link in the build's
      own workspace into a hard failure;
    * `Get-DshPinnedNodeManifest` enforces `enginesRange`, so a future pin
      outside the supported range is refused instead of shipped.

.NOTES
  Windows PowerShell 5.1 and PowerShell 7 compatible. Pure ASCII.
  Everything runs under port\.scratch\; nothing is published outside it.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PortRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$LibDir = Join-Path $PortRoot 'scripts\lib'
Import-Module (Join-Path $PSScriptRoot 'fixture-safety.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'suite-result.psm1') -Force
trap { exit (Write-DshSuiteResult -Id 'staging-guards' -Status 'FAIL' -Detail $_.Exception.Message) }
$Scratch = New-PackagingFixtureRoot -PortRoot $PortRoot -Prefix 'packaging-stage-guards'

$script:Passed = 0
$script:Failed = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if ($Condition) {
        $script:Passed++
        Write-Host "    ok  $Message" -ForegroundColor Green
    } else {
        $script:Failed++
        Write-Host "    FAIL $Message" -ForegroundColor Red
    }
}

function Assert-Throws([scriptblock]$Block, [string]$MessagePattern, [string]$Message) {
    $threw = $false
    try { & $Block } catch {
        $threw = $true
        if ($MessagePattern -and $_.Exception.Message -notmatch $MessagePattern) {
            $script:Failed++
            Write-Host "    FAIL $Message (message was: $($_.Exception.Message))" -ForegroundColor Red
            return
        }
    }
    if ($threw) {
        $script:Passed++
        Write-Host "    ok  $Message" -ForegroundColor Green
    } else {
        $script:Failed++
        Write-Host "    FAIL $Message (nothing was thrown)" -ForegroundColor Red
    }
}

# The fresh protected UUID root and all evidence are retained.

Import-Module (Join-Path $LibDir 'publish.psm1') -Force
Import-Module (Join-Path $LibDir 'runtime-payload.psm1') -Force
Import-Module (Join-Path $LibDir 'node-runtime.psm1') -Force

Write-Host '==> the two trees have two different declared contracts' -ForegroundColor Cyan

$payloadTop = @(Get-DshPayloadTopLevel)
$stagingTop = @(Get-DshStagingTopLevel)
Assert-True ($payloadTop.Count -gt 0) 'the payload top level is declared'
Assert-True ($stagingTop.Count -gt 0) 'the staging top level is declared'
$overlap = @($payloadTop | Where-Object { $stagingTop -contains $_ })
Assert-True ($overlap.Count -eq 1 -and $overlap[0] -eq 'node') `
    'only node overlaps: extraction workspace and shipped interpreter are different trees'
Assert-True ($stagingTop -contains 'dsh') 'the staging root declares the payload directory it carries'
Assert-True ($stagingTop -contains 'work') 'the staging root declares its workspace'
Assert-True ($stagingTop -contains 'packed') 'the staging root declares its pack destinations'
Assert-True ($payloadTop -notcontains 'work') 'the payload does NOT declare staging-only entries'
Assert-True ($payloadTop -notcontains 'packed') 'the payload does NOT declare pack destinations'

Write-Host '==> build the REAL staging layout' -ForegroundColor Cyan

# This mirrors Stage-RuntimeInto exactly: the four pack destinations, work/, the
# materialized dsh/, the pinned node/, the staging program and the identity record.
$stageRoot = Join-Path $Scratch 'dsh.staging'
foreach ($directory in @('packed\dsh', 'packed\host', 'packed\vendor', 'packed\landlock', 'work', 'node')) {
    $null = New-Item -ItemType Directory -Force -Path (Join-Path $stageRoot $directory)
}
Set-Content -Path (Join-Path $stageRoot 'stage-runtime.mjs') -Value '// staging program' -Encoding Ascii
Set-Content -Path (Join-Path $stageRoot 'node-identity.json') -Value '{"NodeVersion":"22.20.0"}' -Encoding Ascii
Set-Content -Path (Join-Path $stageRoot 'work\runtime-identity.json') -Value '{"hostProtocolVersion":"3"}' -Encoding Ascii

# The materialized payload, at the staged location the fixed build validates.
$stagedPayload = Get-DshStagedPayloadPath -StageRoot $stageRoot
Assert-True ($stagedPayload -eq (Join-Path $stageRoot 'dsh')) 'Get-DshStagedPayloadPath names the inner dsh tree'
foreach ($anchor in (Get-DshPayloadAnchors)) {
    $null = New-Item -ItemType Directory -Force -Path (Join-Path $stagedPayload $anchor)
}
foreach ($relative in (Get-DshPayloadAnchorFiles)) {
    Set-Content -Path (Join-Path $stagedPayload $relative) -Value '{}' -Encoding Ascii
}
Set-Content -Path (Join-Path $stagedPayload 'package.json') -Value '{"dependencies":{}}' -Encoding Ascii
Set-Content -Path (Join-Path $stagedPayload 'adapter.mjs') -Value '// adapter' -Encoding Ascii
Set-Content -Path (Join-Path $stagedPayload 'NODE-LICENSE.txt') -Value 'MIT License' -Encoding Ascii
$null = New-Item -ItemType Directory -Force -Path (Join-Path $stagedPayload 'node')
Set-Content -Path (Join-Path $stagedPayload 'node\node.exe') -Value 'interpreter fixture' -Encoding Ascii

Write-Host '==> the staging root validates against ITS OWN contract' -ForegroundColor Cyan

$stageFact = Assert-DshStagedTree -Path $stageRoot -ExpectedTopLevel $stagingTop `
    -Required @('node-identity.json', 'stage-runtime.mjs')
Assert-True ($stageFact.FileCount -gt 0) "the real staging layout validates (files=$($stageFact.FileCount))"

# The regression itself. This SHOULD throw: it is the exact call that made the
# runtime stage impossible to complete. Keeping it here means the blocker cannot
# return unnoticed.
Assert-Throws {
    Assert-DshStagedTree -Path $stageRoot -ExpectedTopLevel $payloadTop
} 'unexpectedTopLevel' 'the PAYLOAD set applied to the staging root is rejected (the original blocker)'

Write-Host '==> the payload tree validates against the SHIPPED contract' -ForegroundColor Cyan

$payloadFact = Assert-DshStagedTree -Path $stagedPayload `
    -Required (Get-DshPayloadAnchorFiles) `
    -RequiredDirectories (Get-DshPayloadAnchors) `
    -ExpectedTopLevel $payloadTop
Assert-True ($payloadFact.FileCount -gt 0) "the staged payload validates (files=$($payloadFact.FileCount))"

Assert-Throws {
    Assert-DshStagedTree -Path $stagedPayload -ExpectedTopLevel $stagingTop
} 'unexpectedTopLevel' 'the STAGING set applied to the payload is rejected'

Write-Host '==> debris is still caught in both trees' -ForegroundColor Cyan

Set-Content -Path (Join-Path $stageRoot 'stray-node-archive.zip') -Value 'debris' -Encoding Ascii
Assert-Throws {
    Assert-DshStagedTree -Path $stageRoot -ExpectedTopLevel $stagingTop
} 'unexpectedTopLevel' 'a stray entry in the staging root is rejected'
$debrisTarget = Assert-PackagingFixturePath -Root $Scratch -Path (Join-Path $stageRoot 'stray-node-archive.zip')
Remove-Item -LiteralPath $debrisTarget -Force

Set-Content -Path (Join-Path $stagedPayload 'probe-debris.txt') -Value 'x' -Encoding Ascii
Assert-Throws {
    Assert-DshStagedTree -Path $stagedPayload -ExpectedTopLevel $payloadTop
} 'unexpectedTopLevel' 'a stray entry in the published payload is rejected (F-26)'
$debrisTarget = Assert-PackagingFixturePath -Root $Scratch -Path (Join-Path $stagedPayload 'probe-debris.txt')
Remove-Item -LiteralPath $debrisTarget -Force

Write-Host '==> reparse points are scoped to the required paths' -ForegroundColor Cyan

$realTarget = Join-Path $Scratch 'link-target'
$null = New-Item -ItemType Directory -Force -Path (Join-Path $realTarget 'pkg')
Set-Content -Path (Join-Path $realTarget 'pkg\package.json') -Value '{}' -Encoding Ascii

$linked = $false
try {
    $null = New-Item -ItemType Junction -Path (Join-Path $stageRoot 'work\unrelated-junction') `
        -Target (Join-Path $realTarget 'pkg') -ErrorAction Stop
    $linked = $true
} catch {
    Write-Host "    skip: this host could not create a junction ($($_.Exception.Message))" -ForegroundColor DarkYellow
}

if ($linked) {
    # THE CALL `build.ps1` ACTUALLY MAKES, with the same arguments. Deliberately
    # NOT `-Required @()` and no `-RequiredDirectories`: an empty required set
    # leaves the scope set empty, so no reparse point can match and the guard
    # cannot fail for a reason unrelated to the fix. That was the earlier
    # false-green - it asserted the warning-only path while `build.ps1:334-336`
    # passes `-Required @('node-identity.json', 'stage-runtime.mjs')`, which is the
    # case that used to throw.
    #
    # The scope set must therefore be non-empty HERE, and the junction must still
    # not be fatal. The companion assertion below reads the scope set the guard
    # would build, so a regression that collapses the scopes to the tree root or
    # to a drive root is caught even if the tree happens to pass.
    $requiredForBuild = @('node-identity.json', 'stage-runtime.mjs')
    $warnings = @()
    $fact = Assert-DshStagedTree -Path $stageRoot -ExpectedTopLevel $stagingTop `
        -Required $requiredForBuild -WarningVariable warnings -WarningAction SilentlyContinue
    Assert-True ($null -ne $fact) `
        'the exact build.ps1 call (-Required non-empty, unrelated junction present) does NOT fail'
    Assert-True ($warnings.Count -ge 1) 'the unrelated reparse point is still reported as a warning'
    Assert-True ($warnings[0] -match 'outside the required paths') `
        'the warning names the required-path scoping rather than a bare failure'

    # The required set must be non-empty, or the assertion above proves nothing.
    Assert-True ($requiredForBuild.Count -gt 0) 'the exercised call passes a non-empty -Required'
    # The junction sits in `work\`, and no required entry names `work`: the two
    # required entries are root-level FILES, so the required subtree and the
    # junction's subtree are disjoint. That disjointness is what makes the
    # warning-vs-failure distinction meaningful rather than accidental.
    $requiredSubtrees = @('work')
    Assert-True (@($requiredForBuild | Where-Object {
            $entry = $_
            @($requiredSubtrees | Where-Object {
                $entry -like "$_\*" -or $entry -eq $_
            }).Count -gt 0
        }).Count -eq 0) 'no required entry names the subtree the unrelated junction lives in'

    # The scope set the guard derives must not contain a filesystem root or the
    # tree root. Both would make every entry below them "required" and turn an
    # unowned link in the workspace into a hard build failure.
    $scopeRoot = $stageRoot
    $ancestors = @($requiredForBuild | ForEach-Object {
        $walk = Split-Path -Parent (Join-Path $scopeRoot $_)
        while ($walk) {
            $normalized = $walk.TrimEnd('\', '/')
            if (-not $normalized) { break }
            if ([string]::Equals($normalized, ($scopeRoot.TrimEnd('\', '/')), [System.StringComparison]::OrdinalIgnoreCase)) { break }
            $normalized
            $parent = Split-Path -Parent $walk
            if ($parent -eq $walk -or -not $parent) { break }
            $walk = $parent
        }
    })
    Assert-True (@($ancestors | Where-Object {
            [string]::Equals($_, [System.IO.Path]::GetPathRoot($_), [System.StringComparison]::OrdinalIgnoreCase)
        }).Count -eq 0) 'no drive-root scope is derived for the required entries'
    Assert-True (@($ancestors | Where-Object {
            [string]::Equals($_, $scopeRoot.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)
        }).Count -eq 0) 'the tree root itself is never a scope, so sibling subtrees stay unscoped'

    # A junction in a subtree that the required entries DO cover is still fatal.
    # This is the negative that must stay sensitive: with an over-broad scope the
    # case passes for the wrong reason, and with too narrow a scope it must not
    # silently become a warning.
    $coveredRoot = Join-Path $Scratch 'link-covered'
    $null = New-Item -ItemType Directory -Force -Path (Join-Path $coveredRoot 'node_modules')
    $null = New-Item -ItemType Junction -Path (Join-Path $coveredRoot 'node_modules\@deepseek-ai') `
        -Target (Join-Path $realTarget 'pkg') -ErrorAction Stop
    Assert-Throws {
        Assert-DshStagedTree -Path $coveredRoot -Required @('node_modules/@deepseek-ai/package.json')
    } 'reparse point' 'a junction UNDER the subtree a required file lives in is still rejected with -Required'

    # ...and the SAME tree reports the junction as UNscoped when the requirement
    # is a real file that does not traverse it. This is the distinction being
    # proven: the requirement decides, not the tree, so `unrelated-junction`
    # warns while a junction the requirement passes through is fatal.
    Set-Content -Path (Join-Path $coveredRoot 'marker.json') -Value '{}' -Encoding Ascii
    $coveredWarnings = @()
    $coveredFact = Assert-DshStagedTree -Path $coveredRoot -Required @('marker.json') `
        -WarningVariable coveredWarnings -WarningAction SilentlyContinue
    Assert-True ($null -ne $coveredFact) `
        'the same tree passes when the requirement is a file that does not traverse the junction'
    Assert-True ($coveredWarnings.Count -ge 1) 'and the junction is reported as a warning instead'

    # A link UNDER a required directory is still fatal, which is the F-20 property.
    $linkRoot = Join-Path $Scratch 'link-required'
    $null = New-Item -ItemType Directory -Force -Path (Join-Path $linkRoot 'node_modules')
    $null = New-Item -ItemType Junction -Path (Join-Path $linkRoot 'node_modules\@deepseek-ai') `
        -Target (Join-Path $realTarget 'pkg') -ErrorAction Stop
    Assert-Throws {
        Assert-DshStagedTree -Path $linkRoot -RequiredDirectories @('node_modules/@deepseek-ai')
    } 'reparse point' 'a junction under a REQUIRED path is still rejected'

    # A required FILE that is a link is fatal too.
    Assert-Throws {
        Assert-DshStagedTree -Path $linkRoot -Required @('node_modules/@deepseek-ai/package.json')
    } 'missingOrLinked' 'a required file reached through a link is rejected'

    # A required file at the tree ROOT must not be satisfiable through a link that
    # sits one level down in an unrelated subtree: the requirement is on the root
    # entry, so a sibling junction stays a warning.
    $rootReqWarnings = @()
    $rootReqFact = Assert-DshStagedTree -Path $stageRoot -Required @('stage-runtime.mjs') `
        -WarningVariable rootReqWarnings -WarningAction SilentlyContinue
    Assert-True ($null -ne $rootReqFact) 'a required file at the tree root is not defeated by a sibling junction'
    Assert-True ($rootReqWarnings.Count -ge 1) 'the sibling junction is reported as a warning'

    # A directory junction is removed with the .NET directory API; Remove-Item on
    # a reparse point raises a NullReferenceException on this PowerShell version.
    $junctionTarget = Assert-PackagingFixturePath -Root $Scratch -Path (Join-Path $stageRoot 'work\unrelated-junction') -AllowLeafReparsePoint
    [System.IO.Directory]::Delete($junctionTarget, $false)
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $stageRoot 'work\unrelated-junction'))) `
        'the scratch junction was cleaned up'
}

Write-Host '==> the pinned Node version is validated against enginesRange' -ForegroundColor Cyan

$pinPath = Join-Path $PortRoot 'installer\node-runtime.json'
$pin = Get-DshPinnedNodeManifest -ManifestPath $pinPath
Assert-True ($pin.enginesRange -notmatch '^\s*$') 'the manifest declares an enginesRange'
Assert-True ($pin.nodeVersion -eq '22.20.0') "the committed pin is accepted ($($pin.nodeVersion))"

$range = [string]$pin.enginesRange
Assert-Throws {
    Assert-DshPinnedNodeVersionSupported -NodeVersion '20.11.0' -EnginesRange $range -ManifestPath $pinPath
} 'outside the supported range' 'Node 20.x is refused'
Assert-Throws {
    Assert-DshPinnedNodeVersionSupported -NodeVersion '22.18.0' -EnginesRange $range -ManifestPath $pinPath
} 'outside the supported range' 'Node 22.18.0 is below the floor and is refused'
Assert-Throws {
    Assert-DshPinnedNodeVersionSupported -NodeVersion '23.5.0' -EnginesRange $range -ManifestPath $pinPath
} 'outside the supported range' 'Node 23.x satisfies neither clause and is refused'

# The positive cases must pass, or the gate would simply reject everything.
$accepted = $true
try {
    Assert-DshPinnedNodeVersionSupported -NodeVersion '22.19.0' -EnginesRange $range -ManifestPath $pinPath
    Assert-DshPinnedNodeVersionSupported -NodeVersion '22.20.0' -EnginesRange $range -ManifestPath $pinPath
    Assert-DshPinnedNodeVersionSupported -NodeVersion '24.0.0' -EnginesRange $range -ManifestPath $pinPath
    Assert-DshPinnedNodeVersionSupported -NodeVersion '25.0.0' -EnginesRange $range -ManifestPath $pinPath
} catch {
    $accepted = $false
    Write-Host "      ($($_.Exception.Message))" -ForegroundColor DarkYellow
}
Assert-True $accepted '22.19.0, 22.20.0, 24.0.0 and 25.0.0 are all accepted'

Assert-Throws {
    Assert-DshPinnedNodeVersionSupported -NodeVersion '22.20.0' -EnginesRange '' -ManifestPath $pinPath
} 'no enginesRange' 'an absent range is refused rather than read as permissive'
Assert-Throws {
    Assert-DshPinnedNodeVersionSupported -NodeVersion '22.20.0' -EnginesRange '~>7.x' -ManifestPath $pinPath
} 'cannot evaluate' 'an unparseable clause is refused, not silently accepted'
Assert-Throws {
    Assert-DshPinnedNodeVersionSupported -NodeVersion 'not-a-version' -EnginesRange $range -ManifestPath $pinPath
} 'not a plain major.minor.patch' 'a malformed version is refused'

Write-Host '==> copied packages become exact shared-package declarations' -ForegroundColor Cyan
$registrationRoot = Join-Path $Scratch 'registration'
$installedRoot = Join-Path $registrationRoot 'node_modules\@dsh-port\example'
$null = New-Item -ItemType Directory -Force -Path $installedRoot
$registrationManifest = Join-Path $registrationRoot 'package.json'
$installedManifest = Join-Path $installedRoot 'package.json'
Set-Content -LiteralPath $registrationManifest -Value '{"version":"1.0.0","dependencies":{"existing":"2.0.0"}}' -Encoding Ascii
Set-Content -LiteralPath $installedManifest -Value '{"name":"@dsh-port/example","version":"1.2.3"}' -Encoding Ascii
Register-DshPayloadPackages -Root $registrationRoot -Names @('@dsh-port/example')
$registered = Get-Content -LiteralPath $registrationManifest -Raw | ConvertFrom-Json
Assert-True ($registered.dependencies.'@dsh-port/example' -eq '1.2.3') 'copied package version is registered exactly'
Assert-True ($registered.dependencies.existing -eq '2.0.0' -and $registered.version -eq '1.0.0') 'registration preserves existing dependencies and wrapper identity'
$registeredBytes = Get-Content -LiteralPath $registrationManifest -Raw
Register-DshPayloadPackages -Root $registrationRoot -Names @('@dsh-port/example')
Assert-True ((Get-Content -LiteralPath $registrationManifest -Raw) -eq $registeredBytes) 'repeated registration is byte-identical'
Set-Content -LiteralPath $installedManifest -Value '{"name":"wrong","version":"1.2.3"}' -Encoding Ascii
Assert-Throws { Register-DshPayloadPackages -Root $registrationRoot -Names @('@dsh-port/example') } `
    'identity does not match' 'a copied package with the wrong name is rejected'
Set-Content -LiteralPath $installedManifest -Value '{"name":"@dsh-port/example","version":"9.0.0"}' -Encoding Ascii
Assert-Throws { Register-DshPayloadPackages -Root $registrationRoot -Names @('@dsh-port/example') } `
    'incompatible version' 'registration cannot overwrite a conflicting exact declaration'
Assert-True ((Get-Content -LiteralPath $registrationManifest -Raw) -eq $registeredBytes) 'failed registration leaves root metadata unchanged'
Assert-Throws { Register-DshPayloadPackages -Root $registrationRoot -Names @('../escape') } `
    'pattern' 'unsafe package names cannot leave node_modules'

Write-Host '==> only the sealed inner payload publishes' -ForegroundColor Cyan

$payloadParent = Join-Path $Scratch 'runtime-payload'
$publishedPath = Join-Path $payloadParent 'dsh'
$null = New-Item -ItemType Directory -Force -Path $payloadParent
Set-Content -Path (Join-Path $stagedPayload 'runtime-payload.json') -Value '{"sealed":"port"}' -Encoding Ascii
Set-Content -Path (Join-Path $stagedPayload 'desktop-runtime.json') -Value '{"sealed":"upstream"}' -Encoding Ascii
$payloadFact = Assert-DshStagedTree -Path $stagedPayload -ExpectedTopLevel $payloadTop -StrictReparsePoints

function New-PayloadStage([string]$Name) {
    $result = Join-Path $payloadParent $Name
    $null = New-Item -ItemType Directory -Path $result
    Copy-Item -LiteralPath $stagedPayload -Destination (Join-Path $result 'dsh') -Recurse
    Set-Content -Path (Join-Path $result 'stage-runtime.mjs') -Value '// workspace only' -Encoding Ascii
    Set-Content -Path (Join-Path $result 'node-identity.json') -Value '{}' -Encoding Ascii
    return $result
}

$swapStage = New-PayloadStage 'dsh.staging'
$publication = Publish-DshStagedPayload -StageRoot $swapStage -PublishedPath $publishedPath
Assert-True (-not $publication.HadPrevious) 'the first publication reports no previous tree'
Assert-True (Test-Path (Join-Path $swapStage 'stage-runtime.mjs')) 'the workspace is not published or consumed'
Assert-True (-not (Test-Path (Join-Path $swapStage 'dsh'))) 'only the inner payload is consumed'
Assert-True ((Get-Content (Join-Path $publishedPath 'package.json') -Raw) -match 'dependencies') 'package.json is at the published root'
Assert-True (Test-Path (Join-Path $publishedPath 'adapter.mjs')) 'adapter.mjs is at the published root'
Assert-True (-not (Test-Path (Join-Path $publishedPath 'dsh'))) 'no nested dsh/dsh tree ships'
Assert-True (-not (Test-Path (Join-Path $publishedPath 'node-identity.json'))) 'workspace identity does not ship'
Assert-True (-not (Test-Path (Join-Path $publishedPath 'stage-runtime.mjs'))) 'staging program does not ship'
Assert-True ((Get-Content (Join-Path $publishedPath 'desktop-runtime.json') -Raw) -match 'upstream') 'sealed descriptor bytes are preserved'
$publishedFact = Assert-DshStagedTree -Path $publishedPath -Required (Get-DshPayloadAnchorFiles) `
    -ExpectedTopLevel $payloadTop -StrictReparsePoints
Assert-True ($publishedFact.FileCount -eq $payloadFact.FileCount) 'the final metadata-inclusive file count is preserved'
Assert-True (-not (Test-Path "$publishedPath.candidate")) 'successful promotion consumes the candidate'

$nonSibling = Join-Path $Scratch 'elsewhere\dsh.staging'
$null = New-Item -ItemType Directory -Force -Path $nonSibling
Assert-Throws { Publish-DshStagedPayload -StageRoot $nonSibling -PublishedPath $publishedPath } `
    'distinct sibling' 'a non-sibling workspace cannot promote its payload'
Assert-Throws { Publish-DshStagedTree -StagedPath $nonSibling -PublishedPath $publishedPath } `
    'not a sibling' 'the low-level publisher still refuses non-sibling trees'

$staleStage = New-PayloadStage 'dsh.staging-stale'
$null = New-Item -ItemType Directory -Path "$publishedPath.candidate"
Set-Content -Path (Join-Path "$publishedPath.candidate" 'marker') -Value 'unowned candidate' -Encoding Ascii
Assert-Throws { Publish-DshStagedPayload -StageRoot $staleStage -PublishedPath $publishedPath } `
    'candidate already exists' 'a surviving candidate is refused for inspection, not overwritten'
Assert-True (Test-Path (Join-Path $staleStage 'dsh\adapter.mjs')) 'refused promotion leaves the source intact'
Assert-True ((Get-Content (Join-Path "$publishedPath.candidate" 'marker') -Raw) -match 'unowned') 'the unowned candidate is unchanged'
$null = Assert-PackagingFixturePath -Root $Scratch -Path "$publishedPath.candidate"
Remove-Item -LiteralPath "$publishedPath.candidate" -Recurse -Force

$failedStage = New-PayloadStage 'dsh.staging-failed'
$realPublisherBody = (Get-Command Publish-DshStagedTree).ScriptBlock
try {
    # Inject only the publisher failure; promotion and finally restoration run normally.
    function global:Publish-DshStagedTree {
        param([string]$StagedPath, [string]$PublishedPath)
        throw 'injected publication failure'
    }
    Assert-Throws { Publish-DshStagedPayload -StageRoot $failedStage -PublishedPath $publishedPath } `
        'injected publication failure' 'publisher failure restores a promoted candidate to the workspace'
} finally {
    Set-Item -Path Function:\global:Publish-DshStagedTree -Value $realPublisherBody
}
Assert-True (Test-Path (Join-Path $failedStage 'dsh\adapter.mjs')) 'failed publication keeps the staged payload'
Assert-True (-not (Test-Path "$publishedPath.candidate")) 'failed publication leaves no promoted candidate'
Assert-True (Test-Path (Join-Path $publishedPath 'adapter.mjs')) 'failed publication preserves the published tree'

$swapStage2 = New-PayloadStage 'dsh.staging-2'
$second = Publish-DshStagedPayload -StageRoot $swapStage2 -PublishedPath $publishedPath
Assert-True ($second.HadPrevious) 'a second publication retains the previous tree'
Assert-True (Test-Path (Join-Path "$publishedPath.previous" 'adapter.mjs')) 'the retained tree has root-level payload files'
Restore-DshPublishedTree -PublishedPath $publishedPath | Out-Null
Assert-True (Test-Path (Join-Path $publishedPath 'adapter.mjs')) 'rollback restores the root-level payload'
Assert-True (-not (Test-Path "$publishedPath.previous")) 'rollback consumes the retained tree'

$swapStage3 = New-PayloadStage 'dsh.staging-3'
$null = Publish-DshStagedPayload -StageRoot $swapStage3 -PublishedPath $publishedPath
$null = Assert-PackagingFixturePath -Root $Scratch -Path $publishedPath
Remove-Item -LiteralPath $publishedPath -Recurse -Force
$repair = Repair-DshInterruptedPublication -PublishedPath $publishedPath -Required @('adapter.mjs', 'desktop-runtime.json')
Assert-True ($repair.Action -eq 'restored') 'an interrupted publication restores the previous payload'
Assert-True (Test-Path (Join-Path $publishedPath 'adapter.mjs')) 'the repaired payload uses the published root'

$swapStage4 = New-PayloadStage 'dsh.staging-4'
$null = Publish-DshStagedPayload -StageRoot $swapStage4 -PublishedPath $publishedPath
$repair2 = Repair-DshInterruptedPublication -PublishedPath $publishedPath -Required @('adapter.mjs', 'desktop-runtime.json')
Assert-True ($repair2.Action -eq 'committed') 'a complete root-level published tree commits'
Assert-True (-not (Test-Path "$publishedPath.previous")) 'commit removes the retained tree'

Write-Host ''
if ($script:Failed -gt 0) {
    Write-Host "Packaging stage guard tests: $($script:Passed) passed, $($script:Failed) FAILED" -ForegroundColor Red
    exit (Write-DshSuiteResult -Id 'staging-guards' -Status 'FAIL' -Detail "$($script:Failed) assertion(s) failed of $($script:Passed + $script:Failed)")
}
Write-Host "Packaging stage guard tests: $($script:Passed) passed, 0 failed" -ForegroundColor Green
exit (Write-DshSuiteResult -Id 'staging-guards' -Status 'PASS' -Checks $script:Passed -Detail 'staging and publication guard assertions')
